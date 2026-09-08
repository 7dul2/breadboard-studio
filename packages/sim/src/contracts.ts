/**
 * Cross-module contracts for the simulation kernel.
 *
 * These interfaces are the seams between parts that are built independently:
 * the pump talks to the sandbox through `GuestBridge`, drivers talk to the
 * kernel through `DeviceContext`, and the I²C bus reads power through
 * `PowerView`. They live in one file on purpose — when the signatures were
 * spread across the implementing modules they drifted apart.
 *
 * Implementations live in `scheduler.ts`, `digital-net.ts`, `power.ts`,
 * `devices/*` and `runtime/studio-ts.ts`. Nothing here may import core,
 * catalog or `snapshot.ts` (see `test/imports.test.ts`).
 */
import type { SimulationControlAction, SimulationSpeed } from '@breadboard-studio/schema';
import type { DeviceVisualState, DigitalValue, DriveStrength, NetRuntimeView, SimDeviceSpec, SimDiagnostic } from './types.js';

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SimEvent<P = unknown> {
  /** Integer microseconds. Only `Scheduler.advance()` may move `nowUs` here. */
  atUs: number;
  /** Globally monotonic, never reused: the stable tie-break for one `atUs`. */
  seq: number;
  /** `device:oled` / `guest:sleep` / `control` … */
  source: string;
  type: string;
  payload: P;
}

export interface TimerHandle {
  cancel(): void;
  readonly cancelled: boolean;
}

/** A monotonic wall clock. Injected everywhere so tests never need real timers. */
export interface WallClock {
  nowMs(): number;
}

// ---------------------------------------------------------------------------
// Pump ↔ sandbox seam
// ---------------------------------------------------------------------------

/**
 * What the pump needs from a guest runtime. `StudioTsSandbox` implements this
 * and nothing else: it never owns the budget and never advances virtual time.
 */
export interface GuestBridge {
  /** Re-arm the interrupt deadline. Must be called before every entry into the VM. */
  armDeadline(untilMs: number): void;
  /** Run pending microtasks. `hasPending` true means do not advance time yet. */
  drainJobs(): { hasPending: boolean; error?: unknown };
  /** State of the call the pump is currently driving. */
  drivenState(): 'pending' | 'fulfilled' | { error: unknown };
  /**
   * Whether the host's own interrupt flag fired, and clears it. Must be trusted
   * over any return value: guest code can `.catch()` the interrupt exception.
   */
  takeTripped(): 'time_slice' | null;
}

export type PumpOutcome =
  | { kind: 'finished' }
  /** Slice spent or speed-throttled; there is more to do. */
  | { kind: 'yield' }
  /** Suspended with an empty queue, but the session has external input sources. */
  | { kind: 'idle' }
  /** Suspended with an empty queue and nothing can ever wake it. */
  | { kind: 'deadlock' }
  | { kind: 'budget'; reason: 'time_slice' | 'event_budget' | 'queue_overflow' }
  | { kind: 'fault'; error: unknown };

// ---------------------------------------------------------------------------
// Digital nets
// ---------------------------------------------------------------------------

export interface DriverKey {
  componentId: string;
  pin: string;
}

export interface NetChange {
  netId: string;
  from: DigitalValue;
  to: DigitalValue;
  atUs: number;
}

/** The slice of the digital-net kernel that drivers and the I²C bus may use. */
export interface DigitalNetView {
  valueOf(netId: string): DigitalValue;
  readPin(key: DriverKey, opts?: { diagnose?: boolean }): DigitalValue;
  view(opts?: { includeUnconnected?: boolean }): NetRuntimeView[];
}

export interface DigitalNet extends DigitalNetView {
  /** Register a driving end. Unwired pins get a private single-point net. */
  attach(key: DriverKey, options?: { openDrain?: boolean }): string;
  subscribe(netId: string, componentId: string, listener: (change: NetChange) => void): () => void;
  /** `Z` releases the end. Passing `X` throws: that is a kernel bug, not user error. */
  drive(key: DriverKey, value: DigitalValue, strength?: DriveStrength): void;
  /** Unpowered devices drive `Z` on every end; powering back restores the last value. */
  setDevicePowered(componentId: string, powered: boolean): void;
  netIdOf(key: DriverKey): string;
}

