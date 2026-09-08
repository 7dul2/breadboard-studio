/**
 * Public protocol of the simulator (see docs/SIMULATOR_DESIGN.md §6–§13).
 *
 * Everything here is plain data: serialisable, versioned and independent of
 * React, the DOM or Zustand. Runtime state never enters the design document.
 */
import type { ProgramAsset, SimulationConfig, SimulationControlAction, SimulationSpeed } from '@breadboard-studio/schema';

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
  name?: string;
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
}

export interface NetDriverView {
  componentId: string;
  pin: string;
  value: DigitalValue;
  strength: DriveStrength;
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
    | { type: 'dispose' }
  );

export type RuntimeMessage = SimEnvelope &
  (
    | { type: 'status'; status: SimStatus; nowUs: number }
    | { type: 'visual-diff'; revision: number; states: Record<string, DeviceVisualState[]> }
    | { type: 'serial'; componentId: string; stream: 'stdout' | 'stderr'; text: string; atUs: number }
    | { type: 'diagnostic'; diagnostic: SimDiagnostic }
    | { type: 'io-snapshot'; nets: NetRuntimeView[] }
    | { type: 'profile'; eventsPerSecond: number; queueDepth: number }
  );

/** True when a message belongs to the given session and speaks this protocol version. */
export function acceptsMessage(message: { protocol?: unknown; sessionId?: unknown }, sessionId: string): boolean {
  return message.protocol === SIM_PROTOCOL_VERSION && message.sessionId === sessionId;
}
