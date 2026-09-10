/**
 * Breadboard Studio design document types.
 *
 * Conventions (see docs/ARCHITECTURE.md):
 * - All persisted lengths are integer micrometres (µm). 2.54 mm pitch = 2540 µm.
 * - Screen coordinates: +x right, +y down. Rotations are multiples of 90° and are
 *   positive clockwise on screen.
 * - Every board, component, wire, net intent and constraint has a stable `id`.
 *   Display names may change; references always use ids.
 * - Hole addresses are `<board_id>.<hole_name>`; terminal addresses are
 *   `<component_id>.<pin_name>`.
 */

/** Schema written by this build. Older supported versions are migrated on load (see migrate.ts). */
export const SCHEMA_VERSION = '1.1' as const;
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0', '1.1'] as const;

export type Um = number;
export type PointUm = [Um, Um];
export type RotationDeg = 0 | 90 | 180 | 270;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Design document
// ---------------------------------------------------------------------------

export interface DesignMetadata {
  name: string;
  description?: string;
  author?: string;
  created_at?: string;
  updated_at?: string;
  /** Monotonic revision counter, incremented by every successful transaction. */
  revision: number;
  tags?: string[];
  notes?: string;
}

export interface BoardInstance {
  id: string;
  name?: string;
  /** Catalog reference `<definition_id>@<version>`, e.g. `breadboard_400@1`. */
  model: string;
  position_um: PointUm;
  rotation_deg: RotationDeg;
  locked?: boolean;
  notes?: string;
}

export interface BoardPlacement {
  kind: 'board';
  board_id: string;
  /** Hole name on `board_id` where `anchor_pin` is inserted. */
  anchor_hole: string;
  anchor_pin: string;
  /** Rotation about the anchor pin, clockwise on screen. */
  rotation_deg: RotationDeg;
}

export interface OffBoardPlacement {
  kind: 'off_board';
  position_um: PointUm;
  rotation_deg: RotationDeg;
}

export type Placement = BoardPlacement | OffBoardPlacement;

export interface ComponentInstance {
  id: string;
  name?: string;
  model: string;
  placement: Placement;
  /** Template parameters (pin order, counts, sizes). Validated against the definition's params schema. */
  params?: Record<string, JsonValue>;
  /** Electrical configuration (i2c_address, supply_capacity_ma, io_voltage_v, ...). */
  config?: Record<string, JsonValue>;
  locked?: boolean;
  color?: string;
  notes?: string;
}

export type WireEndpoint = { hole: string; terminal?: undefined } | { terminal: string; hole?: undefined };

export type WireRoute = 'flat' | 'elevated';
export type WirePathMode = 'auto' | 'manual';

export interface WireInstance {
  id: string;
  name?: string;
  from: WireEndpoint;
  /** Missing `to` means an unfinished draft wire. Drafts are reported and never conduct. */
  to?: WireEndpoint;
  color: string;
  route: WireRoute;
  path_mode: WirePathMode;
  /** Intermediate bend points in global µm. Endpoints are derived from `from`/`to`. */
  waypoints_um: PointUm[];
  locked?: boolean;
  notes?: string;
}

export interface NetIntent {
  id: string;
  name: string;
  /** Endpoint addresses: `component.pin` or `board.hole`. */
  endpoints: string[];
  notes?: string;
}

export type Constraint =
  | { id: string; type: 'isolate'; a: string; b: string; notes?: string }
  | { id: string; type: 'wire_length_max_um'; max_um: number; wire_ids?: string[]; notes?: string }
  | { id: string; type: 'note'; text: string; notes?: string };

export interface ViewState {
  zoom?: number;
  center_um?: PointUm;
  show_hole_labels?: boolean;
  show_pin_labels?: boolean;
  build_done?: string[];
}

export interface EmbeddedCatalog {
  boards?: BoardDefinition[];
  components?: ComponentDefinition[];
}

// ---------------------------------------------------------------------------
// Programs and simulation launch configuration (schema 1.1)
// ---------------------------------------------------------------------------

export const PROGRAM_LANGUAGES = ['studio-ts'] as const;
export type ProgramLanguage = (typeof PROGRAM_LANGUAGES)[number];

/**
 * Source code that runs on one controller instance in the simulator. Programs
 * are design content: versioned, hashed, undoable and exported with the file.
 * Runtime state (pin levels, framebuffers, virtual time) is never stored here.
 */
export interface ProgramAsset {
  id: string;
  name: string;
  /** Component instance the program runs on. Removing that component removes the program (cascade). */
  target_component_id: string;
  language: ProgramLanguage;
  source: string;
  /** Entry file name, default `main.ts`. Reserved for multi-file programs. */
  entry?: string;
}

