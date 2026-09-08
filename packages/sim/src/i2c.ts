/**
 * Controller-level I²C (plan §8).
 *
 * The bus is matched by string equality on net ids and nothing else:
 * `target.sdaNet === bus.sdaNet && target.sclNet === bus.sclNet`. Every question
 * about the design — which GPIO is SDA, which net a pin sits on, what address a
 * module answers to — is answered on the main thread by `buildSnapshot`, so the
 * worker only ever compares opaque strings. That is what makes a cut wire or a
 * swapped pair a real failure here instead of a special case.
 *
 * A transaction is atomic in virtual time: the duration is computed from the bit
 * count up front, the commit is scheduled at `now + duration`, and the target's
 * `onWrite`/`onRead` runs inside that event, immediately before the guest promise
 * resolves. Nothing about a transaction is observable while it is in flight.
 *
 * Deliberately not modelled: pull-ups, clock stretching, arbitration, per-bit
 * waveforms. The digital values on the SDA/SCL nets take no part in matching.
 */
import type { SimDiagnostic } from './types.js';
import { I2C_STATUS, type I2cStatusCode } from './runtime/guest-modules.js';
import type { I2cAck } from './contracts.js';

/** Studio's own default; the ESP32 Arduino core's real default is unverified (plan §8.3). */
export const DEFAULT_I2C_HZ = 400_000;
/** Chunk size the built-in client library writes with, so `step` keeps a usable granularity. */
export const I2C_MAX_CHUNK = 128;

/** One addressable device sitting on a net pair. */
export interface I2cTarget {
  readonly componentId: string;
  readonly sdaNet: string;
  readonly sclNet: string;
  /** Addresses this device answers to; matched exactly. */
  addresses(): readonly number[];
  powered(): boolean;
  onWrite(address: number, bytes: Uint8Array, stop: boolean): I2cAck;
  onRead(address: number, length: number): Uint8Array | null;
}

/** The pair of nets a controller has been told to talk on. */
export interface I2cBinding {
  sdaNet: string;
  sclNet: string;
  frequencyHz: number;
}

export interface I2cReadOutcome {
  status: I2cStatusCode;
  bytes: Uint8Array;
}

const busKey = (sdaNet: string, sclNet: string): string => `${sdaNet} ${sclNet}`;

/** Every device that has called `attachI2c`, indexed by the net pair it listens on. */
export class I2cRegistry {
  private readonly byBus = new Map<string, I2cTarget[]>();
  private readonly byComponent = new Map<string, I2cTarget[]>();

  register(target: I2cTarget): void {
    const key = busKey(target.sdaNet, target.sclNet);
    const list = this.byBus.get(key);
    if (list) list.push(target);
    else this.byBus.set(key, [target]);
    const owned = this.byComponent.get(target.componentId);
    if (owned) owned.push(target);
    else this.byComponent.set(target.componentId, [target]);
  }

  /** Everything listening on exactly this pair, in registration order. */
  on(sdaNet: string, sclNet: string): readonly I2cTarget[] {
    return this.byBus.get(busKey(sdaNet, sclNet)) ?? [];
  }

  /** Devices whose pair is the mirror of this one — the "you swapped SDA and SCL" case. */
  crossed(sdaNet: string, sclNet: string): readonly I2cTarget[] {
    return this.byBus.get(busKey(sclNet, sdaNet)) ?? [];
  }

  clear(): void {
    this.byBus.clear();
    this.byComponent.clear();
  }
}

/**
 * The byte-level seam kept for a future bit-bang PHY (plan §8.6). v0.2 ships only
 * `TransactionPhy`, which counts bits and stages one commit; a `BitBangPhy` would
 * drive edges on the digital net instead and neither the controller, the targets
 * nor the diagnostic codes would change.
 */
