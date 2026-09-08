/**
 * The worker-side session: one `HostCommand` in, `RuntimeMessage`s out
 * (plan §6.9).
 *
 * This is where the kernel pieces are actually wired together. It owns the
 * scheduler, the digital nets, the power domain, the driver instances, the
 * Studio TS sandbox, the pump and the outbox — and it is the only place that
 * implements `DeviceContext` and `SandboxHost`, the two seams every other
 * module was written against.
 *
 * Three rules the rest of the system depends on:
 *
 * - `ctx.read()` always diagnoses. `DigitalNetKernel.readPin(key, { diagnose:
 *   true })` is what turns a floating or contended pin into the warning the
 *   user sees; reading without it makes wrong wiring silently return 0, which
 *   is exactly the silent success plan §1 bans.
 * - the asynchronous host handlers take a completion callback and call it from
 *   *inside* a scheduler event. A host `Promise` or a real timer would let real
 *   time leak into a replay, and the pump is synchronous anyway.
 * - the RST control never reaches a driver (plan §6.5): the session consumes
 *   it, because rebuilding the sandbox is a session-level act and nothing on
 *   `DeviceContext` can do it.
 *
 * Everything heavy (QuickJS, sucrase) arrives as a constructor argument, so
 * this file imports no value from either and `packages/sim` stays free of a
 * wasm dependency.
 */
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import type { ProgramAsset, SimulationControlAction, SimulationSpeed } from '@breadboard-studio/schema';
import type { DeviceContext, DeviceDriver, DevicePowerState, DriverRegistry, PumpOutcome, TimerHandle, WallClock } from '../contracts.js';
import {
  SIM_DIAGNOSTIC_SEVERITY,
  SIM_PROTOCOL_VERSION,
  type ControlEvent,
  type DeviceVisualState,
  type DigitalValue,
  type DriveStrength,
  type HostCommand,
  type RuntimeMessage,
  type SimControlBinding,
  type SimDeviceSpec,
  type SimDiagnostic,
  type SimDiagnosticCode,
  type SimSourceLocation,
  type SimStatus,
  type SimulationSnapshot
} from '../types.js';
import { Scheduler } from '../scheduler.js';
import { DigitalNetKernel } from '../digital-net.js';
import { PowerDomain, powerInputFromSnapshot } from '../power.js';
import { builtinDrivers } from '../devices/registry.js';
import { isMcuHostApi, type McuHostApi } from '../devices/esp32s3.js';
import { compileStudioTs, type CompiledProgram, type SucraseTransform } from '../runtime/compile.js';
import { I2C_STATUS, type I2cStatusCode } from '../runtime/guest-modules.js';
import { DEFAULT_I2C_HZ, I2cController, I2cRegistry } from '../i2c.js';
import { describeError, isInterruptError, type GuestErrorShape } from '../runtime/diagnostics.js';
import { StudioTsSandbox, type I2cBeginOptions, type I2cReadResult, type SandboxHost } from '../runtime/studio-ts.js';
import { SimLoop, DEFAULT_EVENT_BUDGET, DEFAULT_SLICE_MS } from './loop.js';
import { Outbox, type OutboxChannel } from './outbox.js';
import { SUPPORTED_SPEEDS } from './pacer.js';

/** Cancels a pending host tick. Returned by the injected scheduler. */
export type CancelTick = () => void;

/**
 * How the session yields to the host between slices. Injected so no real timer
 * is ever hard-coded into `packages/sim`: the worker entry passes a
 * `setTimeout` wrapper, tests pass one they drive by hand (plan §4.7).
 */
export type HostTickScheduler = (delayMs: number, run: () => void) => CancelTick;

export interface SessionRuntimeOptions {
  /** Already built with `newQuickJSWASMModuleFromVariant`. */
  quickjs: QuickJSWASMModule;
  /** sucrase's `transform`; the session never imports it. */
  transform: SucraseTransform;
  clock: WallClock;
  /** One call per drained outbox batch; the worker forwards it to `postMessage`. */
  emit: (messages: RuntimeMessage[]) => void;
  schedule: HostTickScheduler;
  /** Defaults to the built-in table; tests substitute doubles. */
  registry?: DriverRegistry;
  sliceMs?: number;
  eventBudget?: number;
  /** Outbox interval overrides, for tests that want every message. */
  intervalsMs?: Partial<Record<OutboxChannel, number>>;
  /**
   * Overrides `hasWakeableInputSources()` for one session. Only tests should
   * pass it: it is the seam that keeps the `idle` branch of the pump covered
   * while no v0.2 input source can actually reach that branch in production.
   */
  hasInputSources?: boolean;
}

/** Maximum host tick interval, i.e. the pump/refresh cadence (plan §4.6). */
export const TICK_INTERVAL_MS = 16;