export const SIMULATION_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10] as const;
export type SimulationSpeed = (typeof SIMULATION_SPEEDS)[number];

/** How a simulation session is launched. Starting, pausing or running never changes the design. */
export interface SimulationConfig {
  active_program_id?: string;
  speed?: SimulationSpeed;
  random_seed?: number;
  /** Host boards that receive USB power when the session starts. */
  usb_powered_components?: string[];
}

export interface DesignDocument {
  schema_version: string;
  /** Catalog id -> catalog package version used when the design was saved. */
  catalog_versions: Record<string, string>;
  metadata: DesignMetadata;
  boards: BoardInstance[];
  components: ComponentInstance[];
  wires: WireInstance[];
  net_intents: NetIntent[];
  constraints: Constraint[];
  /** Definitions pinned inside the document so old designs survive catalog upgrades. */
  embedded_catalog?: EmbeddedCatalog;
  /** Programs for controller instances (schema 1.1). */
  programs?: ProgramAsset[];
  /** Simulation launch configuration (schema 1.1). */
  simulation?: SimulationConfig;
  view?: ViewState;
}

// ---------------------------------------------------------------------------
// Catalog definitions
// ---------------------------------------------------------------------------

export type ModelStatus = 'verified' | 'approximate' | 'unknown';

/** Reviewable evidence for a specific definition facet; never hardware certification. */
export interface DefinitionEvidence {
  facet: 'geometry' | 'electrical';
  level: 'documented' | 'measured';
  source_url: string;
  scope: string;
  method: string;
  result: string;
  recorded_at: string;
  reviewer?: string;
  reviewed_at?: string;
}

export interface SourceRef {
  title: string;
  url?: string;
  accessed?: string;
  note?: string;
}

export interface DefinitionLicense {
  /** License of the drawing/data in this definition (original work unless noted). */
  spdx: string;
  attribution?: string;
  note?: string;
}

export interface TerminalBlockDef {
  id: string;
  rows: string[];
  first_column: number;
  columns: number;
  /** Centre of the hole at (first row, first column) in board-local µm. */
  origin_um: PointUm;
}

export interface RailDef {
  id: string;
  holes: number;
  /** Centre of hole 1. */
  origin_um: PointUm;
  /** Holes are visually grouped in runs of `group_size` separated by `gap_pitches` empty pitches. */
  group_size: number;
  gap_pitches: number;
  /** Electrically continuous hole ranges (1-based, inclusive). Multiple segments model a broken rail. */
  segments: [number, number][];
  marking: '+' | '-' | 'none';
  marking_color: string;
  /** Where the printed line sits relative to the holes. */
  marking_side: 'above' | 'below';
}

export interface BoardDefinition {
  kind: 'board';
  id: string;
  version: number;
  name: string;
  manufacturer?: string;
  model?: string;
  variant?: string;
  description?: string;
  size_um: PointUm;
  pitch_um: number;
  terminal_blocks: TerminalBlockDef[];
  rails: RailDef[];
  /** Ravines (centre channels) separating terminal blocks, in board-local µm. */
  ravines: { x_um: number; y_um: number; w_um: number; h_um: number }[];
  render: {
    body_color: string;
    edge_color?: string;
    hole_color?: string;
    label_color?: string;
    corner_radius_um?: number;
  };
  evidence?: DefinitionEvidence[];
  geometry_status: ModelStatus;
  electrical_status: ModelStatus;
  status_notes?: string;
  sources: SourceRef[];
  license: DefinitionLicense;
}

export type PinKind = 'header' | 'terminal' | 'pad';

export type PinRole =
  | 'power_in'
  | 'power_out'
  | 'ground'
  | 'gpio'
  | 'analog'
  | 'i2c_sda'
  | 'i2c_scl'
  | 'signal_in'
  | 'signal_out'
  | 'passive'
  | 'nc'
  | 'unknown';

export type PinDirection = 'in' | 'out' | 'bidir' | 'open_drain' | 'passive' | 'unknown';

export interface ConductionPath {
  /** v0.2 models linear resistors only; a diode is a driver, not a conduction path. */
  kind: 'resistor';
  /** Exactly the two terminals current flows between. */
  pins: [string, string];
  /** `params` key holding the value marking (e.g. `"4.7k"`). Absent means unknown. */
  value_param?: string;
}