export interface I2cPhy {
  readonly mode: 'transaction' | 'bitbang';
  readonly bitCount: number;
  start(address: number, dir: 'w' | 'r'): boolean;
  repeatedStart(address: number, dir: 'w' | 'r'): boolean;
  writeByte(b: number): void;
  readByte(ack: boolean): void;
  stop(): void;
}

/** Bits on the wire, per plan §8.3. START/STOP are one bit each, every byte is 9 (8 + ACK). */
class TransactionPhy implements I2cPhy {
  readonly mode = 'transaction';
  bitCount = 0;
  private pending: number[] = [];
  private direction: 'w' | 'r' = 'w';
  private address = 0;
  private readLength = 0;
  /** Staged so the target is touched inside the scheduled commit, never during planning. */
  readonly steps: { dir: 'w' | 'r'; address: number; bytes: Uint8Array; length: number }[] = [];

  start(address: number, dir: 'w' | 'r'): boolean {
    this.bitCount += 1 + 9;
    this.address = address;
    this.direction = dir;
    return true;
  }

  repeatedStart(address: number, dir: 'w' | 'r'): boolean {
    this.flush();
    return this.start(address, dir);
  }

  writeByte(b: number): void {
    this.bitCount += 9;
    this.pending.push(b & 0xff);
  }

  /** `ack` only matters to a bit-bang PHY; the bit cost is the same either way. */
  readByte(_ack: boolean): void {
    this.bitCount += 9;
    this.readLength++;
  }

  stop(): void {
    this.flush();
    this.bitCount += 1;
  }

  private flush(): void {
    if (this.direction === 'w') this.steps.push({ dir: 'w', address: this.address, bytes: Uint8Array.from(this.pending), length: 0 });
    else this.steps.push({ dir: 'r', address: this.address, bytes: new Uint8Array(0), length: this.readLength });
    this.pending = [];
    this.readLength = 0;
  }
}

/** Bits an address-only NACK costs: START + address byte + STOP. */
export const NACK_BITS = 11;

export function durationUsFor(bits: number, frequencyHz: number): number {
  return Math.ceil((bits * 1_000_000) / Math.max(1, frequencyHz));
}

type DiagnoseOnce = (key: string, diagnostic: Omit<SimDiagnostic, 'atUs'>) => void;

export interface I2cControllerDeps {
  registry: I2cRegistry;
  /** Runs `commit` after `delayUs` of virtual time, inside a scheduler event. */
  schedule(delayUs: number, label: string, commit: () => void): void;
  diagnoseOnce: DiagnoseOnce;
  /** The component running the program, for diagnostics that are the controller's fault. */
  controllerId(): string | undefined;
}

/**
 * One controller peripheral. `bind` is what `Wire.begin()` resolved to; without it
 * every transaction is `ERR_BUS`, which is also what a guest sees when it never
 * called `begin()`.
 */
export class I2cController {
  private binding: I2cBinding | null = null;
  /**
   * One controller drives one wire pair, so transactions are serial. A guest that
   * forgets to `await` still gets FIFO rather than three overlapping transactions
   * finishing in order of length. Nothing about a queued transaction is decided
   * until it actually starts: addressing, bit cost and diagnostics all happen then,
   * so a device that loses power while the queue drains NACKs like real hardware.
   */
  private readonly queue: (() => void)[] = [];
  private busy = false;

  constructor(private readonly deps: I2cControllerDeps) {}

  /** Drop the queue and unbind — used by `reset`, where nothing may survive. */
  abort(): void {
    this.queue.length = 0;
    this.busy = false;
  }

  private enqueue(start: () => void): void {
    this.queue.push(start);
    if (!this.busy) this.pump();
  }

  private pump(): void {
    const next = this.queue.shift();
    if (!next) {
      this.busy = false;
      return;
    }
    this.busy = true;
    next();
  }

  /** Every path out of a transaction goes through here, so the queue cannot stall. */
  private finish(run: () => void): void {
    run();
    this.pump();
  }

