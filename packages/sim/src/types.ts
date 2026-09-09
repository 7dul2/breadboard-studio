/**
 * Public protocol of the simulator (see docs/SIMULATOR_DESIGN.md §6–§13).
 *
 * Everything here is plain data: serialisable, versioned and independent of
 * React, the DOM or Zustand. Runtime state never enters the design document.
 */
import type { PinDirection, PinRole, ProgramAsset, SimulationConfig, SimulationControlAction, SimulationControlRange, SimulationSpeed, SimulationVisualKind } from '@breadboard-studio/schema';

/** Bumped whenever HostCommand / RuntimeMessage change shape. Messages with another version are ignored. */
export const SIM_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Session status (docs §12)
// ---------------------------------------------------------------------------

export const SIM_STATUSES = ['idle', 'compiling', 'prepared', 'running', 'paused', 'stepping', 'faulted'] as const;
export type SimStatus = (typeof SIM_STATUSES)[number];

// ---------------------------------------------------------------------------
// Diagnostics (docs §13)
// ---------------------------------------------------------------------------

export type SimSeverity = 'error' | 'warning' | 'info';

export interface SimSourceLocation {
  programId: string;
  line: number;
  column: number;
}

export interface SimDiagnostic {
  code: string;
  severity: SimSeverity;
  message: string;
  /** Virtual time the diagnostic was raised at (µs). Absent for pre-flight diagnostics. */
  atUs?: number;
  componentIds?: string[];
  pinAddresses?: string[];
  netIds?: string[];
  source?: SimSourceLocation;
}

/**
 * Every diagnostic code the simulator may emit. This list and the severity map
 * below are the single source of truth (see docs/SIMULATOR_RUNTIME_PLAN.md §10);
 * new codes are registered here, never invented at the call site.
 */
export const SIM_DIAGNOSTIC_CODES = [
  'simulation_blocked_by_design',
  'simulation_forced_start',
  'breakpoint_hit',
  'program_missing',
  'program_target_missing',
  'runtime_unavailable',
  'device_unpowered',
  'supply_range_unknown',
  'missing_common_ground',
  'digital_contention',
  'floating_input',
  'unsupported_device',
  'i2c_nack',
  'i2c_address_collision',
  'i2c_bus_unavailable',
  'i2c_unknown_command',
  'program_compile_error',
  'program_runtime_error',
  'execution_budget_exceeded',
  'event_queue_overflow',
  'simulation_deadlock',
  'waiting_for_input',
  'stale_simulation_snapshot'
] as const;
export type SimDiagnosticCode = (typeof SIM_DIAGNOSTIC_CODES)[number];

/**
 * Severity is fixed per code, because it decides control flow: the controller
 * faults the session on any `error` diagnostic. Anything the session must
 * survive (a NACK, a floating pin, an unpowered device) is therefore `warning`.
 */
export const SIM_DIAGNOSTIC_SEVERITY: Readonly<Record<SimDiagnosticCode, SimSeverity>> = {
  simulation_blocked_by_design: 'error',
  simulation_forced_start: 'warning',
  breakpoint_hit: 'info',
  program_missing: 'error',
  program_target_missing: 'error',
  runtime_unavailable: 'error',
  program_compile_error: 'error',
  program_runtime_error: 'error',
  execution_budget_exceeded: 'error',
  event_queue_overflow: 'error',
  simulation_deadlock: 'error',
  device_unpowered: 'warning',
  missing_common_ground: 'warning',
  digital_contention: 'warning',
  floating_input: 'warning',
  i2c_nack: 'warning',
  i2c_address_collision: 'warning',
  i2c_bus_unavailable: 'warning',
  i2c_unknown_command: 'warning',
  unsupported_device: 'info',
  supply_range_unknown: 'info',
  waiting_for_input: 'info',
  stale_simulation_snapshot: 'info'
};

export function isSimDiagnosticCode(code: string): code is SimDiagnosticCode {
  return (SIM_DIAGNOSTIC_CODES as readonly string[]).includes(code);
}