/**
 * Whether this snapshot has an input source that could resolve a **pending
 * guest promise** — the single question that turns an empty event queue from a
 * deadlock into a wait (plan §4.3, `PumpOutcome` `idle` vs `deadlock`).
 *
 * Plan §4.3 words the test as "any device declares `simulation.controls`", but
 * that is a proxy for the real question, and in v0.2 the proxy is wrong. The
 * guest API has no primitive that waits on a pin: `gpio.digitalRead` is
 * synchronous, `sleep` schedules its own wake-up event, and every `Wire.*` call
 * completes from a scheduler event the guest itself queued. A control event
 * changes a net value; it cannot settle a promise nobody scheduled. So a
 * program suspended on `await new Promise(() => {})` stays suspended no matter
 * how many buttons the catalog declares, and reporting `idle` there would sit
 * the user in front of "waiting for input" forever — exactly the silent
 * non-failure plan §1 bans.
 *
 * Hence: false for every v0.2 snapshot, controls or not. This function is the
 * one place to change when M-S3 / phase 4 introduces a real awaiting primitive
 * (a pin-wait, an interrupt queue): return true when the snapshot carries a
 * control bound to a device whose driver can wake that primitive.
 */
export function hasWakeableInputSources(_snapshot: SimulationSnapshot): boolean {
  return false;
}

/** Key of the `controlId` → catalog binding index. */
function controlKey(componentId: string, controlId: string): string {
  return `${componentId}|${controlId}`;
}

/** Pin roles that carry supply rather than signal; they get no digital endpoint. */
const SUPPLY_ROLES: ReadonlySet<string> = new Set(['power_in', 'power_out', 'ground']);

/** Where the program is in its `setup()` → `loop()` … life cycle. */
type ProgramPhase = 'none' | 'setup' | 'loop' | 'done';

/** One instantiated device: its driver plus everything the session must undo. */
interface DeviceRuntime {
  driver: DeviceDriver | null;
  unsubscribes: (() => void)[];
  timers: Map<number, TimerHandle>;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

/** mulberry32, the same generator the guest prelude uses. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so each device gets its own stable stream from one session seed. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function speedOf(value: unknown): SimulationSpeed {
  return SUPPORTED_SPEEDS.includes(value as SimulationSpeed) ? (value as SimulationSpeed) : 1;
}

export class SessionRuntime {
  private readonly options: SessionRuntimeOptions;
  private readonly registry: DriverRegistry;
  private readonly sliceMs: number;
  private readonly eventBudget: number;

  private sessionId: string | null = null;
  private outbox: Outbox | null = null;

  private snapshot: SimulationSnapshot | null = null;
  private program: ProgramAsset | null = null;
  private compiled: CompiledProgram | null = null;

  private scheduler = new Scheduler();
  private digitalNet: DigitalNetKernel | null = null;
  private power: PowerDomain | null = null;
  private powerStates = new Map<string, DevicePowerState>();
  private loop: SimLoop | null = null;
  private sandbox: StudioTsSandbox | null = null;

  private readonly devices = new Map<string, DeviceRuntime>();
  /**
   * Catalog control bindings of every device in the snapshot, driver or not,
   * keyed by `controlKey()`. This is what translates a `ControlEvent.controlId`
   * into a driver channel — the session never guesses from the id itself.
   */
  private readonly controlBindings = new Map<string, SimControlBinding>();
  private mcu: (DeviceDriver & McuHostApi) | null = null;

  /**
   * The I²C bus (plan §8). The registry is rebuilt with the devices on every
   * prepare; the controller is the program's single `Wire` peripheral, and it is
   * unbound until `Wire.begin()` resolves a real pair of nets.
   */
  private i2cTargets = new I2cRegistry();
  private i2c: I2cController = this.createI2cController();

  private phase: ProgramPhase = 'none';
  private prepared = false;
  private running = false;
  private stopped = false;
  private resetHeld = false;
  private cancelTick: CancelTick | null = null;
  private timerHandles = 0;
  private readonly onceKeys = new Set<string>();

  /**
   * A stable `GuestBridge` in front of a sandbox that gets rebuilt on RST, so
   * `SimLoop` never has to be recreated. While RST is held the guest is frozen
   * (no jobs, never settles) but the scheduler keeps running, which is what
   * plan §6.5 asks for: external devices carry on, the MCU does not.
   */
  private readonly guest = {
    armDeadline: (untilMs: number): void => {
      if (this.resetHeld) return;
      this.sandbox?.armDeadline(untilMs);
    },
    drainJobs: (): { hasPending: boolean; error?: unknown } => {
      if (this.resetHeld || !this.sandbox) return { hasPending: false };
      return this.sandbox.drainJobs();
    },
    drivenState: (): 'pending' | 'fulfilled' | { error: unknown } => {
      if (this.resetHeld) return 'pending';
      return this.sandbox ? this.sandbox.drivenState() : 'pending';
    },
    takeTripped: (): 'time_slice' | null => {
      if (this.resetHeld || !this.sandbox) return null;
      return this.sandbox.takeTripped();
    }
  };

  constructor(options: SessionRuntimeOptions) {
    this.options = options;
    this.registry = options.registry ?? builtinDrivers();
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    this.eventBudget = options.eventBudget ?? DEFAULT_EVENT_BUDGET;
  }

  // -------------------------------------------------------------------------
  // Command entry point (plan §6.9)
  // -------------------------------------------------------------------------

  handle(command: HostCommand): void {
    if (command.protocol !== SIM_PROTOCOL_VERSION) return;
    if (this.sessionId === null) this.sessionId = command.sessionId;
    if (command.sessionId !== this.sessionId || this.stopped) return;
    try {
      switch (command.type) {
        case 'prepare':
          this.prepare(command.snapshot, command.program);
          return;
        case 'run':
          this.run();
          return;
        case 'pause':
          this.pause();
          return;
        case 'step':
          this.step();
          return;
        case 'reset':
          this.resetSession();
          return;
        case 'set-speed':
          this.loop?.setSpeed(speedOf(command.speed));
          return;
        case 'control':
          this.control(command.event);
          return;
        case 'dispose':
          this.dispose();
          return;
      }
    } catch (error) {
      // A throw from the kernel is a defect, not a user error, but it must
      // still reach the panel rather than dying silently inside the worker.
      this.fail('program_runtime_error', `仿真内核异常：${describeError(error)}`);
    }
  }