  bind(binding: I2cBinding | null): void {
    this.binding = binding;
  }

  get bound(): I2cBinding | null {
    return this.binding;
  }

  setClock(frequencyHz: number): void {
    if (this.binding && Number.isFinite(frequencyHz) && frequencyHz > 0) this.binding.frequencyHz = Math.round(frequencyHz);
  }

  write(address: number, bytes: Uint8Array, done: (status: I2cStatusCode) => void): void {
    this.run(address, (phy) => {
      phy.start(address, 'w');
      for (const b of bytes) phy.writeByte(b);
      phy.stop();
    }, (target, phy) => {
      let status: I2cStatusCode = I2C_STATUS.OK;
      for (const step of phy.steps) {
        if (target.onWrite(address, step.bytes, true) === 'nack') status = I2C_STATUS.NACK_DATA;
      }
      done(status);
    }, (status) => done(status));
  }

  read(address: number, length: number, done: (result: I2cReadOutcome) => void): void {
    this.run(address, (phy) => {
      phy.start(address, 'r');
      for (let i = 0; i < length; i++) phy.readByte(true);
      phy.stop();
    }, (target, _phy) => {
      const bytes = target.onRead(address, length);
      if (!bytes) return done({ status: I2C_STATUS.NACK_DATA, bytes: new Uint8Array(0) });
      done({ status: I2C_STATUS.OK, bytes });
    }, (status) => done({ status, bytes: new Uint8Array(0) }));
  }

  writeRead(address: number, bytes: Uint8Array, readLength: number, done: (result: I2cReadOutcome) => void): void {
    this.run(address, (phy) => {
      phy.start(address, 'w');
      for (const b of bytes) phy.writeByte(b);
      phy.repeatedStart(address, 'r');
      for (let i = 0; i < readLength; i++) phy.readByte(true);
      phy.stop();
    }, (target, phy) => {
      // The write half is not a STOP: the device must keep its pointer for the read.
      const write = phy.steps.find((s) => s.dir === 'w');
      if (write && target.onWrite(address, write.bytes, false) === 'nack') {
        return done({ status: I2C_STATUS.NACK_DATA, bytes: new Uint8Array(0) });
      }
      const out = target.onRead(address, readLength);
      if (!out) return done({ status: I2C_STATUS.NACK_DATA, bytes: new Uint8Array(0) });
      done({ status: I2C_STATUS.OK, bytes: out });
    }, (status) => done({ status, bytes: new Uint8Array(0) }));
  }

  /**
   * Address the bus, cost the transaction and schedule its commit. `plan` only
   * counts bits; `commit` is the single place a target is ever touched.
   */
  private run(
    address: number,
    plan: (phy: TransactionPhy) => void,
    commit: (target: I2cTarget, phy: TransactionPhy) => void,
    fail: (status: I2cStatusCode) => void
  ): void {
    this.enqueue(() => this.begin(address, plan, commit, fail));
  }