// ---------------------------------------------------------------------------
// Signals, snapshot and device specs (docs §6–§7)
// ---------------------------------------------------------------------------

export type DigitalValue = 0 | 1 | 'Z' | 'X';
export type DriveStrength = 'weak' | 'pull' | 'strong';

export interface SimNet {
  /** Stable id derived from the sorted member addresses, never a union-find root. */
  id: string;
  /** Hole and pin addresses in the net. */
  members: string[];
  /** Just the pin addresses, so the kernel does not have to re-filter `members`. */
  pins?: string[];
  name?: string;
}

/**
 * Trimmed projection of a pin's electrical metadata. Deliberately not the whole
 * `PinMeta`: the worker only needs these six keys, and the snapshot crosses a
 * postMessage boundary on every session start.
 */
export interface SimPinMeta {
  role: PinRole;
  direction?: PinDirection;
  drive?: 'push_pull' | 'open_drain' | 'unknown';
  /** Nominal voltage for power pins. */
  voltageV?: number | null;
  ioVoltageV?: number | null;
  maxSourceMa?: number | null;
}

/** A feature the user can operate while the session runs, from the catalog binding. */
export interface SimControlBinding {
  id: string;
  /** Matches a `features[].label`; the feature rect is the hit area on the canvas. */
  featureLabel: string;
  action: SimulationControlAction;
  /** Driver channel the control feeds. */
  channel: string;
  /** Bounds of a `slider`, straight from the catalog. Absent for buttons and pads. */
  range?: SimulationControlRange;
}

/** A feature whose appearance follows the running simulation. */
export interface SimVisualBinding {
  id: string;
  featureLabel: string;
  kind: SimulationVisualKind;
  channel: string;
}

export interface SimI2cBusBinding {
  /** 0 = the default bus, ≥1 = `config.i2c_buses[index-1]`. */
  index: number;
  sdaPin: string;
  sclPin: string;
  /** Net ids, or `unconnected:<componentId>.<pin>` when the pin is not wired. */
  sdaNet: string;
  sclNet: string;
}

export interface SimI2cSpec {
  role: 'controller' | 'device';
  /** A device has exactly one entry; a controller has one per declared bus. */
  buses: SimI2cBusBinding[];
  /** Effective address; explicit null means unknown. */
  address: number | null;
}

/** A pin that sources a fixed voltage while the session runs. */
export interface SimPowerSource {
  address: string;
  componentId: string;
  pin: string;
  voltageV: number;
  netId: string | null;
  maxSourceMa: number | null;
  enabled: boolean;
}

export interface SimDeviceSpec {
  componentId: string;
  /** `<definition id>@<version>` */
  model: string;
  /** Driver id from the catalog `simulation.driver`, or null for a passive electrical endpoint without behaviour. */
  driver: string | null;
  /** Pin name → net id (only pins that belong to a net). */
  pinNets: Record<string, string>;
  /** Driver channel bindings from the catalog (`simulation.pins`). */
  pinChannels: Record<string, string | number>;
  /** Instance `config` merged over catalog `simulation.properties`. */
  properties: Record<string, unknown>;
  /**
   * Resolved instance `params`. Separate from `properties` because they mean
   * different things: `config` is how the part is wired up or addressed, `params`
   * is what the part physically *is* — a resistor's value, an LED's colour. The
   * LED driver is the first thing that needs the distinction.
   */
  params?: Record<string, unknown>;
  /** Electrical metadata per pin. Optional so hand-built snapshots stay valid. */
  pinMeta?: Record<string, SimPinMeta>;
  /** Allowed supply range from `core.supplyRange()`; null means unknown. */
  supply?: { min: number; max: number } | null;
  /** Resolved I²C role, bus pins and address. Absent when the part has no I²C. */
  i2c?: SimI2cSpec;
  /** Catalog `simulation.controls`, so the session translates a control id without guessing. */
  controls?: SimControlBinding[];
  /** Catalog `simulation.visuals`. */
  visuals?: SimVisualBinding[];
}

