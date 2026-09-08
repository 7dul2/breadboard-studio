import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_I2C_HZ, I2cController, I2cRegistry, durationUsFor, type I2cTarget } from '../src/i2c.js';
import { I2C_STATUS } from '../src/runtime/guest-modules.js';
import type { SimDiagnostic } from '../src/types.js';
import type { I2cAck } from '../src/contracts.js';

const SDA = 'net_sda';
const SCL = 'net_scl';

interface FakeTarget extends I2cTarget {
  writes: { address: number; bytes: number[]; stop: boolean }[];
  reads: { address: number; length: number }[];
  powerOn: boolean;
}

function target(componentId: string, addresses: number[], opts: { sda?: string; scl?: string; powered?: boolean; ack?: I2cAck; read?: Uint8Array | null } = {}): FakeTarget {
  const t: FakeTarget = {
    componentId,
    sdaNet: opts.sda ?? SDA,
    sclNet: opts.scl ?? SCL,
    writes: [],
    reads: [],
    powerOn: opts.powered ?? true,
    addresses: () => addresses,
    powered: () => t.powerOn,
    onWrite(address, bytes, stop) {
      t.writes.push({ address, bytes: [...bytes], stop });
      return opts.ack ?? 'ack';
    },
    onRead(address, length) {
      t.reads.push({ address, length });
      return opts.read === undefined ? new Uint8Array(length).fill(0xa5) : opts.read;
    }
  };
  return t;
}

/** Virtual clock plus a one-slot queue: every commit runs when the test advances time. */
class Harness {
  nowUs = 0;
  readonly registry = new I2cRegistry();
  readonly diagnostics: SimDiagnostic[] = [];
  readonly controller: I2cController;
  private queue: { atUs: number; label: string; run: () => void }[] = [];
  private readonly seen = new Set<string>();

  constructor() {
    this.controller = new I2cController({
      registry: this.registry,
      schedule: (delayUs, label, commit) => {
        this.queue.push({ atUs: this.nowUs + delayUs, label, run: commit });
      },
      diagnoseOnce: (key, diagnostic) => {
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.diagnostics.push({ ...diagnostic, atUs: this.nowUs });
      },
      controllerId: () => 'mcu'
    });
    this.controller.bind({ sdaNet: SDA, sclNet: SCL, frequencyHz: DEFAULT_I2C_HZ });
  }