export interface PinMeta {
  role: PinRole;
  /** Nominal voltage for power pins (V). */
  voltage_v?: number | null;
  /** Logic level for signal pins (V). null = unknown. */
  io_voltage_v?: number | null;
  direction?: PinDirection;
  /** Output drive type when direction is out/bidir. */
  drive?: 'push_pull' | 'open_drain' | 'unknown';
  /** Maximum current the pin can source when it is a power output (mA). null = unknown. */
  max_source_ma?: number | null;
  aliases?: string[];
  /**
   * Hint for the auto-wire planner. `avoid`: use this host GPIO only when nothing
   * else is free (strapping/USB/PSRAM pins). `skip`: never auto-wire this pin.
   * `to_ground` / `to_power`: a peripheral configuration pin that should be tied
   * to the host's GND / supply instead of a GPIO (e.g. an interface-select pin).
   */
  auto_wire?: 'default' | 'avoid' | 'skip' | 'to_ground' | 'to_power';
  /**
   * The pin is on the header but already committed by this board *variant*, so
   * it is not available as an external GPIO at all — an ESP32-S3 module with
   * octal PSRAM (the R8 in N16R8) owns GPIO35–37, which are broken out on the
   * 44-pin boards anyway. The value names what holds the pin; `notes` should say
   * what happens to a program that drives it regardless. Absent means free.
   *
   * Stronger than `auto_wire: 'skip'`, which only asks the planner to stay away:
   * a reserved pin is never auto-wired *and* the simulator refuses to model it
   * as a GPIO, so a design that uses it fails in the tool the way it fails on the
   * bench. Set it only from the variant's own datasheet — the same footprint
   * without octal PSRAM has these pins free.
   */
  reserved?: 'flash' | 'psram';
  /** Conditional pin functions: warn on external use and prefer ordinary GPIOs. */
  multiplex?: ('strapping' | 'usb' | 'jtag')[];
  notes?: string;
}

export interface PinDef {
  name: string;
  local_um: PointUm;
  kind: PinKind;
}

export interface BodyDef {
  size_um: PointUm;
  /** Height of the body above the board surface, used for collision layers. */
  height_um: number;
  /** Gap between board surface and body underside (e.g. header standoff). */
  standoff_um: number;
  corner_radius_um?: number;
}

/** Optional top-view treatment for header pins; defaults to a gold square. */
export interface PinRenderDef {
  shape: 'rect' | 'circle';
  /** False when the catalog drawing already contains physical silkscreen labels. */
  show_labels?: boolean;
  size_um?: number;
  fill?: string;
  stroke?: string;
  stroke_width_um?: number;
  hole_fill?: string;
  hole_size_um?: number;
}

/** Optional part tag: primitives sharing a `g` are one movable part in the artwork editor. */
export interface RenderPrimitiveBase {
  g?: string;
}

export type RenderPrimitiveDef =
  | ({ t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill?: string; stroke?: string; sw?: number; opacity?: number } & RenderPrimitiveBase)
  | ({ t: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; sw?: number } & RenderPrimitiveBase)
  | ({ t: 'text'; x: number; y: number; text: string; size: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; rotate?: number; weight?: string } & RenderPrimitiveBase)
  | ({ t: 'path'; d: string; fill?: string; stroke?: string; sw?: number } & RenderPrimitiveBase)
  | ({ t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke?: string; sw?: number } & RenderPrimitiveBase);

export interface FeatureDef {
  type: 'usb_c' | 'usb_micro' | 'antenna_area' | 'connector' | 'sensor_window' | 'button' | 'display' | 'led' | 'fan' | 'cable';
  label?: string;
  /** Side of the body (local, unrotated). */
  side?: 'top' | 'bottom' | 'left' | 'right';
  rect_um?: { x: number; y: number; w: number; h: number };
  notes?: string;
}

export interface GeneratorSingleRow {
  type: 'single_row_header';
  /** Which body edge the pins sit on. */
  edge: 'top' | 'bottom' | 'left' | 'right';
  /** Distance from that edge to the pin row centre. */
  inset_um: number;
}

export interface GeneratorDualRow {
  type: 'dual_row_header';
  /** Distance from the top edge to the first pin centre. */
  first_pin_um: number;
}

export interface GeneratorAxialTwoPin {
  type: 'axial_two_pin';
}

export type GeneratorDef = GeneratorSingleRow | GeneratorDualRow | GeneratorAxialTwoPin;

export interface ElectricalDef {
  supply_voltage_v?: { min: number; max: number } | null;
  supply_current_ma?: { typical?: number | null; peak?: number | null } | null;
  io_voltage_v?: number | null;
  i2c?: {
    /** Physical on-board pull-ups for the definition's fixed SDA/SCL pins. Missing = unknown. */
    pullups?: { state: 'present' | 'absent' | 'unknown'; supply_pin?: string; resistance_ohms?: number };
    address_default?: number | null;
    address_options?: number[];
    configurable?: boolean;
    sda_pin: string;
    scl_pin: string;
    /** Hosts: number of independent I²C controllers (ESP32-S3: 2). Extra buses are declared in `config.i2c_buses`. */
    controllers?: number;
    /** Hosts: extra buses may use any GPIO-role pin (GPIO matrix). */
    mappable?: boolean;
    notes?: string;
  } | null;
  notes?: string;
}