  private begin(
    address: number,
    plan: (phy: TransactionPhy) => void,
    commit: (target: I2cTarget, phy: TransactionPhy) => void,
    fail: (status: I2cStatusCode) => void
  ): void {
    const bus = this.binding;
    if (!bus) {
      this.deps.diagnoseOnce(`i2c_bus_unavailable|${this.deps.controllerId() ?? '?'}|-1|-|-`, {
        code: 'i2c_bus_unavailable',
        severity: 'warning',
        message: 'I²C 事务发生在 Wire.begin() 成功之前，总线不可用。请先调用 Wire.begin() 并检查它的返回值。',
        ...(this.deps.controllerId() ? { componentIds: [this.deps.controllerId()!] } : {})
      });
      // Still costs virtual time: a failing bus must not become a free spin.
      return this.settle(NACK_BITS, DEFAULT_I2C_HZ, 'i2c-nobus', () => fail(I2C_STATUS.ERR_BUS));
    }

    const candidates = this.deps.registry.on(bus.sdaNet, bus.sclNet).filter((t) => t.powered() && t.addresses().includes(address));
    if (candidates.length === 0) {
      this.nackDiagnostic(bus, address);
      return this.settle(NACK_BITS, bus.frequencyHz, 'i2c-nack', () => fail(I2C_STATUS.NACK_ADDRESS));
    }
    if (candidates.length > 1) {
      this.deps.diagnoseOnce(`i2c_address_collision|${candidates.map((t) => t.componentId).join('+')}|${address}|${bus.sdaNet}|${bus.sclNet}`, {
        code: 'i2c_address_collision',
        severity: 'warning',
        message: `同一条 I²C 总线上有 ${candidates.length} 个器件都使用地址 0x${address.toString(16)}（${candidates.map((t) => t.componentId).join('、')}），无法区分，事务被丢弃。请改其中一个的地址或换一条总线。`,
        componentIds: candidates.map((t) => t.componentId),
        netIds: [bus.sdaNet, bus.sclNet]
      });
      return this.settle(NACK_BITS, bus.frequencyHz, 'i2c-collision', () => fail(I2C_STATUS.COLLISION));
    }

    const target = candidates[0]!;
    const phy = new TransactionPhy();
    plan(phy);
    this.settle(phy.bitCount, bus.frequencyHz, 'i2c-commit', () => commit(target, phy));
  }

  private settle(bits: number, frequencyHz: number, label: string, run: () => void): void {
    this.deps.schedule(durationUsFor(bits, frequencyHz), label, () => this.finish(run));
  }

  /**
   * Nobody answered. The message has to be actionable, so the two mistakes that
   * look identical from the guest's side are told apart: a device on the mirrored
   * net pair means the two wires are swapped, and a device on this very pair with
   * a different address means the address is wrong.
   */
  private nackDiagnostic(bus: I2cBinding, address: number): void {
    const hex = `0x${address.toString(16)}`;
    const crossed = this.deps.registry.crossed(bus.sdaNet, bus.sclNet);
    const onBus = this.deps.registry.on(bus.sdaNet, bus.sclNet);
    const unpowered = onBus.filter((t) => !t.powered());
    const wrongAddress = onBus.filter((t) => t.powered() && !t.addresses().includes(address));

    let message: string;
    let componentIds: string[] = [];
    if (crossed.length) {
      componentIds = crossed.map((t) => t.componentId);
      message = `${componentIds.join('、')} 的 SDA 接到了控制器的 SCL 网络（${bus.sclNet}），SCL 接到了 SDA 网络（${bus.sdaNet}）：请对调这两根线。地址 ${hex} 无人应答。`;
    } else if (unpowered.length) {
      componentIds = unpowered.map((t) => t.componentId);
      message = `${componentIds.join('、')} 在这条总线上但没有供电，地址 ${hex} 无人应答。请检查它的 VCC 与 GND。`;
    } else if (wrongAddress.length) {
      componentIds = wrongAddress.map((t) => t.componentId);
      const known = wrongAddress.flatMap((t) => t.addresses().map((a) => `0x${a.toString(16)}`));
      message = `地址 ${hex} 无人应答：这条总线上的 ${componentIds.join('、')} 使用的是 ${known.join('、')}。请核对程序里的地址或模块的地址跳线。`;
    } else {
      message = `地址 ${hex} 无人应答：控制器所在的 SDA/SCL 网络上没有任何已供电的 I²C 器件。请检查两根信号线是否接到了同一组网络。`;
    }

    this.deps.diagnoseOnce(`i2c_nack|${componentIds.join('+') || '-'}|${address}|${bus.sdaNet}|${bus.sclNet}`, {
      code: 'i2c_nack',
      severity: 'warning',
      message,
      ...(componentIds.length ? { componentIds } : {}),
      netIds: [bus.sdaNet, bus.sclNet]
    });
  }
}