  /** Tear everything down. The worker entry calls `self.close()` afterwards. */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopTick();
    this.teardown();
    this.outbox?.flush();
  }

  /** Virtual time in µs. Exposed for the worker entry's fatal-error reports. */
  nowUs(): number {
    return this.scheduler.nowUs;
  }

  // -------------------------------------------------------------------------
  // prepare
  // -------------------------------------------------------------------------

  private prepare(snapshot: SimulationSnapshot, program: ProgramAsset): void {
    this.teardown();
    this.prepared = false;
    this.running = false;
    this.phase = 'none';
    this.onceKeys.clear();
    this.ensureOutbox();
    this.outbox?.clear();

    this.snapshot = snapshot;
    this.program = program;
    // The bus is rebuilt with the devices: targets re-register from their drivers'
    // `attachI2c`, and the controller starts unbound so the program must call
    // `Wire.begin()` again. The objects are reused rather than replaced because the
    // controller captured this registry.
    this.i2cTargets.clear();
    this.i2c.abort();
    this.i2c.bind(null);

    this.buildKernel(snapshot);

    const compiled = compileStudioTs(program, this.options.transform);
    if (!compiled.ok) {
      this.emitDiagnostic({ ...compiled.diagnostic, componentIds: [program.target_component_id] });
      this.outbox?.flush();
      return;
    }
    this.compiled = { code: compiled.code, filename: compiled.filename };

    if (!this.mcu) {
      this.emitDiagnostic(
        this.diagnostic('program_target_missing', `程序的目标元件 ${program.target_component_id} 没有可执行的主控驱动，程序不会运行。`, {
          componentIds: [program.target_component_id]
        })
      );
      this.outbox?.flush();
      return;
    }

    const sandbox = this.buildSandbox();
    if (!sandbox) return;

    this.phase = 'setup';
    if (sandbox.hasEntry('setup')) {
      this.callEntry('setup');
      // One slice, so a setup that never suspends is already done when the
      // host is told "prepared". A setup that does suspend simply continues
      // under the run loop; the pump cannot tell the two entries apart.
      if (this.sandbox) this.handleOutcome(this.loop!.runSlice(), false);
    } else {
      this.phase = 'loop';
    }
    if (!this.sandbox) return;

    this.prepared = true;
    this.emitStatus('prepared');
    this.postIoSnapshot();
    this.outbox?.flush();
  }

  private buildKernel(snapshot: SimulationSnapshot): void {
    this.scheduler = new Scheduler();
    this.digitalNet = new DigitalNetKernel({
      nets: snapshot.nets,
      pinToNet: snapshot.pinToNet,
      onDiagnostic: (diagnostic) => this.emitDiagnostic(diagnostic),
      now: () => this.scheduler.nowUs
    });

    this.power = new PowerDomain(powerInputFromSnapshot(snapshot));
    const states = this.power.evaluate();
    this.powerStates = new Map(states.map((state) => [state.componentId, state]));
    for (const state of states) this.digitalNet.setDevicePowered(state.componentId, state.powered);
    for (const diagnostic of this.power.diagnostics()) this.emitDiagnostic(diagnostic);

    this.mcu = null;
    // Control bindings are indexed for the whole snapshot, before any driver
    // exists: a control on a device with no driver must still translate, so the
    // session can tell "not bound" from "bound but nothing listens".
    this.controlBindings.clear();
    for (const spec of snapshot.devices) {
      for (const control of spec.controls ?? []) this.controlBindings.set(controlKey(spec.componentId, control.id), control);
    }
    for (const spec of snapshot.devices) this.createDevice(spec, snapshot);

    this.loop = new SimLoop({
      scheduler: this.scheduler,
      guest: this.guest,
      clock: this.options.clock,
      hasInputSources: this.options.hasInputSources ?? hasWakeableInputSources(snapshot),
      sliceMs: this.sliceMs,
      eventBudget: this.eventBudget,
      speed: speedOf(snapshot.config.speed),
      flush: () => this.outbox?.flush()
    });
  }

  /** Builds the sandbox and loads the program; null means the failure was reported. */
  private buildSandbox(): StudioTsSandbox | null {
    const compiled = this.compiled;
    if (!compiled) return null;
    try {
      this.sandbox = new StudioTsSandbox({
        quickjs: this.options.quickjs,
        program: compiled,
        host: this.host,
        clock: this.options.clock,
        seed: typeof this.snapshot?.config.random_seed === 'number' ? this.snapshot.config.random_seed : 0
      });
    } catch (error) {
      this.sandbox = null;
      this.fail('runtime_unavailable', `无法创建 Studio TS 沙箱：${describeError(error)}`);
      return null;
    }
    const sandbox = this.sandbox;
    const loaded = sandbox.loadProgram();
    if (!loaded.ok) {
      this.guestFault(loaded.error, true);
      return null;
    }
    return sandbox;
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  private createDevice(spec: SimDeviceSpec, snapshot: SimulationSnapshot): void {
    const componentId = spec.componentId;
    const frozen = deepFreeze(structuredClone(spec)) as SimDeviceSpec;
    const known = new Set([...Object.keys(spec.pinChannels), ...Object.keys(spec.pinNets), ...Object.keys(spec.pinMeta ?? {})]);
    const seed = (typeof snapshot.config.random_seed === 'number' ? snapshot.config.random_seed : 0) ^ hashString(componentId);
    const random = makeRandom(seed);

    const entry: DeviceRuntime = { driver: null, unsubscribes: [], timers: new Map() };

    const requirePin = (pin: string, what: string): void => {
      // Touching a pin of another device is a kernel defect, not user error.
      if (!known.has(pin)) throw new Error(`${what}: ${pin} 不是 ${componentId} 的引脚`);
    };

    const ctx: DeviceContext = {
      componentId,
      spec: frozen,
      nowUs: () => this.scheduler.nowUs,
      random,
      drive: (pin: string, value: DigitalValue, strength: DriveStrength = 'strong') => {
        requirePin(pin, 'drive');
        this.digitalNet?.drive({ componentId, pin }, value, strength);
      },
      release: (pin: string) => {
        requirePin(pin, 'release');
        this.digitalNet?.drive({ componentId, pin }, 'Z');
      },
      read: (pin: string) => {
        requirePin(pin, 'read');
        // `diagnose: true` is mandatory: it is the only source of
        // floating_input / digital_contention (plan §5.1).
        return this.digitalNet?.readPin({ componentId, pin }, { diagnose: true }) ?? 'Z';
      },
      watch: (pin: string) => {
        requirePin(pin, 'watch');
        const netId = this.digitalNet?.netIdOf({ componentId, pin });
        if (netId === undefined) return;
        const off = this.digitalNet!.subscribe(netId, componentId, (change) => entry.driver?.onNetChange?.(pin, change.to));
        entry.unsubscribes.push(off);
      },
      netIdOf: (pin: string) => {
        requirePin(pin, 'netIdOf');
        return this.digitalNet?.netIdOf({ componentId, pin }) ?? `unconnected:${componentId}.${pin}`;
      },
      power: () => {
        const state = this.powerStates.get(componentId);
        const groundOk = state === undefined ? false : state.reason !== 'no_ground' && state.reason !== 'no_common_ground';
        return { railV: state?.supplyV ?? null, groundOk, powered: state?.powered ?? false };
      },
      after: (delayUs: number, token: number) => {
        const handle = ++this.timerHandles;
        const timer = this.scheduler.after(Math.max(0, Math.round(delayUs)), `device:${componentId}`, 'timer', token, () => {
          entry.timers.delete(handle);
          entry.driver?.onTimer?.(token);
        });
        entry.timers.set(handle, timer);
        return handle;
      },
      cancel: (handle: number) => {
        const timer = entry.timers.get(handle);
        if (!timer) return;
        entry.timers.delete(handle);
        timer.cancel();
      },
      // Straight through: the outbox merges by componentId and the driver
      // always sends every channel it owns (plan §7.1).
      visual: (states: DeviceVisualState[]) => this.outbox?.post({ type: 'visual-diff', states: { [componentId]: states } }),
      serial: (stream: 'stdout' | 'stderr', text: string) =>
        this.outbox?.post({ type: 'serial', componentId, stream, text, atUs: this.scheduler.nowUs }),
      diagnose: (diagnostic) => this.emitDiagnostic({ ...diagnostic, atUs: this.scheduler.nowUs, componentIds: [componentId] }),
      diagnoseOnce: (key, diagnostic) =>
        this.emitOnce(`${componentId}|${key}`, { ...diagnostic, atUs: this.scheduler.nowUs, componentIds: [componentId] }),
      attachI2c: (sdaPin: string, sclPin: string, addresses: number[]) => {
        requirePin(sdaPin, 'attachI2c');
        requirePin(sclPin, 'attachI2c');
        // Net ids are resolved on the main thread; the worker only compares them.
        // An unwired pin still gets its `unconnected:` literal, which simply never
        // matches a controller's bus — that is how a cut SDA becomes a NACK.
        const sdaNet = spec.pinNets?.[sdaPin] ?? `unconnected:${componentId}.${sdaPin}`;
        const sclNet = spec.pinNets?.[sclPin] ?? `unconnected:${componentId}.${sclPin}`;
        const wanted = addresses.filter((a) => Number.isInteger(a) && a >= 0 && a <= 0x7f);
        this.i2cTargets.register({
          componentId,
          sdaNet,
          sclNet,
          addresses: () => wanted,
          powered: () => this.powerStates.get(componentId)?.powered ?? false,
          onWrite: (address, bytes, stop) => entry.driver?.onI2cWrite?.(address, bytes, stop) ?? 'nack',
          onRead: (address, length) => entry.driver?.onI2cRead?.(address, length) ?? null
        });
      }
    };

    // Endpoints before the driver, and for every device rather than only the
    // ones that get a driver: the constructor drives pins straight away and an
    // end attached implicitly would lose its open-drain flag, while a driverless
    // part is still an electrical endpoint the net monitor must list (that is
    // how `touch.IO`, a `signal_out`, shows up on TOUCH_IO). Only the three
    // supply roles are skipped — they carry volts, not levels.
    for (const pin of [...known].sort()) {
      if (SUPPLY_ROLES.has(spec.pinMeta?.[pin]?.role ?? '')) continue;
      this.digitalNet?.attach({ componentId, pin }, { openDrain: spec.pinMeta?.[pin]?.drive === 'open_drain' });
    }

    const driver = this.registry.create(ctx);
    if (!driver) {
      this.emitOnce(`unsupported:${componentId}`, this.unsupportedDiagnostic(spec));
      return;
    }
    entry.driver = driver;
    this.devices.set(componentId, entry);
    if (this.mcu === null && this.program?.target_component_id === componentId && isMcuHostApi(driver)) this.mcu = driver;
  }

  private unsupportedDiagnostic(spec: SimDeviceSpec): SimDiagnostic {
    const message =
      spec.driver === null
        ? `${spec.componentId}（${spec.model}）没有仿真驱动，本次仿真把它当作不驱动任何引脚的电气端点。`
        : `${spec.componentId}（${spec.model}）需要的驱动「${spec.driver}」在本版本还没有实现，本次仿真把它当作不驱动任何引脚的电气端点。`;
    return this.diagnostic('unsupported_device', message, { componentIds: [spec.componentId] });
  }

  // -------------------------------------------------------------------------
  // Sandbox host (plan §6.3 / §6.6)
  // -------------------------------------------------------------------------

  private readonly host: SandboxHost = {
    nowUs: () => this.scheduler.nowUs,
    hasPin: (pin: number) => {
      const mcu = this.mcu;
      if (!mcu) return false;
      try {
        mcu.pinNameOf(pin);
        return true;
      } catch {
        return false;
      }
    },
    pinMode: (pin: number, mode: number) => this.requireMcu().pinMode(pin, mode),
    digitalWrite: (pin: number, value: 0 | 1) => this.requireMcu().digitalWrite(pin, value),
    // The four-valued read: `@bbs/runtime` narrows it to 0/1 for digitalRead
    // and hands the raw value to digitalReadRaw.
    digitalRead: (pin: number) => this.requireMcu().digitalReadRaw(pin),
    serialBegin: (baud: number) => this.requireMcu().serialBegin(baud),
    serialWrite: (text: string) => this.requireMcu().serialWrite(text),
    boardModel: () => this.mcu?.model ?? 'unknown',
    rgb: (r: number, g: number, b: number) => this.requireMcu().rgb(r, g, b),
    /**
     * The completion callback fires inside the scheduler event, never from a
     * host promise or a real timer: that is what keeps a replay deterministic
     * and what lets the synchronous pump observe the wake-up.
     */
    sleep: (delayUs: number, done: () => void) => {
      this.scheduler.after(delayUs, 'guest:sleep', 'sleep', null, () => done());
    },
    i2cBegin: (options) => this.i2cBegin(options),
    i2cEnd: () => this.i2c.bind(null),
    i2cSetClock: (hz: number) => this.i2c.setClock(hz),
    i2cWrite: (address: number, bytes: Uint8Array, done: (status: I2cStatusCode) => void) => this.i2c.write(address, bytes, done),
    i2cRead: (address: number, length: number, done: (result: I2cReadResult) => void) => this.i2c.read(address, length, done),
    i2cWriteRead: (address: number, bytes: Uint8Array, length: number, done: (result: I2cReadResult) => void) => this.i2c.writeRead(address, bytes, length, done),
    diagnose: (diagnostic: SimDiagnostic) =>
      this.emitDiagnostic({
        atUs: this.scheduler.nowUs,
        // Plan §10: every sandbox diagnostic names the component the program
        // runs on; the sandbox itself does not know which one that is.
        componentIds: this.program ? [this.program.target_component_id] : [],
        ...diagnostic
      })
  };

  private requireMcu(): DeviceDriver & McuHostApi {
    const mcu = this.mcu;
    if (!mcu) throw new Error('主控驱动不可用');
    return mcu;
  }

  /** The controller the guest's `Wire` drives; rebuilt with the session. */
  private createI2cController(): I2cController {
    return new I2cController({
      registry: this.i2cTargets,
      schedule: (delayUs, label, commit) => {
        this.scheduler.after(delayUs, 'guest:i2c', label, null, commit);
      },
      diagnoseOnce: (key, diagnostic) => this.emitOnce(key, { ...diagnostic, atUs: this.scheduler.nowUs }),
      controllerId: () => this.program?.target_component_id
    });
  }

  /**
   * `Wire.begin()` (plan §8.4). Two hops, both of which can fail honestly: a GPIO
   * number becomes a pin name through the MCU driver, and a pin name becomes a net
   * id through the snapshot. Without arguments the controller's default bus from
   * the catalog is used, which is what the fixture and most programs want.
   *
   * Known inconsistency worth stating: remapping I²C onto non-default pins works
   * here, while core's static rules still judge the design by `i2cBuses(mcu)` and
   * will report `i2c_device_without_controller`. The runtime is right; the panel is
   * conservative. Fixing core is out of scope for v0.2 (plan §8.2).
   */
  private i2cBegin(options: I2cBeginOptions): I2cStatusCode {
    const controllerId = this.program?.target_component_id;
    const spec = controllerId ? this.snapshot?.devices.find((d) => d.componentId === controllerId) : undefined;
    const frequency = typeof options.frequency === 'number' && Number.isFinite(options.frequency) && options.frequency > 0 ? Math.round(options.frequency) : DEFAULT_I2C_HZ;

    const fail = (reason: string): I2cStatusCode => {
      this.emitOnce(
        `i2c_bus_unavailable|begin|${reason}`,
        this.diagnostic('i2c_bus_unavailable', `Wire.begin() 失败：${reason}`, {
          atUs: this.scheduler.nowUs,
          ...(controllerId ? { componentIds: [controllerId] } : {})
        })
      );
      this.i2c.bind(null);
      return I2C_STATUS.ERR_BUS;
    };

    if (!spec) return fail('当前项目里没有运行程序的主控。');
    if (!this.powerStates.get(spec.componentId)?.powered) return fail('主控没有供电，I²C 外设不工作。');

    let sdaNet: string | undefined;
    let sclNet: string | undefined;
    if (options.sda === undefined && options.scl === undefined) {
      const index = typeof options.bus === 'number' ? options.bus : 0;
      const bus = spec.i2c?.buses?.find((b) => b.index === index) ?? spec.i2c?.buses?.[0];
      if (!bus) return fail('这块主控没有可用的 I²C 总线定义。');
      sdaNet = bus.sdaNet;
      sclNet = bus.sclNet;
    } else {
      const resolve = (gpio: unknown, label: string): string | null => {
        if (typeof gpio !== 'number' || !Number.isInteger(gpio)) {
          this.pendingBeginError = `${label} 必须是 GPIO 编号。`;
          return null;
        }
        let pin: string;
        try {
          pin = this.requireMcu().pinNameOf(gpio);
        } catch {
          this.pendingBeginError = `这块主控没有 GPIO${gpio}，无法作为 ${label}。`;
          return null;
        }
        const net = spec.pinNets?.[pin];
        if (!net) {
          this.pendingBeginError = `${label}（GPIO${gpio} / ${pin}）没有接任何东西。`;
          return null;
        }
        return net;
      };
      this.pendingBeginError = null;
      sdaNet = resolve(options.sda, 'SDA') ?? undefined;
      sclNet = sdaNet === undefined ? undefined : (resolve(options.scl, 'SCL') ?? undefined);
      if (!sdaNet || !sclNet) return fail(this.pendingBeginError ?? '引脚无法解析。');
    }

    // `buildSnapshot` gives an unwired pin the literal `unconnected:<id>.<pin>` so the
    // worker never has to tell "no key" from "wired wrong". Binding to one would work —
    // nothing else is on it, so every transaction would NACK — but "SDA 没有接任何东西"
    // is the sentence that actually fixes the circuit, so both paths refuse it here.
    for (const [net, label] of [[sdaNet, 'SDA'], [sclNet, 'SCL']] as const) {
      if (net.startsWith('unconnected:')) return fail(`${label}（${net.slice('unconnected:'.length)}）没有接任何东西，总线不成立。`);
    }
    if (sdaNet === sclNet) return fail(`SDA 与 SCL 落在同一条网络（${sdaNet}）上，这不是一条可用的总线。`);
    this.i2c.bind({ sdaNet, sclNet, frequencyHz: frequency });
    return I2C_STATUS.OK;
  }

  private pendingBeginError: string | null = null;

  // -------------------------------------------------------------------------
  // Transport commands
  // -------------------------------------------------------------------------

  private run(): void {
    if (!this.prepared || this.running || !this.loop) return;
    if (this.phase === 'done') {
      // The program exported no `loop()`; it is over, not runnable.
      this.emitStatus('paused');
      this.outbox?.flush();
      return;
    }
    this.running = true;
    this.loop.reanchor();
    this.emitStatus('running');
    this.outbox?.flush();
    // A macrotask, not a microtask: the worker must stay able to receive
    // `pause` and `control` between slices (plan §6.9).
    this.scheduleTick(0);
  }

  private pause(): void {
    if (!this.running) return;
    this.stopTick();
    this.running = false;
    this.emitStatus('paused');
    this.postIoSnapshot();
    this.outbox?.flush();
  }

  private step(): void {
    if (!this.prepared || !this.loop) return;
    this.stopTick();
    this.running = false;
    const outcome = this.loop.stepOnce();
    this.handleOutcome(outcome, true, true);
    if (this.stopped || !this.prepared) return;
    this.emitStatus('paused');
    this.postIoSnapshot();
    this.outbox?.flush();
  }

  /** Full session reset (plan §4.4): new sandbox *and* new kernel, `nowUs = 0`. */
  private resetSession(): void {
    const snapshot = this.snapshot;
    const program = this.program;
    if (!snapshot || !program) return;
    this.stopTick();
    this.running = false;
    for (const device of this.devices.values()) device.driver?.onReset?.('session');
    this.prepare(snapshot, program);
  }

  /**
   * Route one control event (plan §7.1). The channel comes from the catalog
   * binding in `spec.controls`, never from the id: `rst` reaches the driver
   * contract as `reset` because the ESP32 definition says so, not because the
   * session keeps a table of special ids.
   *
   * An id with no binding is a wiring mistake between the canvas overlay and
   * the catalog, and it must not vanish: one `unsupported_device` (info) names
   * it, then the event is dropped. `emitOnce` keeps a held-down button from
   * flooding the panel.
   */
  private control(event: ControlEvent): void {
    const binding = this.controlBindings.get(controlKey(event.componentId, event.controlId));
    if (!binding) {
      this.emitOnce(
        `control:${event.componentId}:${event.controlId}`,
        this.diagnostic('unsupported_device', `${event.componentId} 没有名为「${event.controlId}」的控件绑定，这次控件操作已被忽略。`, {
          atUs: this.scheduler.nowUs,
          componentIds: [event.componentId]
        })
      );
      // Flushed, not ticked: a control can arrive while the session is paused,
      // and nothing would drain the outbox afterwards.
      this.outbox?.flush();
      return;
    }
    const channel = binding.channel;
    if (channel === 'reset') {
      this.resetButton(event.componentId, event.value === true || (typeof event.value === 'number' && event.value !== 0));
      return;
    }
    const device = this.devices.get(event.componentId);
    if (!device?.driver?.onControl) return;
    device.driver.onControl(channel, event.action as SimulationControlAction, event.value);
    this.postIoSnapshot();
    this.outbox?.tick();
  }

  /**
   * RST (plan §6.5). Holding it freezes the MCU but not the scheduler; letting
   * go rebuilds the sandbox and re-runs `setup()`. The kernel — nets, device
   * state, virtual time — is deliberately left alone: external parts do not
   * necessarily reset with the board.
   */
  private resetButton(componentId: string, held: boolean): void {
    if (this.resetHeld === held) return;
    this.resetHeld = held;
    const device = this.devices.get(componentId);
    const mcu = device && isMcuHostApi(device.driver) ? device.driver : null;
    if (held) {
      mcu?.setResetButton(true);
      device?.driver?.onReset?.('host');
      this.outbox?.tick();
      return;
    }
    mcu?.setResetButton(false);
    // The controller is part of the MCU, so its binding and any queued transaction
    // die with the reset; the OLED keeps its GDDRAM, which is what real hardware does.
    this.i2c.abort();
    this.i2c.bind(null);
    this.sandbox?.dispose();
    this.sandbox = null;
    const sandbox = this.buildSandbox();
    if (!sandbox) return;
    this.phase = 'setup';
    if (sandbox.hasEntry('setup')) this.callEntry('setup');
    else this.phase = 'loop';
    this.outbox?.tick();
  }

  // -------------------------------------------------------------------------
  // The tick loop
  // -------------------------------------------------------------------------

  private scheduleTick(delayMs?: number): void {
    if (!this.running || this.stopped) return;
    this.cancelTick?.();
    let wait = delayMs;
    if (wait === undefined) {
      const nextAtUs = this.scheduler.nextAtUs();
      const paced = nextAtUs === null ? TICK_INTERVAL_MS : this.loop!.pacer.waitMsFor(nextAtUs);
      wait = Math.min(TICK_INTERVAL_MS, paced);
    }
    this.cancelTick = this.options.schedule(Math.max(0, wait), this.tick);
  }

  private stopTick(): void {
    this.cancelTick?.();
    this.cancelTick = null;
  }

  private readonly tick = (): void => {
    this.cancelTick = null;
    if (!this.running || this.stopped || !this.loop) return;
    this.pump();
    if (!this.running) return;
    this.emitStatus('running');
    this.postIoSnapshot();
    this.outbox?.tick();
    this.scheduleTick();
  };

  /**
   * Run slices until the guest suspends, the wall-clock slice is spent or the
   * session stops. The extra rounds matter for a `loop()` that returns without
   * ever awaiting: `runSlice` reports `finished` the moment it does, so one
   * slice per tick would cap such a program at one iteration per frame.
   */
  private pump(): void {
    const loop = this.loop;
    if (!loop) return;
    const deadlineMs = this.options.clock.nowMs() + this.sliceMs;
    for (;;) {
      const outcome = loop.runSlice();
      this.handleOutcome(outcome, true);
      if (outcome.kind !== 'finished') return;
      if (!this.running || this.stopped || this.phase === 'done') return;
      if (this.options.clock.nowMs() >= deadlineMs) return;
    }
  }

  /**
   * `startNext` is false only during `prepare`, where a `setup()` that already
   * returned must not roll straight into `loop()` before the host said run.
   */
  private handleOutcome(outcome: PumpOutcome, startNext = true, stepping = false): void {
    // While RST is held the guest is frozen on purpose, so "nothing to do" is
    // the expected state, not a verdict about the program.
    if (this.resetHeld && (outcome.kind === 'idle' || outcome.kind === 'deadlock')) return;
    switch (outcome.kind) {
      case 'yield':
        return;
      case 'finished':
        if (this.phase === 'setup') this.phase = 'loop';
        if (startNext) this.startNextEntry();
        return;
      case 'idle':
        if (stepping) return;
        this.stopTick();
        this.running = false;
        this.emitDiagnostic(
          this.diagnostic('waiting_for_input', '程序正在等待输入：事件队列已空，仿真暂停，收到控件事件后会继续。', { atUs: this.scheduler.nowUs })
        );
        this.emitStatus('paused');
        this.outbox?.flush();
        return;
      case 'deadlock':
        this.fail('simulation_deadlock', '程序不会再被唤醒：它在等待一个永远不会兑现的结果，事件队列已空，也没有任何输入源能让它继续。');
        return;
      case 'budget':
        this.budgetFailure(outcome.reason);
        return;
      case 'fault':
        this.guestFault(outcome.error as GuestErrorShape);
        return;
    }
  }

  private startNextEntry(): void {
    if (!this.sandbox || this.phase === 'done') return;
    if (!this.sandbox.hasEntry('loop')) {
      this.phase = 'done';
      this.programEnded();
      return;
    }
    this.callEntry('loop');
  }

  /**
   * Enter the VM for one exported function. The deadline is armed here because
   * `callFunction` runs guest code synchronously: without it an infinite loop
   * inside `loop()` would never be interrupted.
   */
  private callEntry(name: 'setup' | 'loop'): void {
    const sandbox = this.sandbox;
    if (!sandbox) return;
    sandbox.armDeadline(this.options.clock.nowMs() + this.sliceMs);
    const result = sandbox.callEntry(name);
    // The host flag beats the return value: guest code can catch the interrupt.
    if (sandbox.takeTripped() !== null) {
      this.budgetFailure('time_slice');
      return;
    }
    if (!result.ok) this.guestFault(result.error);
  }

  private programEnded(): void {
    this.stopTick();
    this.running = false;
    this.mcu?.flushSerial();
    this.emitStatus('paused');
    this.postIoSnapshot();
    this.outbox?.flush();
  }

  private budgetFailure(reason: 'time_slice' | 'event_budget' | 'queue_overflow'): void {
    if (reason === 'queue_overflow') {
      this.fail('event_queue_overflow', `事件队列超过上限 ${this.scheduler.maxQueue} 条：程序正在无限制地排入新事件，仿真已停止。`);
      return;
    }
    const source = reason === 'time_slice' ? this.sandbox?.trippedSource() : undefined;
    const message =
      reason === 'time_slice'
        ? `程序在 ${this.sliceMs} ms 的时间片内没有让出控制权（很可能是死循环）：本次仿真已终止，请修改代码后复位。`
        : `程序在一个时间片内推进了 ${this.eventBudget} 次事件而虚拟时间几乎没有前进（例如 while(true) await sleep(0)）：本次仿真已终止。`;
    this.fail('execution_budget_exceeded', message, source ? { source } : {});
  }

  private guestFault(error: GuestErrorShape | unknown, compileTime = false): void {
    if (isInterruptError(error)) {
      this.budgetFailure('time_slice');
      return;
    }
    const shape = (error ?? {}) as GuestErrorShape;
    const source: SimSourceLocation = this.sandbox
      ? this.sandbox.locate(shape)
      : { programId: this.compiled?.filename ?? this.program?.id ?? 'program', line: 1, column: 1 };
    const syntax = compileTime && shape.name === 'SyntaxError';
    this.fail(syntax ? 'program_compile_error' : 'program_runtime_error', `${syntax ? '程序无法编译' : '程序运行出错'}：${describeError(shape)}`, {
      source
    });
  }

  private fail(code: SimDiagnosticCode, message: string, extra: Partial<SimDiagnostic> = {}): void {
    this.stopTick();
    this.running = false;
    this.mcu?.flushSerial();
    this.emitDiagnostic(
      this.diagnostic(code, message, {
        atUs: this.scheduler.nowUs,
        ...(this.program ? { componentIds: [this.program.target_component_id] } : {}),
        ...extra
      })
    );
    this.outbox?.flush();
  }

  // -------------------------------------------------------------------------
  // Outbox plumbing
  // -------------------------------------------------------------------------

  private ensureOutbox(): void {
    if (this.outbox || this.sessionId === null) return;
    this.outbox = new Outbox({
      clock: this.options.clock,
      sessionId: this.sessionId,
      emit: this.options.emit,
      ...(this.options.intervalsMs ? { intervalsMs: this.options.intervalsMs } : {})
    });
  }

  private emitStatus(status: SimStatus): void {
    this.outbox?.post({ type: 'status', status, nowUs: this.scheduler.nowUs });
  }

  private postIoSnapshot(): void {
    const nets = this.digitalNet?.view();
    if (nets) this.outbox?.post({ type: 'io-snapshot', nets });
  }

  private diagnostic(code: SimDiagnosticCode, message: string, extra: Partial<SimDiagnostic> = {}): SimDiagnostic {
    return { code, severity: SIM_DIAGNOSTIC_SEVERITY[code], message, ...extra };
  }

  private emitDiagnostic(diagnostic: SimDiagnostic): void {
    this.ensureOutbox();
    this.outbox?.post({ type: 'diagnostic', diagnostic });
  }

  /** One diagnostic per key for the life of the session (plan §8.5). */
  private emitOnce(key: string, diagnostic: SimDiagnostic): void {
    if (this.onceKeys.has(key)) return;
    this.onceKeys.add(key);
    this.emitDiagnostic(diagnostic);
  }

  // -------------------------------------------------------------------------

  private teardown(): void {
    this.stopTick();
    this.running = false;
    this.prepared = false;
    this.resetHeld = false;
    for (const device of this.devices.values()) {
      for (const off of device.unsubscribes) off();
      device.unsubscribes.length = 0;
      for (const timer of device.timers.values()) timer.cancel();
      device.timers.clear();
      device.driver?.dispose?.();
    }
    this.devices.clear();
    this.controlBindings.clear();
    this.mcu = null;
    this.sandbox?.dispose();
    this.sandbox = null;
    this.compiled = null;
    this.digitalNet = null;
    this.power = null;
    this.powerStates.clear();
    this.loop = null;
    this.phase = 'none';
  }
}