export type SimulationControlAction = 'press' | 'touch' | 'toggle' | 'slider';
export type SimulationVisualKind = 'led' | 'display' | 'state';

/** A feature the user can operate while the simulation runs (button, touch pad, slider). */
export interface SimulationControlDef {
  id: string;
  /** Must match a `features[].label`; the feature rect is the hit area. */
  feature_label: string;
  action: SimulationControlAction;
  /** Driver channel the control feeds. */
  channel: string;
  /**
   * Bounds of a `slider`, in the channel's own unit. It belongs to the part, not
   * to the panel: −40…125 °C is what an SHT4x can measure, and the UI should be
   * able to draw the control without knowing what an SHT4x is.
   */
  range?: SimulationControlRange;
}

export interface SimulationControlRange {
  min: number;
  max: number;
  step?: number;
  /** Where the slider sits before anyone touches it. */
  default?: number;
  /** Shown next to the value, e.g. `°C`. */
  unit?: string;
}

/** A feature whose appearance follows the running simulation (LED, display, state badge). */
export interface SimulationVisualDef {
  id: string;
  /** Must match a `features[].label`; the feature rect is where the overlay is drawn. */
  feature_label: string;
  kind: SimulationVisualKind;
  /** Driver channel the visual reads. */
  channel: string;
}

/**
 * Declares which simulator driver models this component and how its pins,
 * controls and visuals bind to that driver. Behaviour lives in
 * @breadboard-studio/sim, never in the catalog.
 */
export interface SimulationDefinition {
  /** Versioned driver id, e.g. `mcu.esp32s3.behavioral@1`. */
  driver: string;
  /** Pin name → driver channel (for MCUs the GPIO number). */
  pins?: Record<string, string | number>;
  properties?: Record<string, JsonValue>;
  controls?: SimulationControlDef[];
  visuals?: SimulationVisualDef[];
}

export interface ComponentDefinition {
  kind: 'component';
  id: string;
  version: number;
  name: string;
  manufacturer?: string;
  model?: string;
  variant?: string;
  description?: string;
  category: 'mcu' | 'display' | 'sensor' | 'input' | 'power' | 'passive' | 'connector' | 'other';
  /** Default mounting: pins inserted in a breadboard, or connected with cables only. */
  mount: 'breadboard' | 'off_board';
  origin: 'top_left';
  /** Rotation the editor uses when the part is first added (UI hint only). */
  preferred_rotation_deg?: RotationDeg;
  /** Present when pins/body are generated from params. */
  generator?: GeneratorDef;
  /** JSON Schema (2020-12) for params; documents what is configurable. */
  params_schema?: Record<string, JsonValue>;
  params_default?: Record<string, JsonValue>;
  config_schema?: Record<string, JsonValue>;
  config_default?: Record<string, JsonValue>;
  body: BodyDef;
  pin_render?: PinRenderDef;
  /** Explicit pins (may be empty when generated). */
  pins: PinDef[];
  pin_meta: Record<string, PinMeta>;
  /** Pins that are tied together inside the component (e.g. multiple GND pins). */
  internal_nets?: string[][];
  /**
   * Two-terminal passives that let current *through* without being one node.
   *
   * The distinction from `internal_nets` is the whole point. Two GND pins tied
   * inside a module are the same node: shorting them is not a fault and nothing
   * drops across them. A resistor's legs are connected through an impedance, so
   * a supply and a ground joined by one is a load, not a short — while the same
   * two legs pushed into one breadboard column *is* still a mistake.
   */
  conduction?: ConductionPath[];
  electrical: ElectricalDef;
  features?: FeatureDef[];
  /** Simulator binding (driver, pin channels, controls, visuals). Absent = no behaviour model. */
  simulation?: SimulationDefinition;
  /** Original vector drawing in body-local µm (unrotated). */
  render: RenderPrimitiveDef[];
  evidence?: DefinitionEvidence[];
  geometry_status: ModelStatus;
  electrical_status: ModelStatus;
  status_notes?: string;
  sources: SourceRef[];
  license: DefinitionLicense;
}

export type CatalogDefinition = BoardDefinition | ComponentDefinition;

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

export interface SchemaIssue {
  path: string;
  message: string;
  keyword?: string;
}