/** Read-only view of a design taken when a session starts (docs §6). */
export interface SimulationSnapshot {
  protocol: typeof SIM_PROTOCOL_VERSION;
  designRevision: number;
  designHash: string;
  nets: SimNet[];
  pinToNet: Record<string, string>;
  devices: SimDeviceSpec[];
  programs: ProgramAsset[];
  config: SimulationConfig;
  /** Voltage sources and the system ground nets, derived from pin roles. */
  power?: { sources: SimPowerSource[]; groundNets: string[] };
}

export interface NetDriverView {
  componentId: string;
  pin: string;
  value: DigitalValue;
  strength: DriveStrength;
}

/**
 * One edge on a net, in virtual time. The timeline is built from these: the net
 * monitor only ever shows the *current* value, which cannot answer "did that pulse
 * happen" — the question a program that misbehaves once per second actually raises.
 */
export interface NetTransition {
  netId: string;
  atUs: number;
  value: DigitalValue;
}

export interface NetRuntimeView {
  netId: string;
  name?: string;
  value: DigitalValue;
  drivers: NetDriverView[];
}

// ---------------------------------------------------------------------------
// Device visuals and user controls (docs §9.4, §11.3)
// ---------------------------------------------------------------------------

export type DeviceVisualState =
  | { kind: 'led'; feature: string; rgb: [number, number, number]; intensity: number }
  | { kind: 'display'; feature: string; width: number; height: number; pixels: Uint8Array; color: string; enabled: boolean }
  | { kind: 'pressed'; feature: string; active: boolean };

export interface ControlEvent {
  componentId: string;
  /** `simulation.controls[].id` in the catalog definition. */
  controlId: string;
  action: SimulationControlAction;
  /** Pressed/touched/toggled state, or the slider value. */
  value: boolean | number;
  /** Virtual time stamp assigned by the scheduler; recorded events replay with the same value. */
  atUs?: number;
}

export interface SerialLine {
  componentId: string;
  stream: 'stdout' | 'stderr';
  text: string;
  atUs: number;
}

// ---------------------------------------------------------------------------
// Worker protocol (docs §10)
// ---------------------------------------------------------------------------

export interface SimEnvelope {
  protocol: typeof SIM_PROTOCOL_VERSION;
  /** Session id issued by the controller; messages from other sessions are dropped. */
  sessionId: string;
}

export type HostCommand = SimEnvelope &
  (
    | { type: 'prepare'; snapshot: SimulationSnapshot; program: ProgramAsset }
    | { type: 'run' }
    | { type: 'pause' }
    | { type: 'step' }
    | { type: 'reset' }
    | { type: 'set-speed'; speed: SimulationSpeed }
    | { type: 'control'; event: ControlEvent }
    /** Nets to stop on: the session pauses at the next drain after any of them moves. */
    | { type: 'set-breakpoints'; netIds: string[] }
    | { type: 'dispose' }
  );

export type RuntimeMessage = SimEnvelope &
  (
    | { type: 'status'; status: SimStatus; nowUs: number }
    | { type: 'visual-diff'; revision: number; states: Record<string, DeviceVisualState[]> }
    | { type: 'serial'; componentId: string; stream: 'stdout' | 'stderr'; text: string; atUs: number }
    | { type: 'diagnostic'; diagnostic: SimDiagnostic }
    | { type: 'io-snapshot'; nets: NetRuntimeView[] }
    /** `dropped` counts edges the worker's bounded buffer had to discard, so a gap is never silent. */
    | { type: 'net-trace'; transitions: NetTransition[]; dropped: number }
    | { type: 'profile'; eventsPerSecond: number; queueDepth: number }
  );

/** True when a message belongs to the given session and speaks this protocol version. */
export function acceptsMessage(message: { protocol?: unknown; sessionId?: unknown }, sessionId: string): boolean {
  return message.protocol === SIM_PROTOCOL_VERSION && message.sessionId === sessionId;
}