  /** Run every scheduled commit in time order, which is what the real scheduler does. */
  flush(): void {
    while (this.queue.length) {
      this.queue.sort((a, b) => a.atUs - b.atUs);
      const next = this.queue.shift()!;
      this.nowUs = next.atUs;
      next.run();
    }
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe('I²C controller', () => {
  it('① a matched address ACKs and costs exactly the bits on the wire', () => {
    const oled = target('oled', [0x3c]);
    h.registry.register(oled);
    let status: number | null = null;
    h.controller.write(0x3c, Uint8Array.from([0x00, 0xaf]), (s) => (status = s));
    expect(status, 'nothing is observable until the transaction ends').toBeNull();
    expect(oled.writes).toHaveLength(0);

    h.flush();
    expect(status).toBe(I2C_STATUS.OK);
    expect(h.nowUs, '29 bits at 400 kHz').toBe(73);
    expect(oled.writes).toEqual([{ address: 0x3c, bytes: [0x00, 0xaf], stop: true }]);
    expect(h.diagnostics).toEqual([]);
  });

  it('② an unmatched address NACKs, costs 11 bits, and reports itself exactly once', () => {
    const oled = target('oled', [0x3c]);
    h.registry.register(oled);
    let status: number | null = null;
    h.controller.write(0x3d, Uint8Array.from([0x00]), (s) => (status = s));
    h.flush();

    expect(status).toBe(I2C_STATUS.NACK_ADDRESS);
    expect(h.nowUs).toBe(28);
    expect(oled.writes, 'the device was never addressed').toHaveLength(0);
    expect(h.diagnostics.map((d) => d.code)).toEqual(['i2c_nack']);
    expect(h.diagnostics[0]!.message, 'says which address the module actually uses').toContain('0x3c');
    expect(h.diagnostics[0]!.componentIds).toEqual(['oled']);

    // A 20 ms loop would file 50 of these a second and flush the whole history.
    for (let i = 0; i < 100; i++) h.controller.write(0x3d, Uint8Array.from([0x00]), () => {});
    h.flush();
    expect(h.diagnostics).toHaveLength(1);
  });

  it('③ an unpowered device does not answer, and says so', () => {
    const oled = target('oled', [0x3c], { powered: false });
    h.registry.register(oled);
    let status: number | null = null;
    h.controller.write(0x3c, Uint8Array.from([0x00]), (s) => (status = s));
    h.flush();

    expect(status).toBe(I2C_STATUS.NACK_ADDRESS);
    expect(h.nowUs).toBe(28);
    expect(oled.writes).toHaveLength(0);
    expect(h.diagnostics.map((d) => d.code)).toEqual(['i2c_nack']);
    expect(h.diagnostics[0]!.message).toContain('没有供电');
  });

  it('④ two devices on one address are indistinguishable, so neither is addressed', () => {
    const a = target('oled_a', [0x3c]);
    const b = target('oled_b', [0x3c]);
    h.registry.register(a);
    h.registry.register(b);
    let status: number | null = null;
    h.controller.write(0x3c, Uint8Array.from([0x00]), (s) => (status = s));
    h.flush();

    expect(status).toBe(I2C_STATUS.COLLISION);
    expect(a.writes).toHaveLength(0);
    expect(b.writes).toHaveLength(0);
    expect(h.diagnostics.map((d) => d.code)).toEqual(['i2c_address_collision']);
    expect(h.diagnostics[0]!.componentIds).toEqual(['oled_a', 'oled_b']);
  });

  it('⑤ write-then-read keeps its order, lands at one instant, and costs the combined bits', () => {
    const sensor = target('sht', [0x44], { read: Uint8Array.from([1, 2, 3, 4, 5, 6]) });
    h.registry.register(sensor);
    let out: { status: number; bytes: Uint8Array } | null = null;
    h.controller.writeRead(0x44, Uint8Array.from([0xfd]), 6, (r) => (out = r));
    h.flush();

    expect(out!.status).toBe(I2C_STATUS.OK);
    expect([...out!.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
    // 1 + 9×(1+1) + 1 + 9×(1+6) + 1 = 84 bits
    expect(h.nowUs).toBe(durationUsFor(84, DEFAULT_I2C_HZ));
    expect(h.nowUs).toBe(210);
    expect(sensor.writes).toEqual([{ address: 0x44, bytes: [0xfd], stop: false }]);
    expect(sensor.reads).toEqual([{ address: 0x44, length: 6 }]);

    // a plain read costs 1 + 9 + 9×6 + 1 = 65 bits
    const fresh = new Harness();
    fresh.registry.register(target('sht', [0x44]));
    fresh.controller.read(0x44, 6, () => {});
    fresh.flush();
    expect(fresh.nowUs).toBe(163);
  });

  it('⑥ a device wired to a different net is simply not on this bus', () => {
    const oled = target('oled', [0x3c], { sda: 'unconnected:oled.SDA' });
    h.registry.register(oled);
    let status: number | null = null;
    h.controller.write(0x3c, Uint8Array.from([0x00]), (s) => (status = s));
    h.flush();

    expect(status).toBe(I2C_STATUS.NACK_ADDRESS);
    expect(oled.writes).toHaveLength(0);
    expect(h.diagnostics[0]!.netIds).toEqual([SDA, SCL]);
    expect(h.diagnostics[0]!.message).toContain('没有任何已供电的 I²C 器件');
  });

  it('⑦ a mirrored pair is named as a swap, because that is the actual fix', () => {
    const oled = target('oled', [0x3c], { sda: SCL, scl: SDA });
    h.registry.register(oled);
    h.controller.write(0x3c, Uint8Array.from([0x00]), () => {});
    h.flush();

    expect(h.diagnostics.map((d) => d.code)).toEqual(['i2c_nack']);
    expect(h.diagnostics[0]!.message).toContain('对调');
    expect(h.diagnostics[0]!.componentIds).toEqual(['oled']);
  });

  it('⑨ a transaction before a successful begin() is a bus error, not a silent no-op', () => {
    const fresh = new Harness();
    fresh.controller.bind(null);
    fresh.registry.register(target('oled', [0x3c]));
    let status: number | null = null;
    fresh.controller.write(0x3c, Uint8Array.from([0x00]), (s) => (status = s));
    fresh.flush();

    expect(status).toBe(I2C_STATUS.ERR_BUS);
    expect(fresh.nowUs, 'a failing bus still costs time, or a retry loop spins for free').toBeGreaterThan(0);
    expect(fresh.diagnostics.map((d) => d.code)).toEqual(['i2c_bus_unavailable']);
  });

  it('⑩ the same sequence twice produces the same statuses at the same instants', () => {
    const run = () => {
      const local = new Harness();
      local.registry.register(target('oled', [0x3c]));
      local.registry.register(target('sht', [0x44], { read: Uint8Array.from([9, 9]) }));
      const trace: { status: number; atUs: number }[] = [];
      local.controller.write(0x3c, Uint8Array.from([0x00, 0xaf]), (s) => trace.push({ status: s, atUs: local.nowUs }));
      local.controller.read(0x44, 2, (r) => trace.push({ status: r.status, atUs: local.nowUs }));
      local.controller.write(0x3e, Uint8Array.from([0x01]), (s) => trace.push({ status: s, atUs: local.nowUs }));
      local.flush();
      return trace;
    };
    expect(run()).toEqual(run());
    expect(run().map((t) => t.status)).toEqual([I2C_STATUS.OK, I2C_STATUS.OK, I2C_STATUS.NACK_ADDRESS]);
  });

  it('serialises un-awaited transactions FIFO instead of overlapping them', () => {
    h.registry.register(target('oled', [0x3c]));
    const trace: { tag: string; atUs: number }[] = [];
    // deliberately not awaited, and deliberately in "slow, fast" order: without a
    // queue the 28 µs NACK would finish before the 73 µs write that was asked first
    h.controller.write(0x3c, Uint8Array.from([0x00, 0xaf]), () => trace.push({ tag: 'first', atUs: h.nowUs }));
    h.controller.write(0x3d, Uint8Array.from([0x00]), () => trace.push({ tag: 'second', atUs: h.nowUs }));
    h.controller.write(0x3c, Uint8Array.from([0x40, 0x01]), () => trace.push({ tag: 'third', atUs: h.nowUs }));
    h.flush();

    expect(trace.map((t) => t.tag)).toEqual(['first', 'second', 'third']);
    expect(trace.map((t) => t.atUs)).toEqual([73, 73 + 28, 73 + 28 + 73]);
  });

  it('honours the clock: the same transaction costs four times as much at 100 kHz', () => {
    h.registry.register(target('oled', [0x3c]));
    h.controller.setClock(100_000);
    h.controller.write(0x3c, Uint8Array.from([0x00, 0xaf]), () => {});
    h.flush();
    expect(h.nowUs).toBe(290);
  });

  it('a device that NACKs the payload reports a data NACK, not an address NACK', () => {
    const oled = target('oled', [0x3c], { ack: 'nack' });
    h.registry.register(oled);
    let status: number | null = null;
    h.controller.write(0x3c, Uint8Array.from([0x00]), (s) => (status = s));
    h.flush();
    expect(status).toBe(I2C_STATUS.NACK_DATA);
    expect(oled.writes, 'the bytes did go out; the device refused them').toHaveLength(1);
  });
});