// ---------------------------------------------------------------------------
// Power domain
// ---------------------------------------------------------------------------

export type PowerReason =
  | 'ok'
  | 'usb_off'
  | 'no_source'
  | 'voltage_out_of_range'
  | 'no_ground'
  | 'no_common_ground'
  | 'unknown_range'
  | 'passive';

export interface DevicePowerState {
  componentId: string;
  powered: boolean;
  supplyV: number | null;
  reason: PowerReason;
  sourceNetId: string | null;
}

/** What drivers and the I²C bus see. Power is constant for a whole session. */
export interface PowerView {
  isPowered(componentId: string): boolean;
  supplyVoltage(componentId: string): number | null;
  railVoltage(netId: string): number | null;
}

/** What one driver is told about its own supply. */
export interface DevicePower {
  railV: number | null;
  groundOk: boolean;
  powered: boolean;
}

// ---------------------------------------------------------------------------
// Device drivers
// ---------------------------------------------------------------------------

export type I2cAck = 'ack' | 'nack';

/**
 * Everything a driver can see and do. Deliberately missing: any way to reach
 * another device. `netId` is an opaque string that may only be compared for
 * equality, so wrong wiring shows up as a real failure (spec §3.4).
 */
export interface DeviceContext {
  readonly componentId: string;
  /** This device's own spec, deep-frozen. */
  readonly spec: SimDeviceSpec;
  nowUs(): number;
  /** Seeded by `SimulationConfig.random_seed`. */
  random(): number;

  drive(pin: string, value: DigitalValue, strength?: DriveStrength): void;
  release(pin: string): void;
  read(pin: string): DigitalValue;
  watch(pin: string): void;
  netIdOf(pin: string): string;
  power(): DevicePower;

  after(delayUs: number, token: number): number;
  cancel(handle: number): void;

  /** Must carry every visual channel of this device: the UI replaces the array wholesale. */
  visual(states: DeviceVisualState[]): void;
  serial(stream: 'stdout' | 'stderr', text: string): void;
  diagnose(d: Omit<SimDiagnostic, 'atUs' | 'componentIds'>): void;
  /** Edge-triggered: one diagnostic per key until the condition clears. */
  diagnoseOnce(key: string, d: Omit<SimDiagnostic, 'atUs' | 'componentIds'>): void;

  attachI2c(sdaPin: string, sclPin: string, addresses: number[]): void;
}

export interface DeviceDriver {
  readonly driverId: string;
  onNetChange?(pin: string, value: DigitalValue): void;
  onPowerChange?(power: DevicePower): void;
  /** `controlId` is already translated to its catalog channel. `reset` never arrives here. */
  onControl?(channel: string, action: SimulationControlAction, value: boolean | number): void;
  onTimer?(token: number): void;
  onI2cWrite?(address: number, bytes: Uint8Array, stop: boolean): I2cAck;
  onI2cRead?(address: number, length: number): Uint8Array | null;
  /** `host` is an MCU reset button; `session` is a full simulator reset. */
  onReset?(scope: 'session' | 'host'): void;
  dispose?(): void;
}

export type DeviceFactory = (ctx: DeviceContext) => DeviceDriver;

export interface DriverRegistry {
  has(id: string): boolean;
  ids(): readonly string[];
  create(ctx: DeviceContext): DeviceDriver | null;
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

export interface Pacer {
  /** Milliseconds of real time to wait before `atUs` may be reached. */
  waitMsFor(atUs: number): number;
  /** Re-anchor to the current wall clock and virtual time. */
  reanchor(nowUs: number): void;
  setSpeed(speed: SimulationSpeed): void;
  readonly speed: SimulationSpeed;
}
