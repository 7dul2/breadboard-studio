import type { DesignDocument, JsonValue, PinRole, PointUm, WireEndpoint, WireRoute } from '@breadboard-studio/schema';
import { Catalog } from '@breadboard-studio/catalog';
import { holeAddress, parseAddress, terminalAddress } from './address.js';
import { buildConnectivity, conductiveSet, pinKey, voltageName, type Connectivity } from './connectivity.js';
import { distance, polylineLength, toGlobal, type Rect } from './geometry.js';
import { accessibleHolesForPin, buildModel, flatRouteObstacles, groupHoles, terminalRouteEnd, type DesignModel, type PlacedBoard, type PlacedComponent, type PlacedPin } from './model.js';
import type { Op } from './ops.js';
import type { RuleResult } from './results.js';
import { checkModel, i2cAddress, i2cBuses, i2cPins, supplyRange } from './rules.js';
import { autoRoute, type RouteEnd } from './wire-route.js';

/**
 * Auto-wire planner ("自动布线").
 *
 * Given one host (a controller or a power source) and a set of peripheral
 * components, generate wires by pin role: peripheral GND → host GND, power_in →
 * a host supply of a compatible voltage, SDA/SCL → the host I²C pins, and
 * signal/GPIO pins → free host GPIOs.
 *
 * How it chooses where a wire goes:
 *
 * - Every candidate endpoint pair (free hole in the pin's group × reachable
 *   tap of the net) is routed with the same obstacle-avoiding router the model
 *   uses for hard jumpers, with all earlier wires as obstacles. The pair with
 *   the shortest real path wins, so a chained bus takes a free row instead of
 *   detouring around an occupied one.
 * - Power and ground are distributed over the breadboard rails. Reaching a
 *   rail segment is planned as a shortest path over "distribution hops" (host
 *   group → nearest matching rail, rail → next segment across a break or onto
 *   the next board), so feeders stay short and far segments are reached by
 *   short bridges rather than by one long wire.
 * - In `auto` mode short on-board runs become hard jumpers; cable terminals,
 *   cross-board runs and long or heavily detoured runs become Dupont wires.
 *
 * The planner is rule based: it reads pin roles from the catalog, never
 * simulates the circuit, and reports every pin it could not connect instead of
 * guessing. The resulting ops go through the ordinary transaction + rule
 * engine like any other edit, so the design stays the single source of truth.
 */

export interface AutoWireOptions {
  /** Preferred host supply for peripherals whose allowed range is unknown or admits several voltages. */
  supply_voltage_v?: number;
  /** `rail` (default when a rail is reachable) distributes power/ground over the rails; `direct` chains through hole groups only. */
  power_distribution?: 'auto' | 'rail' | 'direct';
  /** Explicit host pin per peripheral signal pin, e.g. `{ "touch.IO": "GPIO4" }`. */
  signal_pins?: Record<string, string>;
  /** Create/extend net intents for the generated nets (default true). */
  net_intents?: boolean;
  /** Wire route; `auto` uses hard jumpers for short on-board runs and Dupont wires for cables, cross-board and long/detoured runs. */
  route?: 'auto' | WireRoute;
  /** Fail the whole operation when any pin stays unresolved (default: apply what is possible and report the rest). */
  require_all?: boolean;
  /**
   * `global` (default): plan every net as a whole — exhaustive spanning-tree
   * search per net, exhaustive rail-segment subset search for power/ground,
   * then rip-up-and-reorder of the hard jumpers — and keep the result only if
   * it beats the greedy pin-by-pin plan under the same objective.
   * `greedy`: pin-by-pin, nearest-first only.
   */
  optimize?: 'global' | 'greedy';
  /** Wall-clock budget for the global search (default 1500 ms); exhausted searches are reported as heuristic. */
  time_budget_ms?: number;
  /**
   * What to do when two I²C devices with the same address would land on one bus.
   * `bus_first` (default): open another I²C bus on the host when it has a spare controller
   * and free GPIOs, otherwise switch the device to another catalog address option;
   * `address_first`: the other way round; `report`: leave the device unwired and report.
   * Every automatic choice is reported as `needs_review` because it needs a firmware
   * (and for addresses a jumper/resistor) change.
   */
  i2c_conflicts?: 'bus_first' | 'address_first' | 'report';
}

export interface AutoWireRequest extends AutoWireOptions {
  host: string;
  components: string[];
}

export type AutoWireVia = 'group' | 'rail' | 'terminal';

export interface AutoWireConnection {
  component: string;
  pin: string;
  role: PinRole;
  /** Net name, e.g. GND, 3V3, SDA, TOUCH_IO. */
  net: string;
  host_pin: string;
  wire_id: string;
  from: string;
  to: string;
  via: AutoWireVia;
  color: string;
  route: WireRoute;
  /** Estimated path length in µm (routed for hard jumpers, straight span for Dupont wires). */
  length_um: number;
}

export interface AutoWireBridge {
  net: string;
  wire_id: string;
  from: string;
  to: string;
  /** feeder: host group/terminal → rail; bridge: rail segment → rail segment (across a break or onto another board). */
  kind: 'feeder' | 'bridge';
  route: WireRoute;
  length_um: number;
}

export interface AutoWireSkip {
  component: string;
  pin: string;
  code: string;
  reason: string;
  suggestion?: string;
}

export interface AutoWireOptimization {
  /** Which plan was kept. */
  strategy: 'global' | 'greedy';
  /** Objective of the kept plan: Σ routed length + bend/Dupont penalties + a per-wire cost, in µm. */
  objective_um: number;
  greedy_objective_um: number;
  global_objective_um: number | null;
  /** True when every net topology and rail subset was enumerated completely and the order search converged within budget. */
  exhaustive: boolean;
  elapsed_ms: number;
  /** Per-net search notes (node counts, trees / subsets enumerated, fallbacks). */
  notes: string[];
}

/** A config edit the planner made to avoid a conflict (extra I²C bus on the host, alternative device address). */
export interface AutoWireConfigChange {
  id: string;
  path: string;
  value: JsonValue;
  reason: string;
}

export interface AutoWireI2cBus {
  index: number;
  sda: string;
  scl: string;
  /** Devices assigned to this bus by this plan. */
  devices: string[];
  /** True when the plan created the bus (config.i2c_buses). */
  added: boolean;
}

export interface AutoWirePlan {
  host: string;
  components: string[];
  optimization: AutoWireOptimization;
  /** I²C buses used by the plan and config edits made to keep addresses unique. */
  i2c_buses: AutoWireI2cBus[];
  config_changes: AutoWireConfigChange[];
  /** Ops that realise the plan (add_wire / add_net_intent / update_net_intent). */
  ops: Op[];
  connections: AutoWireConnection[];
  bridges: AutoWireBridge[];
  skipped: AutoWireSkip[];
  unresolved: AutoWireSkip[];
  /** Notes to merge into the transaction results (info / needs_review / warning). */
  results: RuleResult[];
}

export class AutoWireError extends Error {}

const SIGNAL_COLORS = ['green', 'white', 'purple', 'orange', 'brown', 'gray'];

/** Hard jumpers longer than this become Dupont wires in `auto` mode. */
const FLAT_MAX_UM = 50_000;
/** A hard jumper whose routed path exceeds `ratio × straight + slack` is a detour: use a Dupont wire instead. */
const DETOUR_RATIO = 1.3;
const DETOUR_SLACK_UM = 8_000;
/** Cost per bend when comparing candidate endpoint pairs (straight runs read better). */
const BEND_COST_UM = 2_000;
/** Dupont wires are compared at their span plus this handicap, so a short hard jumper wins over a Dupont wire of similar length. */
const ELEVATED_HANDICAP_UM = 6_000;
/** How many nearest taps / rail holes are routed for real per source hole. */
const TARGET_CANDIDATES = 6;
/** Fixed cost per wire in the objective: fewer wires are easier to build. */
const WIRE_COST_UM = 3_000;
/** Largest net (host + peripheral pins) whose spanning trees are enumerated exhaustively (7 nodes = 16807 trees). */
const EXHAUSTIVE_TREE_NODES = 7;
/** Largest number of rail segments whose subsets are enumerated exhaustively. */
const EXHAUSTIVE_RAIL_SEGMENTS = 10;
const DEFAULT_TIME_BUDGET_MS = 1_500;

interface Tap {
  ep: WireEndpoint;
  address: string;
  global: PointUm;
  board_id: string | null;
  /** Rail segment group key `board:group` when the tap is a rail hole. */
  segment: string | null;
}

interface NetPlan {
  key: string;
  name: string;
  kind: 'ground' | 'power' | 'i2c' | 'signal';
  hostPin: string;
  color: string;
  taps: Tap[];
  /** Rail segments already reachable. */
  segments: Set<string>;
  /** Peripheral pin keys connected by this plan. */
  members: string[];
}

interface Candidate {
  source: Tap;
  target: Tap;
  route: WireRoute;
  /** Full path including both endpoints (straight span for Dupont wires). */
  points: PointUm[];
  length_um: number;
  cost: number;
}

interface Ctx {
  model: DesignModel;
  conn: Connectivity;
  host: PlacedComponent;
  req: AutoWireRequest;
  reserved: Set<string>;
  usedIds: Set<string>;
  usedTerminals: Set<string>;
  plannedGpios: Set<string>;
  nets: Map<string, NetPlan>;
  /** Rail segment key → net key that claimed it during planning. */
  segmentOwner: Map<string, string>;
  /** Paths of hard jumpers already in the design plus the ones planned so far (router obstacles). */
  flatPaths: PointUm[][];
  /** Hard jumpers already in the design (never changes during planning). */
  baseFlatPaths: PointUm[][];
  /** Cost estimates against the design-only obstacles, shared between strategies. */
  estimateCache: Map<string, Candidate>;
  /** Greedy pin order of the classified members (used as one of the start orders for the sequence search). */
  memberOrder: Map<string, number>;
  i2c: I2cAssignment;
  /** Config edits emitted before the wires (extra bus, address change). */
  configOps: Op[];
  configChanges: AutoWireConfigChange[];
  /** Σ (candidate cost + WIRE_COST) of every wire emitted so far. */
  objective: number;
  wires: Op[];
  connections: AutoWireConnection[];
  bridges: AutoWireBridge[];
  skipped: AutoWireSkip[];
  unresolved: AutoWireSkip[];
  results: RuleResult[];
  signalColor: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function manhattan(a: PointUm, b: PointUm): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function holeGlobal(model: DesignModel, addr: string): PointUm | null {
  const parsed = parseAddress(addr);
  const pb = parsed ? model.boards.get(parsed.owner) : undefined;
  const h = pb && parsed ? pb.resolved.holes.get(parsed.name) : undefined;
  if (!pb || !h) return null;
  return toGlobal(h.local_um, pb.transform);
}

function segmentKey(model: DesignModel, addr: string): string | null {
  const parsed = parseAddress(addr);
  const pb = parsed ? model.boards.get(parsed.owner) : undefined;
  const h = pb && parsed ? pb.resolved.holes.get(parsed.name) : undefined;
  if (!pb || !h || h.kind !== 'rail') return null;
  return `${pb.instance.id}:${h.group}`;
}

function isFreeHole(ctx: Ctx, addr: string): boolean {
  const st = ctx.model.holes.get(addr);
  return !!st && st.status === 'free' && st.wires.length === 0 && !ctx.reserved.has(addr);
}

function holeTap(ctx: Ctx, addr: string): Tap | null {
  const g = holeGlobal(ctx.model, addr);
  if (!g) return null;
  return { ep: { hole: addr }, address: addr, global: g, board_id: parseAddress(addr)!.owner, segment: segmentKey(ctx.model, addr) };
}

function terminalTap(ctx: Ctx, pc: PlacedComponent, pin: PlacedPin): Tap {
  const key = pinKey(pc.instance.id, pin.name);
  return { ep: { terminal: key }, address: key, global: pin.global_um, board_id: null, segment: null };
}

function nextWireId(ctx: Ctx): string {
  let n = 1;
  while (ctx.usedIds.has(`w${n}`)) n++;
  const id = `w${n}`;
  ctx.usedIds.add(id);
  return id;
}

function pinOf(pc: PlacedComponent, name: string): PlacedPin | undefined {
  return pc.pins.find((p) => p.name === name);
}

function terminalWired(ctx: Ctx, addr: string): boolean {
  if (ctx.usedTerminals.has(addr)) return true;
  for (const w of ctx.model.design.wires) if (w.from.terminal === addr || w.to?.terminal === addr) return true;
  return false;
}

function nearestBy<T>(items: T[], key: (t: T) => number, limit: number): T[] {
  return [...items].sort((a, b) => key(a) - key(b)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Routing-aware candidate evaluation
// ---------------------------------------------------------------------------

function routeEndOf(ctx: Ctx, tap: Tap): RouteEnd {
  if (tap.ep.terminal) {
    const parsed = parseAddress(tap.ep.terminal)!;
    return terminalRouteEnd(ctx.model.components.get(parsed.owner), parsed.name, tap.global);
  }
  return { point: tap.global };
}

function terminalOwnersOf(a: Tap, b: Tap): Set<string> {
  const owners = new Set<string>();
  for (const t of [a, b]) if (t.ep.terminal) owners.add(parseAddress(t.ep.terminal)!.owner);
  return owners;
}

/** Route a hard jumper between two taps exactly as the model will, given the hard jumpers in `flatPaths`. */
function flatPath(ctx: Ctx, a: Tap, b: Tap, flatPaths: PointUm[][]): PointUm[] {
  const obstacles: Rect[] = flatRouteObstacles(ctx.model.components.values(), flatPaths, terminalOwnersOf(a, b));
  const wps = autoRoute(routeEndOf(ctx, a), routeEndOf(ctx, b), obstacles);
  return [a.global, ...wps, b.global];
}

/**
 * Evaluate one endpoint pair: decide hard jumper vs Dupont wire (unless the
 * request forces one), compute the path it will get and a comparable cost.
 * Obstacles default to everything planned so far.
 */
function evaluate(ctx: Ctx, source: Tap, target: Tap, flatPaths: PointUm[][] = ctx.flatPaths): Candidate {
  const forced = ctx.req.route && ctx.req.route !== 'auto' ? ctx.req.route : null;
  const straight = distance(source.global, target.global);
  const crossBoard = !source.board_id || !target.board_id || source.board_id !== target.board_id;
  const elevated = (): Candidate => ({ source, target, route: 'elevated', points: [source.global, target.global], length_um: Math.round(straight), cost: straight + ELEVATED_HANDICAP_UM });
  if (forced === 'elevated') return elevated();
  if (!forced && crossBoard) return elevated();
  const points = flatPath(ctx, source, target, flatPaths);
  const length = polylineLength(points);
  const bends = Math.max(0, points.length - 2);
  if (!forced && (length > FLAT_MAX_UM || length > DETOUR_RATIO * straight + DETOUR_SLACK_UM)) return elevated();
  return { source, target, route: 'flat', points, length_um: Math.round(length), cost: length + bends * BEND_COST_UM };
}

/** Best routed pair among source holes and the nearest targets (by Manhattan distance) of each source. */
function bestPair(ctx: Ctx, sources: Tap[], targets: Tap[]): Candidate | null {
  let best: Candidate | null = null;
  for (const s of sources) {
    for (const t of nearestBy(targets, (x) => manhattan(x.global, s.global), TARGET_CANDIDATES)) {
      const c = evaluate(ctx, s, t);
      if (!best || c.cost < best.cost) best = c;
    }
  }
  return best;
}

/** Obstacle set used for net-level estimates: design-only paths, or those plus already planned power wires. */
interface Estimator {
  paths: PointUm[][];
  cache: Map<string, Candidate>;
}

/** Cost of a pair against the estimator's obstacles (cached; entries may have source/target swapped — callers only read cost/route/length). */
function estimate(ctx: Ctx, est: Estimator, a: Tap, b: Tap): Candidate {
  const key = a.address < b.address ? `${a.address}|${b.address}` : `${b.address}|${a.address}`;
  let c = est.cache.get(key);
  if (!c) {
    c = evaluate(ctx, a, b, est.paths);
    est.cache.set(key, c);
  }
  return c;
}

function emitWire(ctx: Ctx, net: NetPlan, c: Candidate, name: string): string {
  const id = nextWireId(ctx);
  ctx.wires.push({ op: 'add_wire', wire: { id, name, from: c.source.ep, to: c.target.ep, color: net.color, route: c.route, path_mode: 'auto' } });
  if (c.route === 'flat') ctx.flatPaths.push(c.points);
  ctx.objective += c.cost + WIRE_COST_UM;
  return id;
}

// ---------------------------------------------------------------------------
// Nets and taps
// ---------------------------------------------------------------------------

/** Initial taps of a host pin: every free hole electrically tied to it, or the terminal itself when it is a cable end. */
function initialTaps(ctx: Ctx, hostPin: PlacedPin): Tap[] {
  const key = pinKey(ctx.host.instance.id, hostPin.name);
  const taps: Tap[] = [];
  const set = conductiveSet(ctx.model, ctx.conn, key);
  for (const h of set.holes) {
    if (!isFreeHole(ctx, h)) continue;
    const t = holeTap(ctx, h);
    if (t) taps.push(t);
  }
  if (!hostPin.hole && !terminalWired(ctx, key)) taps.push(terminalTap(ctx, ctx.host, hostPin));
  return taps;
}

function netFor(ctx: Ctx, key: string, make: () => Omit<NetPlan, 'taps' | 'segments' | 'members'>): NetPlan {
  let n = ctx.nets.get(key);
  if (n) return n;
  const base = make();
  const hostPin = pinOf(ctx.host, base.hostPin)!;
  const taps = initialTaps(ctx, hostPin);
  n = { ...base, taps, segments: new Set(taps.map((t) => t.segment).filter((s): s is string => !!s)), members: [] };
  for (const seg of n.segments) ctx.segmentOwner.set(seg, key);
  ctx.nets.set(key, n);
  return n;
}

function takeTap(ctx: Ctx, net: NetPlan, tap: Tap): void {
  net.taps = net.taps.filter((t) => t.address !== tap.address);
  if (tap.ep.hole) ctx.reserved.add(tap.address);
  else ctx.usedTerminals.add(tap.address);
}

/** Add the still-free holes of a hole's group to the net taps (chaining). */
function addGroupTaps(ctx: Ctx, net: NetPlan, addr: string): void {
  for (const h of groupHoles(ctx.model, addr)) {
    if (h === addr || !isFreeHole(ctx, h)) continue;
    if (net.taps.some((t) => t.address === h)) continue;
    const t = holeTap(ctx, h);
    if (t) net.taps.push(t);
  }
}

/** After a wire lands on `tap`, the rest of its group joins the net. */
function absorb(ctx: Ctx, net: NetPlan, tap: Tap): void {
  takeTap(ctx, net, tap);
  if (tap.ep.hole) {
    const seg = tap.segment;
    addGroupTaps(ctx, net, tap.address);
    if (seg) {
      net.segments.add(seg);
      ctx.segmentOwner.set(seg, net.key);
    }
  }
}

// ---------------------------------------------------------------------------
// Rails: cost-based distribution
// ---------------------------------------------------------------------------

interface Segment {
  key: string;
  board: PlacedBoard;
  free: Tap[];
  inNet: boolean;
}

/**
 * A rail segment can only be claimed for a net when nothing else already uses
 * it: another planned net, or an existing net (wires or ≥2 pins) that is not
 * the one we are extending.
 */
function segmentAvailable(ctx: Ctx, segKey: string, net: NetPlan, sampleHole: string): boolean {
  const owner = ctx.segmentOwner.get(segKey);
  if (owner && owner !== net.key) return false;
  if (net.segments.has(segKey)) return true;
  const root = ctx.conn.full.find(sampleHole);
  const hostRoot = ctx.conn.full.find(pinKey(ctx.host.instance.id, net.hostPin));
  if (root === hostRoot) return true;
  if (ctx.conn.netByRoot.get(root)) return false;
  // Holes of this segment might be wired to something without forming a named net (a single pin): still foreign.
  for (const h of groupHoles(ctx.model, sampleHole)) {
    const st = ctx.model.holes.get(h);
    if (st && (st.status !== 'free' || st.wires.length)) return false;
  }
  return true;
}

/** Usable rail segments of every board for this net (matching polarity when the board marks its rails). */
function railSegments(ctx: Ctx, net: NetPlan): Segment[] {
  const want = net.kind === 'ground' ? '-' : '+';
  const out: Segment[] = [];
  for (const pb of ctx.model.boards.values()) {
    const rails = pb.def.rails;
    const matching = rails.filter((r) => r.marking === want);
    for (const rail of matching.length ? matching : rails) {
      for (let i = 0; i < rail.segments.length; i++) {
        const group = `${rail.id}_s${i + 1}`;
        const names = pb.resolved.groups.get(group) ?? [];
        if (!names.length) continue;
        const key = `${pb.instance.id}:${group}`;
        if (!segmentAvailable(ctx, key, net, holeAddress(pb.instance.id, names[0]!))) continue;
        const free: Tap[] = [];
        for (const n of names) {
          const addr = holeAddress(pb.instance.id, n);
          if (!isFreeHole(ctx, addr)) continue;
          const t = holeTap(ctx, addr);
          if (t) free.push(t);
        }
        const inNet = net.segments.has(key);
        if (free.length < (inNet ? 1 : 2)) continue;
        out.push({ key, board: pb, free, inNet });
      }
    }
  }
  return out;
}

function closestPair(a: Tap[], b: Tap[]): { from: Tap; to: Tap; d: number } | null {
  let best: { from: Tap; to: Tap; d: number } | null = null;
  for (const x of a) {
    for (const y of b) {
      const d = manhattan(x.global, y.global);
      if (!best || d < best.d) best = { from: x, to: y, d };
    }
  }
  return best;
}

interface RailChoice {
  segment: Segment;
  /** Segments to bring the net through first, in order (empty when already reachable). */
  hops: Segment[];
  reach_um: number;
}

/**
 * Shortest "distribution" path from the net to each candidate rail segment:
 * one hop is a feeder (host group/terminal → rail) or a bridge (rail → rail
 * across a break or onto another board). Returns, per segment, the hops and
 * the estimated wire length needed to reach it.
 */
function railReach(ctx: Ctx, net: NetPlan, segments: Segment[]): Map<string, RailChoice> {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const byKey = new Map(segments.map((s) => [s.key, s]));
  const pending = new Set<string>();
  for (const s of segments) {
    if (s.inNet) {
      dist.set(s.key, 0);
      prev.set(s.key, null);
    } else {
      const p = closestPair(net.taps, s.free);
      dist.set(s.key, p ? p.d : Infinity);
      prev.set(s.key, null);
    }
    pending.add(s.key);
  }
  while (pending.size) {
    let cur: string | null = null;
    for (const k of pending) if (cur === null || dist.get(k)! < dist.get(cur)!) cur = k;
    if (cur === null || dist.get(cur) === Infinity) break;
    pending.delete(cur);
    const a = byKey.get(cur)!;
    for (const k of pending) {
      const b = byKey.get(k)!;
      const p = closestPair(a.free, b.free);
      if (!p) continue;
      const nd = dist.get(cur)! + p.d;
      if (nd < dist.get(k)!) {
        dist.set(k, nd);
        prev.set(k, cur);
      }
    }
  }
  const out = new Map<string, RailChoice>();
  for (const s of segments) {
    const d = dist.get(s.key)!;
    if (d === Infinity) continue;
    const hops: Segment[] = [];
    let k: string | null = s.key;
    while (k) {
      const seg = byKey.get(k)!;
      if (!seg.inNet) hops.unshift(seg);
      k = prev.get(k) ?? null;
    }
    out.set(s.key, { segment: s, hops, reach_um: d });
  }
  return out;
}

/** Bring the net onto `seg` with one feeder/bridge wire from the nearest existing tap. */
function emitHop(ctx: Ctx, net: NetPlan, seg: Segment): boolean {
  const free = seg.free.filter((t) => isFreeHole(ctx, t.address));
  const pair = closestPair(net.taps, free);
  if (!pair) return false;
  // Route the few nearest source taps for real; the closest by Manhattan distance is usually right but not always.
  const sources = nearestBy(net.taps, (t) => manhattan(t.global, pair.to.global), 3);
  const c = bestPair(ctx, sources, free);
  if (!c) return false;
  const kind: AutoWireBridge['kind'] = c.source.segment ? 'bridge' : 'feeder';
  const label = kind === 'feeder' ? `${net.name} 馈线 → ${seg.board.instance.id} 电源轨` : `${net.name} 桥线 → ${seg.board.instance.id} 电源轨`;
  const id = emitWire(ctx, net, c, label);
  absorb(ctx, net, c.source);
  ctx.reserved.add(c.target.address);
  net.segments.add(seg.key);
  ctx.segmentOwner.set(seg.key, net.key);
  for (const t of seg.free) if (isFreeHole(ctx, t.address) && !net.taps.some((x) => x.address === t.address)) net.taps.push(t);
  ctx.bridges.push({ net: net.name, wire_id: id, from: c.source.address, to: c.target.address, kind, route: c.route, length_um: c.length_um });
  return true;
}

/**
 * Connect a power/ground pin through the rails: pick the segment whose
 * (distribution + tap) length is smallest, lay the hops, then the tap.
 */
function connectViaRail(ctx: Ctx, net: NetPlan, sources: Tap[]): Candidate | null {
  const segments = railSegments(ctx, net);
  if (!segments.length) return null;
  const reach = railReach(ctx, net, segments);
  let best: { choice: RailChoice; tap: Candidate; total: number } | null = null;
  for (const choice of reach.values()) {
    const tap = bestPair(ctx, sources, choice.segment.free);
    if (!tap) continue;
    const total = choice.reach_um + tap.cost;
    if (!best || total < best.total) best = { choice, tap, total };
  }
  if (!best) return null;
  for (const hop of best.choice.hops) if (!emitHop(ctx, net, hop)) return null;
  // Re-route the tap after the hops: they may have taken holes or added obstacles.
  const free = best.choice.segment.free.filter((t) => isFreeHole(ctx, t.address));
  return bestPair(ctx, sources, free);
}

// ---------------------------------------------------------------------------
// Connecting one pin
// ---------------------------------------------------------------------------

/** A peripheral pin waiting to be connected: its net and the holes/terminal it can be wired from. */
interface Member {
  pc: PlacedComponent;
  pin: PlacedPin;
  key: string;
  net: NetPlan;
  sources: Tap[];
}

/** Free holes of the pin's group (nearest first), or the cable terminal itself. */
function sourcesFor(ctx: Ctx, pc: PlacedComponent, pin: PlacedPin): Tap[] | AutoWireSkip {
  const key = pinKey(pc.instance.id, pin.name);
  if (pin.hole) {
    const sources = accessibleHolesForPin(ctx.model, pc.instance.id, pin.name)
      .filter((h) => !ctx.reserved.has(h))
      .map((h) => holeTap(ctx, h))
      .filter((t): t is Tap => !!t);
    if (!sources.length) {
      return { component: pc.instance.id, pin: pin.name, code: 'no_free_hole', reason: `引脚 ${key} 所在孔组没有空闲孔（被引脚占用、板体遮挡或已插线）`, suggestion: '移动元件使该引脚落在有空闲孔的列上，或手动改接。' };
    }
    return sources;
  }
  if (terminalWired(ctx, key)) return { component: pc.instance.id, pin: pin.name, code: 'terminal_in_use', reason: `端子 ${key} 已经接有导线，但没有与主板 ${ctx.host.instance.id} 导通`, suggestion: '一个线缆端子只接一根线：删除旧线，或保留现有连接并忽略此项。' };
  return [terminalTap(ctx, pc, pin)];
}

function recordConnection(ctx: Ctx, m: Member, c: Candidate): void {
  const id = emitWire(ctx, m.net, c, `${m.net.name}: ${m.key}`);
  takeTap(ctx, m.net, c.target);
  if (c.source.ep.hole) {
    ctx.reserved.add(c.source.address);
    addGroupTaps(ctx, m.net, c.source.address);
  } else ctx.usedTerminals.add(c.source.address);
  const via: AutoWireVia = c.target.ep.terminal ? 'terminal' : c.target.segment ? 'rail' : 'group';
  m.net.members.push(m.key);
  ctx.connections.push({ component: m.pc.instance.id, pin: m.pin.name, role: m.pin.meta.role, net: m.net.name, host_pin: m.net.hostPin, wire_id: id, from: c.source.address, to: c.target.address, via, color: m.net.color, route: c.route, length_um: c.length_um });
}

function noTap(ctx: Ctx, m: Member): AutoWireSkip {
  return {
    component: m.pc.instance.id,
    pin: m.pin.name,
    code: 'net_no_free_tap',
    reason: `网络 ${m.net.name}（主板 ${ctx.host.instance.id}.${m.net.hostPin}）没有可用的空闲孔或端子`,
    suggestion: '给主板引脚所在列腾出空闲孔，或先手动把该网络引到电源轨。'
  };
}

function wantRail(ctx: Ctx, net: NetPlan): boolean {
  return (net.kind === 'ground' || net.kind === 'power') && (ctx.req.power_distribution ?? 'auto') !== 'direct';
}

/** Greedy connection of one member: nearest-first, given everything planned so far. */
function connectMember(ctx: Ctx, m: Member): AutoWireSkip | null {
  const sources = m.sources.filter((t) => !t.ep.hole || !ctx.reserved.has(t.address));
  if (!sources.length) return noTap(ctx, m);
  let chosen: Candidate | null = null;
  if (wantRail(ctx, m.net)) chosen = connectViaRail(ctx, m.net, sources);
  if (!chosen) chosen = bestPair(ctx, sources, m.net.taps);
  if (!chosen) return noTap(ctx, m);
  recordConnection(ctx, m, chosen);
  return null;
}

// ---------------------------------------------------------------------------
// Which host pin / net a peripheral pin belongs to
// ---------------------------------------------------------------------------

function hostPinsByRole(host: PlacedComponent, roles: PinRole[]): PlacedPin[] {
  return host.pins.filter((p) => roles.includes(p.meta.role));
}

function hostPinInUse(ctx: Ctx, pin: PlacedPin): boolean {
  const key = pinKey(ctx.host.instance.id, pin.name);
  if (ctx.plannedGpios.has(key)) return true;
  const net = ctx.conn.netByRoot.get(ctx.conn.full.find(key));
  if (!net) return false;
  return net.pins.length > 1 || net.wires.length > 0;
}

function allocateGpio(ctx: Ctx, pc: PlacedComponent, pin: PlacedPin): { pin: PlacedPin; avoided: boolean } | AutoWireSkip {
  const key = pinKey(pc.instance.id, pin.name);
  const explicit = ctx.req.signal_pins?.[key];
  if (explicit) {
    const hp = pinOf(ctx.host, explicit);
    if (!hp) throw new AutoWireError(`signal_pins：主板 ${ctx.host.instance.id} 没有引脚 "${explicit}"`);
    if (!['gpio', 'analog', 'signal_in', 'signal_out', 'i2c_sda', 'i2c_scl'].includes(hp.meta.role)) throw new AutoWireError(`signal_pins：${ctx.host.instance.id}.${explicit} 的角色是 ${hp.meta.role}，不能作为信号引脚`);
    ctx.plannedGpios.add(pinKey(ctx.host.instance.id, hp.name));
    return { pin: hp, avoided: false };
  }
  const preferAnalog = pin.meta.role === 'analog';
  const pool = [...hostPinsByRole(ctx.host, preferAnalog ? ['analog'] : ['gpio']), ...hostPinsByRole(ctx.host, preferAnalog ? ['gpio'] : ['analog'])];
  const usable = pool.filter((p) => p.meta.auto_wire !== 'skip' && !hostPinInUse(ctx, p));
  // Among equally usable pins prefer one whose group still has a free hole, and one close to the peripheral.
  const rank = (p: PlacedPin) => {
    const free = p.hole ? accessibleHolesForPin(ctx.model, ctx.host.instance.id, p.name).some((h) => !ctx.reserved.has(h)) : true;
    return (free ? 0 : 1_000_000) + manhattan(p.global_um, pin.global_um);
  };
  const normal = usable.filter((p) => p.meta.auto_wire !== 'avoid').sort((a, b) => rank(a) - rank(b));
  const fallback = usable.filter((p) => p.meta.auto_wire === 'avoid').sort((a, b) => rank(a) - rank(b));
  const chosen = normal[0] ?? fallback[0];
  if (!chosen) {
    return { component: pc.instance.id, pin: pin.name, code: 'host_no_free_gpio', reason: `主板 ${ctx.host.instance.id} 没有空闲的 GPIO 可分配给 ${key}`, suggestion: '释放一个 GPIO，或用 signal_pins 指定引脚。' };
  }
  ctx.plannedGpios.add(pinKey(ctx.host.instance.id, chosen.name));
  return { pin: chosen, avoided: normal.length === 0 };
}

function hostVoltages(host: PlacedComponent): Map<number, PlacedPin[]> {
  const m = new Map<number, PlacedPin[]>();
  for (const p of host.pins) {
    if (p.meta.role !== 'power_out' || typeof p.meta.voltage_v !== 'number') continue;
    m.set(p.meta.voltage_v, [...(m.get(p.meta.voltage_v) ?? []), p]);
  }
  return m;
}

function pickHostPin(ctx: Ctx, candidates: PlacedPin[]): PlacedPin {
  // Prefer a pin that still has free holes in its group (or a free terminal).
  for (const p of candidates) {
    if (p.hole ? accessibleHolesForPin(ctx.model, ctx.host.instance.id, p.name).some((h) => !ctx.reserved.has(h)) : !terminalWired(ctx, pinKey(ctx.host.instance.id, p.name))) return p;
  }
  return candidates[0]!;
}

function groundNet(ctx: Ctx): NetPlan | AutoWireSkip {
  const grounds = hostPinsByRole(ctx.host, ['ground']);
  if (!grounds.length) return { component: ctx.host.instance.id, pin: '', code: 'host_no_ground', reason: `主板 ${ctx.host.instance.id} 没有 GND 引脚` };
  return netFor(ctx, 'GND', () => ({ key: 'GND', name: 'GND', kind: 'ground', hostPin: pickHostPin(ctx, grounds).name, color: 'black' }));
}

function powerNet(ctx: Ctx, pc: PlacedComponent, pin: PlacedPin): NetPlan | AutoWireSkip {
  const key = pinKey(pc.instance.id, pin.name);
  const volts = hostVoltages(ctx.host);
  if (!volts.size) return { component: pc.instance.id, pin: pin.name, code: 'host_no_power', reason: `主板 ${ctx.host.instance.id} 没有带电压标注的电源输出引脚` };
  const available = [...volts.keys()].sort((a, b) => a - b);
  const nominal = typeof pin.meta.voltage_v === 'number' ? pin.meta.voltage_v : null;
  const range = nominal !== null ? { min: nominal - 0.05, max: nominal + 0.05 } : supplyRange(pc);
  let chosen: number | null = null;
  const fits = (v: number) => !range || (v >= range.min && v <= range.max);
  const preferred = ctx.req.supply_voltage_v;
  if (preferred !== undefined) {
    if (!volts.has(preferred)) throw new AutoWireError(`主板 ${ctx.host.instance.id} 没有 ${voltageName(preferred)} 输出（可用：${available.map(voltageName).join(', ')}）`);
    if (fits(preferred)) chosen = preferred;
  }
  if (chosen === null && range) {
    const ok = available.filter(fits);
    chosen = ok.includes(3.3) ? 3.3 : (ok[0] ?? null);
    if (chosen === null) {
      return { component: pc.instance.id, pin: pin.name, code: 'supply_mismatch', reason: `${key} 允许 ${range.min.toFixed(2)}–${range.max.toFixed(2)} V，主板只有 ${available.map(voltageName).join('/')}`, suggestion: '使用电源模块或电平/电压转换后手动接线。' };
    }
  }
  if (chosen === null) {
    // Range unknown: fall back to 3.3 V (or the only supply) and flag it.
    chosen = available.includes(3.3) ? 3.3 : available.length === 1 ? available[0]! : null;
    if (chosen === null) return { component: pc.instance.id, pin: pin.name, code: 'supply_ambiguous', reason: `${key} 的供电范围未知，而主板有多种电压（${available.map(voltageName).join('/')}）`, suggestion: '在 config.supply_voltage_v 填写范围，或用 supply_voltage_v 选项指定。' };
    ctx.results.push({
      severity: 'needs_review',
      code: 'auto_wire_supply_assumed',
      category: 'evidence',
      message: `${key} 的允许供电范围未知，自动布线按 ${voltageName(chosen)} 接到 ${ctx.host.instance.id}`,
      objects: [pc.instance.id],
      endpoints: [key],
      blocking: false,
      suggestion: '查阅模块资料后在 config.supply_voltage_v 填写范围。'
    });
  }
  const name = voltageName(chosen);
  const pins = volts.get(chosen)!;
  return netFor(ctx, `V${chosen}`, () => ({ key: `V${chosen}`, name, kind: 'power', hostPin: pickHostPin(ctx, pins).name, color: chosen === 5 ? 'orange' : 'red' }));
}

function i2cNet(ctx: Ctx, which: 'sda' | 'scl', busIndex = 0): NetPlan | null {
  const bus = ctx.i2c.buses.find((b) => b.index === busIndex);
  let name: string | undefined = bus ? (which === 'sda' ? bus.sda : bus.scl) : undefined;
  if (!name && busIndex === 0) name = ctx.host.pins.find((p) => p.meta.role === (which === 'sda' ? 'i2c_sda' : 'i2c_scl'))?.name;
  if (!name) return null;
  const label = `${which.toUpperCase()}${busIndex ? busIndex : ''}`;
  return netFor(ctx, label, () => ({ key: label, name: label, kind: 'i2c', hostPin: name!, color: which === 'sda' ? 'blue' : 'yellow' }));
}

// ---------------------------------------------------------------------------
// I²C bus assignment (address conflicts)
// ---------------------------------------------------------------------------

interface BusPlan {
  index: number;
  sda: string;
  scl: string;
  addresses: Set<number>;
  devices: string[];
  added: boolean;
}

interface I2cAssignment {
  buses: BusPlan[];
  /** component id → bus index */
  busOf: Map<string, number>;
  /** component id → why it could not get a bus */
  conflicts: Map<string, AutoWireSkip>;
}

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Free host GPIOs for a new bus: ordinary pins before `avoid` ones, nearest to `near` first. */
function pickFreeGpios(ctx: Ctx, count: number, near: PointUm): PlacedPin[] {
  const pool = hostPinsByRole(ctx.host, ['gpio']).filter((p) => p.meta.auto_wire !== 'skip' && !hostPinInUse(ctx, p));
  const byDistance = (a: PlacedPin, b: PlacedPin) => manhattan(a.global_um, near) - manhattan(b.global_um, near);
  const ordered = [...pool.filter((p) => p.meta.auto_wire !== 'avoid').sort(byDistance), ...pool.filter((p) => p.meta.auto_wire === 'avoid').sort(byDistance)];
  const picked = ordered.slice(0, count);
  if (picked.length < count) return [];
  for (const p of picked) ctx.plannedGpios.add(pinKey(ctx.host.instance.id, p.name));
  return picked;
}

/**
 * Give every I²C peripheral a bus whose known addresses do not collide with
 * it. Runs before classification so nets and GPIO allocation see the result.
 */
function assignI2cBuses(ctx: Ctx, peripherals: PlacedComponent[]): void {
  const hostI2c = ctx.host.def.electrical.i2c;
  const declared = i2cBuses(ctx.host);
  if (!declared.length) return;
  const buses: BusPlan[] = declared.map((b) => ({ index: b.index, sda: b.sda, scl: b.scl, addresses: new Set(), devices: [], added: false }));
  // Addresses already present on each bus (devices wired earlier).
  for (const pc of ctx.model.components.values()) {
    if (pc === ctx.host || pc.def.category === 'mcu') continue;
    const pins = i2cPins(pc);
    if (!pins) continue;
    const sdaRoot = ctx.conn.full.find(pinKey(pc.instance.id, pins.sda));
    const sclRoot = ctx.conn.full.find(pinKey(pc.instance.id, pins.scl));
    for (const b of buses) {
      if (ctx.conn.full.find(pinKey(ctx.host.instance.id, b.sda)) === sdaRoot && ctx.conn.full.find(pinKey(ctx.host.instance.id, b.scl)) === sclRoot) {
        const addr = i2cAddress(pc);
        if (addr !== null) b.addresses.add(addr);
      }
    }
  }
  const policy = ctx.req.i2c_conflicts ?? 'bus_first';
  const maxBuses = typeof hostI2c?.controllers === 'number' ? hostI2c.controllers : 1;
  const extraConfig: JsonValue[] = Array.isArray(ctx.host.resolved.config.i2c_buses) ? [...(ctx.host.resolved.config.i2c_buses as JsonValue[])] : [];
  for (const pc of peripherals) {
    if (pc.def.category === 'mcu' || pc.instance.locked) continue;
    const pins = i2cPins(pc);
    if (!pins) continue;
    if (connectedHostPin(ctx, pinKey(pc.instance.id, pins.sda))) continue;
    const addr = i2cAddress(pc);
    const fits = (b: BusPlan, a: number | null) => a === null || !b.addresses.has(a);
    let bus = buses.find((b) => fits(b, addr)) ?? null;
    let effective = addr;
    const conflictWith = addr === null ? [] : buses.map((b) => b.devices.filter((d) => i2cAddress(ctx.model.components.get(d)!) === addr)).flat();
    const openBus = (): BusPlan | null => {
      if (buses.length >= maxBuses || !hostI2c?.mappable || ctx.host.instance.locked) return null;
      const [sda, scl] = pickFreeGpios(ctx, 2, centre(pc));
      if (!sda || !scl) return null;
      const created: BusPlan = { index: buses.length, sda: sda.name, scl: scl.name, addresses: new Set(), devices: [], added: true };
      buses.push(created);
      extraConfig.push({ sda: sda.name, scl: scl.name });
      ctx.configOps = ctx.configOps.filter((o) => !(o.op === 'update_property' && o.id === ctx.host.instance.id && o.path === 'config.i2c_buses'));
      ctx.configOps.push({ op: 'update_property', id: ctx.host.instance.id, path: 'config.i2c_buses', value: [...extraConfig] });
      ctx.configChanges.push({ id: ctx.host.instance.id, path: 'config.i2c_buses', value: [...extraConfig], reason: `启用第 ${created.index + 1} 条 I²C 总线（SDA=${sda.name}, SCL=${scl.name}）以避免地址冲突` });
      ctx.results.push({
        severity: 'needs_review',
        code: 'auto_wire_i2c_bus_added',
        category: 'interface',
        message: `${pc.instance.id} 的地址 ${addr === null ? '未知' : hex(addr)} 在现有总线上已被占用，自动布线在 ${ctx.host.instance.id} 上启用第 ${created.index + 1} 条 I²C 总线：SDA=${sda.name}、SCL=${scl.name}`,
        objects: [ctx.host.instance.id, pc.instance.id],
        endpoints: [pinKey(ctx.host.instance.id, sda.name), pinKey(ctx.host.instance.id, scl.name)],
        blocking: false,
        suggestion: `固件需另建总线（如 Wire1.begin(${sda.name.replace(/^GPIO|^D/, '')}, ${scl.name.replace(/^GPIO|^D/, '')})）；确认这两个 GPIO 在你的板子上可用。`
      });
      return created;
    };
    const switchAddress = (): BusPlan | null => {
      const options = (pc.def.electrical.i2c?.address_options ?? []).filter((o) => o !== addr);
      for (const b of buses) {
        for (const o of options) {
          if (b.addresses.has(o)) continue;
          effective = o;
          ctx.configOps.push({ op: 'update_property', id: pc.instance.id, path: 'config.i2c_address', value: o });
          ctx.configChanges.push({ id: pc.instance.id, path: 'config.i2c_address', value: o, reason: `与 ${conflictWith.join('、') || '同总线器件'} 地址相同（${addr === null ? '未知' : hex(addr)}），改用地址选项 ${hex(o)}` });
          ctx.results.push({
            severity: 'needs_review',
            code: 'auto_wire_i2c_address_changed',
            category: 'interface',
            message: `${pc.instance.id} 与 ${conflictWith.join('、') || '同总线器件'} 地址相同，自动布线在设计中把它改为 ${hex(o)}（config.i2c_address）`,
            objects: [pc.instance.id],
            blocking: false,
            suggestion: `请把模块的地址跳线/电阻改到 ${hex(o)}，并在固件里使用该地址；否则实物仍会冲突。`
          });
          return b;
        }
      }
      return null;
    };
    if (!bus && policy !== 'report') bus = policy === 'bus_first' ? openBus() ?? switchAddress() : switchAddress() ?? openBus();
    if (!bus) {
      ctx.i2c.conflicts.set(pc.instance.id, {
        component: pc.instance.id,
        pin: '',
        code: 'i2c_address_conflict',
        reason: `与 ${conflictWith.join('、') || '已接线的器件'} 的 I²C 地址相同（${addr === null ? '未知' : hex(addr)}）：${policy === 'report' ? '按设置只报告不处理' : `${ctx.host.instance.id} 没有空闲的 I²C 总线，且该模块没有可用的其他地址`}`,
        suggestion: '加 I²C 多路复用器（如 TCA9548A）、换用不同地址的模块，或用 i2c_conflicts 选项允许自动改地址/开新总线。'
      });
      continue;
    }
    if (effective !== null) bus.addresses.add(effective);
    bus.devices.push(pc.instance.id);
    ctx.i2c.busOf.set(pc.instance.id, bus.index);
  }
  ctx.i2c.buses = buses;
}

function signalNet(ctx: Ctx, pc: PlacedComponent, pin: PlacedPin): NetPlan | AutoWireSkip {
  const alloc = allocateGpio(ctx, pc, pin);
  if ('code' in alloc) return alloc;
  const key = pinKey(pc.instance.id, pin.name);
  if (alloc.avoided) {
    ctx.results.push({
      severity: 'needs_review',
      code: 'auto_wire_avoid_pin_used',
      category: 'evidence',
      message: `${key} 被分配到 ${ctx.host.instance.id}.${alloc.pin.name}（${alloc.pin.meta.notes ?? '目录建议避免自动使用'}），因为没有其他空闲 GPIO`,
      objects: [ctx.host.instance.id, pc.instance.id],
      endpoints: [key, pinKey(ctx.host.instance.id, alloc.pin.name)],
      blocking: false,
      suggestion: '确认该引脚在你的固件里可用，或用 signal_pins 指定别的引脚。'
    });
  }
  const name = `${pc.instance.id}_${pin.name}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const color = SIGNAL_COLORS[ctx.signalColor++ % SIGNAL_COLORS.length]!;
  return netFor(ctx, `S:${key}`, () => ({ key: `S:${key}`, name, kind: 'signal', hostPin: alloc.pin.name, color }));
}

function hostHasSignals(ctx: Ctx): boolean {
  return ctx.host.pins.some((p) => ['gpio', 'analog', 'i2c_sda', 'i2c_scl', 'signal_in', 'signal_out'].includes(p.meta.role));
}

/** Which host pin (if any) is already electrically tied to this peripheral pin. */
function connectedHostPin(ctx: Ctx, key: string): string | null {
  const root = ctx.conn.full.find(key);
  for (const p of ctx.host.pins) if (ctx.conn.full.find(pinKey(ctx.host.instance.id, p.name)) === root) return p.name;
  return null;
}

/** Decide which net a peripheral pin belongs to (or record why it is skipped / cannot be wired). */
function classifyPin(ctx: Ctx, pc: PlacedComponent, pin: PlacedPin): Member | null {
  const key = pinKey(pc.instance.id, pin.name);
  const meta = pin.meta;
  const skip = (code: string, reason: string, suggestion?: string): null => {
    ctx.skipped.push({ component: pc.instance.id, pin: pin.name, code, reason, ...(suggestion ? { suggestion } : {}) });
    return null;
  };
  if (pin.kind === 'pad') return skip('pin_pad', `${key} 是焊盘，不自动接线`);
  if (meta.auto_wire === 'skip') return skip('pin_skip_hint', `${key} 在目录中标记为不自动接线${meta.notes ? `（${meta.notes}）` : ''}`);
  if (meta.role === 'nc') return skip('pin_nc', `${key} 为 NC（不连接）`);
  if (meta.role === 'passive') return skip('pin_passive', `${key} 是无源元件引脚，自动布线不知道它应接到哪个网络`, '手动接线，或在 net_intents 里声明后用普通 add_wire。');
  if (meta.role === 'power_out') return skip('peripheral_power_out', `${key} 是电源输出，不会自动与主板电源并联`, '如需外部供电，请把电源模块作为主板单独执行自动布线。');
  if (pc.def.category === 'mcu' && meta.role !== 'ground' && meta.auto_wire !== 'to_ground') {
    return skip('peripheral_is_controller', `${pc.instance.id} 也是主控板，只自动共地；它的 ${pin.name}（${meta.role}）不会与 ${ctx.host.instance.id} 互连`, '两块主控之间的信号线请手动接，或分别以各自为主板布线。');
  }
  const existing = connectedHostPin(ctx, key);
  if (existing) return skip('already_connected', `${key} 已经与 ${ctx.host.instance.id}.${existing} 导通`);
  let net: NetPlan | AutoWireSkip | null;
  if (meta.auto_wire === 'to_ground' || meta.role === 'ground') net = groundNet(ctx);
  else if (meta.auto_wire === 'to_power' || meta.role === 'power_in') net = powerNet(ctx, pc, pin);
  else if (['i2c_sda', 'i2c_scl', 'signal_out', 'signal_in', 'gpio', 'analog'].includes(meta.role) && !hostHasSignals(ctx)) {
    return skip('host_power_only', `主板 ${ctx.host.instance.id} 没有 GPIO/I²C 引脚，只能自动连接电源和地`, '信号线请以主控板为主板再执行自动布线。');
  } else if (meta.role === 'i2c_sda' || meta.role === 'i2c_scl') {
    const conflict = ctx.i2c.conflicts.get(pc.instance.id);
    if (conflict) {
      ctx.unresolved.push({ ...conflict, pin: pin.name });
      return null;
    }
    net = i2cNet(ctx, meta.role === 'i2c_sda' ? 'sda' : 'scl', ctx.i2c.busOf.get(pc.instance.id) ?? 0);
    if (!net) {
      ctx.unresolved.push({ component: pc.instance.id, pin: pin.name, code: 'host_no_i2c', reason: `主板 ${ctx.host.instance.id} 没有 I²C（SDA/SCL）引脚定义`, suggestion: '在主板 config.i2c_sda_pin / i2c_scl_pin 指定，或手动接线。' });
      return null;
    }
  } else if (['signal_out', 'signal_in', 'gpio', 'analog'].includes(meta.role)) net = signalNet(ctx, pc, pin);
  else {
    ctx.unresolved.push({ component: pc.instance.id, pin: pin.name, code: 'pin_role_unknown', reason: `${key} 的引脚角色未知，无法决定接到哪里`, suggestion: '在元件定义 pin_meta 中填写 role。' });
    return null;
  }
  if ('code' in net) {
    ctx.unresolved.push(net.pin ? net : { ...net, component: pc.instance.id, pin: pin.name });
    return null;
  }
  const sources = sourcesFor(ctx, pc, pin);
  if ('code' in sources) {
    ctx.unresolved.push(sources);
    return null;
  }
  return { pc, pin, key, net, sources };
}

/** Classify every pin of every peripheral: nearest peripheral first, ground → power → signals within a component. */
function classifyAll(ctx: Ctx, peripherals: PlacedComponent[]): Member[] {
  const members: Member[] = [];
  assignI2cBuses(ctx, peripherals);
  for (const pc of peripherals) {
    if (pc.instance.locked) {
      ctx.skipped.push({ component: pc.instance.id, pin: '', code: 'component_locked', reason: `元件 ${pc.instance.id} 已锁定，跳过` });
      continue;
    }
    const order = (p: PlacedPin) => (p.meta.role === 'ground' || p.meta.auto_wire === 'to_ground' ? 0 : p.meta.role === 'power_in' || p.meta.auto_wire === 'to_power' ? 1 : 2);
    const pins = [...pc.pins].sort((a, b) => order(a) - order(b));
    for (const pin of pins) {
      const m = classifyPin(ctx, pc, pin);
      if (m) {
        ctx.memberOrder.set(m.key, members.length);
        members.push(m);
      }
    }
  }
  return members;
}

// ---------------------------------------------------------------------------
// Global optimisation
// ---------------------------------------------------------------------------
//
// The greedy planner decides one pin at a time. The global planner instead
// decides each net as a whole under one objective (Σ routed length + bend and
// Dupont penalties + a per-wire cost):
//
//   1. Signal/I²C nets (and power nets in `direct` mode): nodes are the host
//      taps plus every member pin; every spanning tree over the nodes is
//      enumerated (Prüfer sequences, ≤ 7 nodes) with hole capacities per node,
//      costed with the design-only obstacle router. Larger nets use Prim's
//      greedy tree.
//   2. Power/ground nets: rail segments are facilities. Every subset of the
//      candidate segments is enumerated; a subset costs its activation (MST of
//      feeders/bridges from the host onto the segments) plus each member's
//      cheapest tap onto an active segment.
//   3. The chosen links are then routed in sequence with all earlier hard
//      jumpers as obstacles. Because order changes detours, detoured jumpers
//      are ripped up and moved earlier (and re-holed) while that lowers the
//      total, within a time budget.
//
// The result replaces the greedy plan only when its objective is lower.

interface Link {
  net: NetPlan;
  member: Member | null;
  /** Distribution hop (feeder/bridge) onto a rail segment. */
  hop: { kind: 'feeder' | 'bridge'; segment: Segment } | null;
  /** Candidate holes on each side; the first entries are the preferred pair from the net-level search. */
  sources: Tap[];
  targets: Tap[];
}

interface Routed {
  link: Link;
  c: Candidate;
}

interface PairCost {
  a: Tap;
  b: Tap;
  cost: number;
}

/** Sorted candidate hole pairs between two node candidate sets, costed against design-only obstacles. */
function pairCosts(ctx: Ctx, est: Estimator, as: Tap[], bs: Tap[]): PairCost[] {
  const out: PairCost[] = [];
  for (const a of as) for (const b of bs) out.push({ a, b, cost: estimate(ctx, est, a, b).cost });
  out.sort((x, y) => x.cost - y.cost);
  return out;
}

function decodePrufer(seq: number[], n: number): [number, number][] {
  const degree = new Array<number>(n).fill(1);
  for (const v of seq) degree[v]!++;
  const edges: [number, number][] = [];
  for (const v of seq) {
    for (let leaf = 0; leaf < n; leaf++) {
      if (degree[leaf] === 1) {
        edges.push([leaf, v]);
        degree[leaf]!--;
        degree[v]!--;
        break;
      }
    }
  }
  const rest: number[] = [];
  for (let v = 0; v < n; v++) if (degree[v] === 1) rest.push(v);
  edges.push([rest[0]!, rest[1]!]);
  return edges;
}

/** Cost of a tree with capacity-aware hole assignment, or null when a node runs out of holes. */
function treeCost(edges: [number, number][], pairs: Map<string, PairCost[]>, capacity: number[]): { cost: number; picks: { i: number; j: number; pair: PairCost }[] } | null {
  const degree = new Array<number>(capacity.length).fill(0);
  for (const [i, j] of edges) {
    degree[i]!++;
    degree[j]!++;
    if (degree[i]! > capacity[i]! || degree[j]! > capacity[j]!) return null;
  }
  const keyed = edges.map(([i, j]) => ({ i: Math.min(i, j), j: Math.max(i, j) })).map((e) => ({ ...e, list: pairs.get(`${e.i}:${e.j}`) ?? [] }));
  keyed.sort((x, y) => (x.list[0]?.cost ?? Infinity) - (y.list[0]?.cost ?? Infinity));
  const used = new Set<string>();
  const picks: { i: number; j: number; pair: PairCost }[] = [];
  let cost = 0;
  for (const e of keyed) {
    const pair = e.list.find((p) => !used.has(p.a.address) && !used.has(p.b.address));
    if (!pair) return null;
    used.add(pair.a.address);
    used.add(pair.b.address);
    picks.push({ i: e.i, j: e.j, pair });
    cost += pair.cost + WIRE_COST_UM;
  }
  return { cost, picks };
}

/** Best tree over host taps + members. Exhaustive for small nets, Prim otherwise. */
function planTreeGlobal(ctx: Ctx, est: Estimator, net: NetPlan, members: Member[], notes: string[], deadline: number): { links: Link[]; exhaustive: boolean } {
  const centreOf = (taps: Tap[]): PointUm => [taps.reduce((n, t) => n + t.global[0], 0) / taps.length, taps.reduce((n, t) => n + t.global[1], 0) / taps.length];
  const memberCentre = centreOf(members.map((m) => m.sources[0]!));
  const hostTaps = nearestBy(net.taps, (t) => manhattan(t.global, memberCentre), 8);
  if (!hostTaps.length) return { links: [], exhaustive: true };
  const nodes: Tap[][] = [hostTaps, ...members.map((m) => m.sources)];
  const capacity = nodes.map((taps, i) => (i === 0 ? net.taps.length : taps.filter((t) => !!t.ep.hole).length || 1));
  const n = nodes.length;
  const pairs = new Map<string, PairCost[]>();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.set(`${i}:${j}`, pairCosts(ctx, est, nodes[i]!, nodes[j]!));

  let best: { cost: number; picks: { i: number; j: number; pair: PairCost }[] } | null = null;
  let exhaustive = false;
  if (n === 2) {
    best = treeCost([[0, 1]], pairs, capacity);
    exhaustive = true;
  } else if (n <= EXHAUSTIVE_TREE_NODES) {
    const seq = new Array<number>(n - 2).fill(0);
    let count = 0;
    let complete = true;
    for (;;) {
      const t = treeCost(decodePrufer(seq, n), pairs, capacity);
      count++;
      if (t && (!best || t.cost < best.cost)) best = t;
      let k = n - 3;
      while (k >= 0 && seq[k] === n - 1) seq[k--] = 0;
      if (k < 0) break;
      seq[k]!++;
      if ((count & 1023) === 0 && performance.now() > deadline) {
        complete = false;
        break;
      }
    }
    exhaustive = complete;
    notes.push(`${net.name}：${n} 个节点，${complete ? '穷举' : '时限内枚举'} ${count} 棵生成树`);
  }
  if (!best) {
    // Prim: grow from the host, always adding the cheapest feasible link.
    const inTree = new Set<number>([0]);
    const used = new Set<string>();
    const degree = new Array<number>(n).fill(0);
    const picks: { i: number; j: number; pair: PairCost }[] = [];
    let cost = 0;
    while (inTree.size < n) {
      let bestPick: { i: number; j: number; pair: PairCost } | null = null;
      for (const i of inTree) {
        if (degree[i]! >= capacity[i]!) continue;
        for (let j = 0; j < n; j++) {
          if (inTree.has(j) || degree[j]! >= capacity[j]!) continue;
          const list = pairs.get(`${Math.min(i, j)}:${Math.max(i, j)}`) ?? [];
          const pair = list.find((p) => !used.has(p.a.address) && !used.has(p.b.address));
          if (pair && (!bestPick || pair.cost < bestPick.pair.cost)) bestPick = { i: Math.min(i, j), j: Math.max(i, j), pair };
        }
      }
      if (!bestPick) break;
      inTree.add(bestPick.i);
      inTree.add(bestPick.j);
      degree[bestPick.i]!++;
      degree[bestPick.j]!++;
      used.add(bestPick.pair.a.address);
      used.add(bestPick.pair.b.address);
      picks.push(bestPick);
      cost += bestPick.pair.cost + WIRE_COST_UM;
    }
    best = { cost, picks };
    if (n > EXHAUSTIVE_TREE_NODES) notes.push(`${net.name}：${n} 个节点，超过穷举上限，使用最小生成树启发式`);
    exhaustive = false;
  }
  // Orient each edge so that `member` is the node further from the host (the pin being connected).
  const links: Link[] = [];
  const depth = new Map<number, number>([[0, 0]]);
  const adjacency = new Map<number, { j: number; pick: { i: number; j: number; pair: PairCost } }[]>();
  for (const pick of best.picks) {
    adjacency.set(pick.i, [...(adjacency.get(pick.i) ?? []), { j: pick.j, pick }]);
    adjacency.set(pick.j, [...(adjacency.get(pick.j) ?? []), { j: pick.i, pick }]);
  }
  const queue = [0];
  while (queue.length) {
    const u = queue.shift()!;
    for (const { j: v, pick } of adjacency.get(u) ?? []) {
      if (depth.has(v)) continue;
      depth.set(v, depth.get(u)! + 1);
      queue.push(v);
      // pair.a belongs to the lower-numbered node, pair.b to the higher one.
      const source = v === pick.j ? pick.pair.b : pick.pair.a;
      const target = v === pick.j ? pick.pair.a : pick.pair.b;
      const m = members[v - 1]!;
      links.push({ net, member: m, hop: null, sources: [source, ...m.sources.filter((t) => t.address !== source.address)], targets: [target, ...nodes[u]!.filter((t) => t.address !== target.address)] });
    }
  }
  return { links, exhaustive };
}

interface PowerOption {
  /** Indices (into `segments`) of the active segments. */
  active: number[];
  keys: string[];
  cost: number;
  mst: { from: number; to: number; pair: PairCost }[];
}

interface PowerSearch {
  net: NetPlan;
  members: Member[];
  segments: Segment[];
  options: PowerOption[];
  tap: (PairCost | null)[][];
  exhaustive: boolean;
}

/**
 * Facility-location search over rail segments for one power/ground net: every
 * subset of the candidate segments is costed as activation (MST of
 * feeders/bridges from the host) plus each member's cheapest tap. No side
 * effects; the joint selection across nets happens in `planPowerNets`.
 */
function powerOptions(ctx: Ctx, est: Estimator, net: NetPlan, members: Member[], notes: string[]): PowerSearch | null {
  const all = railSegments(ctx, net);
  if (!all.length) return null;
  const memberTaps = members.map((m) => m.sources[0]!);
  const segDist = (s: Segment) => Math.min(...memberTaps.map((t) => Math.min(...s.free.map((h) => manhattan(h.global, t.global)))));
  const segments = [...all].sort((a, b) => Number(b.inNet) - Number(a.inNet) || segDist(a) - segDist(b)).slice(0, EXHAUSTIVE_RAIL_SEGMENTS);
  const truncated = segments.length < all.length;
  const hopPair = (as: Tap[], bs: Tap[]): PairCost | null => {
    const cp = closestPair(as, bs);
    if (!cp) return null;
    const near = nearestBy(as, (t) => manhattan(t.global, cp.to.global), 3);
    const far = nearestBy(bs, (t) => manhattan(t.global, cp.from.global), 3);
    return pairCosts(ctx, est, near, far)[0] ?? null;
  };
  const S = segments.length;
  const hop: (PairCost | null)[][] = [];
  for (let i = 0; i <= S; i++) {
    hop.push([]);
    for (let j = 0; j <= S; j++) {
      if (i === j) hop[i]!.push(null);
      else if (i === 0) hop[i]!.push(hopPair(net.taps, segments[j - 1]!.free));
      else if (j === 0) hop[i]!.push(hopPair(segments[i - 1]!.free, net.taps));
      else hop[i]!.push(hopPair(segments[i - 1]!.free, segments[j - 1]!.free));
    }
  }
  const tap: (PairCost | null)[][] = members.map((m) => segments.map((s) => pairCosts(ctx, est, m.sources, nearestBy(s.free, (h) => manhattan(h.global, m.sources[0]!.global), 3))[0] ?? null));
  const fixed = segments.map((s) => s.inNet);
  const optional = segments.map((_, i) => i).filter((i) => !fixed[i]);
  const options: PowerOption[] = [];
  for (let mask = 0; mask < 1 << optional.length; mask++) {
    const active = segments.map((_, i) => i).filter((i) => fixed[i] || (mask & (1 << optional.indexOf(i))) !== 0);
    if (!active.length) continue;
    const inTree = new Set<number>([0]);
    const mst: { from: number; to: number; pair: PairCost }[] = [];
    let cost = 0;
    let ok = true;
    while (inTree.size < active.length + 1) {
      let pick: { from: number; to: number; pair: PairCost } | null = null;
      for (const u of inTree) {
        for (const i of active) {
          const v = i + 1;
          if (inTree.has(v)) continue;
          const pc = hop[u]![v];
          if (pc && (!pick || pc.cost < pick.pair.cost)) pick = { from: u, to: v, pair: pc };
        }
      }
      if (!pick) {
        ok = false;
        break;
      }
      inTree.add(pick.to);
      if (!segments[pick.to - 1]!.inNet) {
        mst.push(pick);
        cost += pick.pair.cost + WIRE_COST_UM;
      }
    }
    if (!ok) continue;
    for (let m = 0; m < members.length; m++) {
      let cheapest = Infinity;
      for (const i of active) {
        const t = tap[m]![i];
        if (t && t.cost < cheapest) cheapest = t.cost;
      }
      if (cheapest === Infinity) {
        ok = false;
        break;
      }
      cost += cheapest + WIRE_COST_UM;
    }
    if (ok) options.push({ active, keys: active.map((i) => segments[i]!.key), cost, mst });
  }
  options.sort((a, b) => a.cost - b.cost);
  notes.push(`${net.name}：${S} 段电源轨${truncated ? `（共 ${all.length} 段，只取最近的）` : ''}，枚举 ${options.length} 种可行组合`);
  if (!options.length) return null;
  return { net, members, segments, options, tap, exhaustive: !truncated };
}

/** Links realising one chosen option of a power net. */
function powerLinks(ctx: Ctx, search: PowerSearch, option: PowerOption): Link[] {
  const { net, members, segments, tap } = search;
  const links: Link[] = [];
  for (const e of option.mst) {
    const seg = segments[e.to - 1]!;
    const fromSeg = e.from === 0 ? null : segments[e.from - 1]!;
    const sources = fromSeg ? nearestBy(fromSeg.free, (t) => manhattan(t.global, e.pair.a.global), 4) : nearestBy(net.taps, (t) => manhattan(t.global, e.pair.a.global), 4);
    links.push({ net, member: null, hop: { kind: e.from === 0 && !e.pair.a.segment ? 'feeder' : 'bridge', segment: seg }, sources: [e.pair.a, ...sources.filter((t) => t.address !== e.pair.a.address)], targets: [e.pair.b, ...seg.free.filter((t) => t.address !== e.pair.b.address)] });
  }
  members.forEach((m, mi) => {
    let choice: { i: number; pair: PairCost } | null = null;
    for (const i of option.active) {
      const t = tap[mi]![i];
      if (t && (!choice || t.cost < choice.pair.cost)) choice = { i, pair: t };
    }
    if (!choice) {
      ctx.unresolved.push(noTap(ctx, m));
      return;
    }
    const seg = segments[choice.i]!;
    links.push({ net, member: m, hop: null, sources: [choice.pair.a, ...m.sources.filter((t) => t.address !== choice!.pair.a.address)], targets: [choice.pair.b, ...nearestBy(seg.free.filter((t) => t.address !== choice!.pair.b.address), (t) => manhattan(t.global, m.sources[0]!.global), 5)] });
  });
  for (const key of option.keys) ctx.segmentOwner.set(key, net.key);
  return links;
}

/**
 * Choose one option per power/ground net so that no rail segment is shared
 * between nets, minimising the summed cost (branch and bound over the
 * per-net option lists, which are sorted by cost).
 */
function planPowerNets(ctx: Ctx, searches: PowerSearch[], notes: string[]): { links: Link[]; exhaustive: boolean } {
  let best: { cost: number; picks: PowerOption[] } | null = null;
  let visited = 0;
  const LIMIT = 200_000;
  const picks: PowerOption[] = [];
  const taken = new Set<string>();
  const dfs = (i: number, cost: number): void => {
    if (best && cost >= best.cost) return;
    if (i === searches.length) {
      best = { cost, picks: [...picks] };
      return;
    }
    for (const option of searches[i]!.options) {
      if (++visited > LIMIT) return;
      if (option.keys.some((k) => taken.has(k))) continue;
      for (const k of option.keys) taken.add(k);
      picks.push(option);
      dfs(i + 1, cost + option.cost);
      picks.pop();
      for (const k of option.keys) taken.delete(k);
      if (best && cost + option.cost >= best.cost) break; // options are sorted: nothing cheaper follows
    }
  };
  dfs(0, 0);
  const complete = visited <= LIMIT;
  if (!best) {
    // Could not find a conflict-free combination: fall back to sequential claiming, largest net first.
    const links: Link[] = [];
    for (const s of [...searches].sort((a, b) => b.members.length - a.members.length)) {
      const option = s.options.find((o) => !o.keys.some((k) => ctx.segmentOwner.get(k) && ctx.segmentOwner.get(k) !== s.net.key));
      if (option) links.push(...powerLinks(ctx, s, option));
      else for (const m of s.members) ctx.unresolved.push(noTap(ctx, m));
    }
    notes.push('电源轨：无冲突组合不可行，按网络逐个分配');
    return { links, exhaustive: false };
  }
  const chosen: { cost: number; picks: PowerOption[] } = best;
  if (searches.length > 1) notes.push(`电源轨：${searches.length} 个网络联合选段，检查 ${visited} 种组合${complete ? '' : '（达到上限）'}`);
  const links: Link[] = [];
  searches.forEach((s, i) => links.push(...powerLinks(ctx, s, chosen.picks[i]!)));
  return { links, exhaustive: complete && searches.every((s) => s.exhaustive) };
}

interface Sequence {
  total: number;
  routed: Routed[];
  /** Router state after each prefix length, so a reordering only re-routes from the first changed position. */
  paths: PointUm[][];
  used: Set<string>;
}

/** Route links in the given order; `keep` is a previous sequence whose first `keepCount` links are identical and can be reused. */
function routeSequence(ctx: Ctx, order: Link[], keep?: Sequence, keepCount = 0): Sequence {
  const routed: Routed[] = keep ? keep.routed.slice(0, keepCount) : [];
  const paths = [...ctx.baseFlatPaths, ...routed.filter((r) => r.c.route === 'flat').map((r) => r.c.points)];
  const used = new Set<string>(ctx.reserved);
  for (const r of routed) {
    if (r.c.source.ep.hole) used.add(r.c.source.address);
    if (r.c.target.ep.hole) used.add(r.c.target.address);
  }
  let total = routed.reduce((n, r) => n + r.c.cost + WIRE_COST_UM, 0);
  for (let i = routed.length; i < order.length; i++) {
    const link = order[i]!;
    const sources = link.sources.filter((t) => !t.ep.hole || !used.has(t.address));
    const targets = link.targets.filter((t) => !t.ep.hole || !used.has(t.address));
    if (!sources.length || !targets.length) return { total: Infinity, routed, paths, used };
    let c = evaluate(ctx, sources[0]!, targets[0]!, paths);
    const straight = distance(sources[0]!.global, targets[0]!.global);
    if (c.route === 'flat' && (c.points.length > 3 || c.length_um > straight + 1_000)) {
      // The preferred pair bends or detours: look at a few alternative holes.
      for (const s of sources.slice(0, 3)) {
        for (const t of targets.slice(0, 4)) {
          if (s === sources[0] && t === targets[0]) continue;
          const alt = evaluate(ctx, s, t, paths);
          if (alt.cost < c.cost) c = alt;
        }
      }
    }
    if (c.source.ep.hole) used.add(c.source.address);
    if (c.target.ep.hole) used.add(c.target.address);
    if (c.route === 'flat') paths.push(c.points);
    routed.push({ link, c });
    total += c.cost + WIRE_COST_UM;
  }
  return { total, routed, paths, used };
}

/** A hard jumper that bends more than once or runs clearly longer than its span: worth ripping up. */
function isDetour(c: Candidate): boolean {
  return c.route === 'flat' && (c.points.length > 3 || c.length_um > distance(c.source.global, c.target.global) + 1_000);
}

/** Re-pick holes for every hard jumper in place with the full alternative set; accept each change only if it lowers the total. */
function polish(ctx: Ctx, order: Link[], current: Sequence): Sequence {
  let seq = current;
  for (let i = 0; i < order.length; i++) {
    const r = seq.routed[i]!;
    if (!isDetour(r.c)) continue;
    const link = order[i]!;
    const prefix = routeSequence(ctx, order.slice(0, i), seq, i);
    let best: Candidate | null = null;
    for (const src of link.sources.filter((t) => !t.ep.hole || !prefix.used.has(t.address)).slice(0, 4)) {
      for (const tgt of link.targets.filter((t) => !t.ep.hole || !prefix.used.has(t.address)).slice(0, 6)) {
        const c = evaluate(ctx, src, tgt, prefix.paths);
        if (!best || c.cost < best.cost) best = c;
      }
    }
    if (!best || best.cost >= r.c.cost - 1) continue;
    // Pin the better pair as the preferred one and re-route the suffix.
    const pinned: Link = { ...link, sources: [best.source, ...link.sources.filter((t) => t.address !== best!.source.address)], targets: [best.target, ...link.targets.filter((t) => t.address !== best!.target.address)] };
    const trial = [...order];
    trial[i] = pinned;
    const next = routeSequence(ctx, trial, seq, i);
    if (next.total < seq.total - 1) {
      order[i] = pinned;
      seq = next;
    }
  }
  return seq;
}

/**
 * Rip-up-and-reorder: start from the better of two orders (short jumpers
 * first, or the greedy pin order), then move detoured hard jumpers earlier
 * while the total drops, and finally re-pick holes in place. All within the
 * time budget.
 */
function optimiseOrder(ctx: Ctx, links: Link[], deadline: number, notes: string[]): { routed: Routed[]; converged: boolean } {
  const straightOf = (l: Link) => distance(l.sources[0]!.global, l.targets[0]!.global);
  const hopsFirst = (a: Link, b: Link) => Number(!!b.hop) - Number(!!a.hop);
  const memberIndex = (l: Link) => (l.member ? (ctx.memberOrder.get(l.member.key) ?? 0) : -1);
  const starts: Link[][] = [
    [...links].sort((a, b) => hopsFirst(a, b) || straightOf(a) - straightOf(b)),
    [...links].sort((a, b) => hopsFirst(a, b) || memberIndex(a) - memberIndex(b))
  ];
  let order = starts[0]!;
  let current = routeSequence(ctx, order);
  for (const alt of starts.slice(1)) {
    const r = routeSequence(ctx, alt);
    if (r.total < current.total) {
      order = alt;
      current = r;
    }
  }
  let passes = 0;
  let converged = false;
  const tried = new Set<Link>();
  while (performance.now() < deadline) {
    passes++;
    let improved = false;
    // Worst detours first; a link is ripped up again only after something else improved.
    const detoured = current.routed
      .map((r, index) => ({ r, index, excess: r.c.length_um - distance(r.c.source.global, r.c.target.global) }))
      .filter(({ r, index }) => isDetour(r.c) && !tried.has(order[index]!))
      .sort((a, b) => b.excess - a.excess)
      .slice(0, 8);
    const firstNonHop = Math.max(0, order.findIndex((l) => !l.hop));
    for (const { index } of detoured) {
      const link = order[index]!;
      tried.add(link);
      for (const to of [firstNonHop, Math.max(firstNonHop, index - 1)]) {
        if (to >= index) continue;
        const trial = [...order];
        trial.splice(index, 1);
        trial.splice(to, 0, link);
        const r = routeSequence(ctx, trial, current, to);
        if (r.total < current.total - 1) {
          order = trial;
          current = r;
          improved = true;
          tried.clear();
          break;
        }
        if (performance.now() > deadline) break;
      }
      if (improved || performance.now() > deadline) break;
    }
    if (!improved) {
      converged = performance.now() < deadline || detoured.length === 0;
      break;
    }
  }
  if (performance.now() < deadline) current = polish(ctx, order, current);
  notes.push(`走线顺序：${passes} 轮拆线重排${converged ? '，已收敛' : '，达到时限'}`);
  return { routed: current.routed, converged };
}

/** Plan every net globally and emit the wires in the optimised order. Returns false when a net could not be planned. */
function planGlobal(ctx: Ctx, members: Member[], notes: string[], deadline: number): { exhaustive: boolean } {
  const byNet = new Map<NetPlan, Member[]>();
  for (const m of members) byNet.set(m.net, [...(byNet.get(m.net) ?? []), m]);
  const links: Link[] = [];
  let exhaustive = true;
  // Power/ground first: they compete for rail segments, so they are chosen jointly.
  const base: Estimator = { paths: ctx.baseFlatPaths, cache: ctx.estimateCache };
  const searches: PowerSearch[] = [];
  const treeNets: [NetPlan, Member[]][] = [];
  for (const [net, ms] of byNet) {
    const search = wantRail(ctx, net) ? powerOptions(ctx, base, net, ms, notes) : null;
    if (search) searches.push(search);
    else treeNets.push([net, ms]);
  }
  if (searches.length) {
    const planned = planPowerNets(ctx, searches, notes);
    links.push(...planned.links);
    exhaustive &&= planned.exhaustive;
  }
  // Signal trees are estimated with the power wires already on the board: a module's
  // power taps usually leave through the row next to its header, which a bus should avoid.
  const powerPaths = routeSequence(ctx, links).paths;
  const est: Estimator = { paths: powerPaths, cache: new Map() };
  for (const [net, ms] of treeNets) {
    const planned = planTreeGlobal(ctx, est, net, ms, notes, deadline);
    links.push(...planned.links);
    exhaustive &&= planned.exhaustive;
  }
  const linked = new Set(links.map((l) => l.member?.key));
  for (const m of members) if (!linked.has(m.key) && !ctx.unresolved.some((u) => u.component === m.pc.instance.id && u.pin === m.pin.name)) ctx.unresolved.push(noTap(ctx, m));
  const { routed, converged } = optimiseOrder(ctx, links, deadline, notes);
  for (const { link, c } of routed) {
    if (link.hop) {
      const seg = link.hop.segment;
      const id = emitWire(ctx, link.net, c, link.hop.kind === 'feeder' ? `${link.net.name} 馈线 → ${seg.board.instance.id} 电源轨` : `${link.net.name} 桥线 → ${seg.board.instance.id} 电源轨`);
      absorb(ctx, link.net, c.source);
      ctx.reserved.add(c.target.address);
      link.net.segments.add(seg.key);
      ctx.segmentOwner.set(seg.key, link.net.key);
      ctx.bridges.push({ net: link.net.name, wire_id: id, from: c.source.address, to: c.target.address, kind: link.hop.kind, route: c.route, length_um: c.length_um });
    } else if (link.member) {
      recordConnection(ctx, link.member, c);
    }
  }
  return { exhaustive: exhaustive && converged };
}

// ---------------------------------------------------------------------------
// Intents and post-processing
// ---------------------------------------------------------------------------

function intentOps(ctx: Ctx, design: DesignDocument): Op[] {
  const ops: Op[] = [];
  const usedIds = new Set([...design.boards, ...design.components, ...design.wires, ...design.net_intents, ...design.constraints].map((o) => o.id));
  for (const net of ctx.nets.values()) {
    if (!net.members.length) continue;
    const hostKey = pinKey(ctx.host.instance.id, net.hostPin);
    const endpoints = [hostKey, ...net.members];
    const existing = design.net_intents.find((n) => n.endpoints.includes(hostKey) || n.name === net.name);
    if (existing) {
      const merged = [...existing.endpoints];
      for (const e of endpoints) if (!merged.includes(e)) merged.push(e);
      if (merged.length !== existing.endpoints.length) ops.push({ op: 'update_net_intent', id: existing.id, patch: { endpoints: merged } });
      continue;
    }
    let id = `n_${net.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    let n = 2;
    const base = id;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    ops.push({ op: 'add_net_intent', net_intent: { id, name: net.name, endpoints, notes: `自动布线生成（主板 ${ctx.host.instance.id}）` } });
  }
  return ops;
}

/** Safety net: a hard jumper that still crosses a module after routing becomes a Dupont wire (auto mode only). */
function liftCrossingWires(design: DesignDocument, catalog: Catalog, wireOps: Op[]): Set<string> {
  const draft = JSON.parse(JSON.stringify(design)) as DesignDocument;
  const ids = new Set<string>();
  for (const op of wireOps) {
    if (op.op !== 'add_wire' || !op.wire.id || !op.wire.to) continue;
    ids.add(op.wire.id);
    draft.wires.push({ id: op.wire.id, from: op.wire.from as WireEndpoint, to: op.wire.to as WireEndpoint, color: op.wire.color ?? 'red', route: op.wire.route ?? 'flat', path_mode: 'auto', waypoints_um: [] });
  }
  const lifted = new Set<string>();
  if (!ids.size) return lifted;
  const model = buildModel(draft, catalog);
  const { results } = checkModel(model);
  for (const r of results) if (r.code === 'wire_crosses_body') for (const o of r.objects) if (ids.has(o)) lifted.add(o);
  for (const op of wireOps) if (op.op === 'add_wire' && op.wire.id && lifted.has(op.wire.id)) op.wire.route = 'elevated';
  return lifted;
}

function centre(pc: PlacedComponent): PointUm {
  return [pc.bounds.x + pc.bounds.w / 2, pc.bounds.y + pc.bounds.h / 2];
}

function makeCtx(model: DesignModel, conn: Connectivity, host: PlacedComponent, req: AutoWireRequest, design: DesignDocument, skipped: AutoWireSkip[], estimateCache: Map<string, Candidate>): Ctx {
  const baseFlatPaths = [...model.wires.values()].filter((w) => w.instance.route === 'flat' && w.points.length > 1).map((w) => w.points);
  return {
    model,
    conn,
    host,
    req,
    reserved: new Set(),
    usedIds: new Set([...design.boards, ...design.components, ...design.wires, ...design.net_intents, ...design.constraints].map((o) => o.id)),
    usedTerminals: new Set(),
    plannedGpios: new Set(),
    nets: new Map(),
    segmentOwner: new Map(),
    flatPaths: [...baseFlatPaths],
    baseFlatPaths,
    estimateCache,
    memberOrder: new Map(),
    i2c: { buses: [], busOf: new Map(), conflicts: new Map() },
    configOps: [],
    configChanges: [],
    objective: 0,
    wires: [],
    connections: [],
    bridges: [],
    skipped: [...skipped],
    unresolved: [],
    results: [],
    signalColor: 0
  };
}

export function planAutoWire(design: DesignDocument, catalog: Catalog, req: AutoWireRequest): AutoWirePlan {
  const started = performance.now();
  const model = buildModel(design, catalog);
  const conn = buildConnectivity(model);
  const host = model.components.get(req.host);
  if (!host) {
    if (design.boards.some((b) => b.id === req.host)) throw new AutoWireError(`"${req.host}" 是面包板；主板应是主控/电源等元件的 ID`);
    throw new AutoWireError(`主板元件 "${req.host}" 不存在或无法解析`);
  }
  const ids = [...new Set(req.components)].filter((id) => id !== req.host);
  const peripherals: PlacedComponent[] = [];
  const skipped: AutoWireSkip[] = [];
  for (const id of ids) {
    const pc = model.components.get(id);
    if (pc) peripherals.push(pc);
    else if (design.boards.some((b) => b.id === id)) skipped.push({ component: id, pin: '', code: 'board_ignored', reason: `${id} 是面包板，自动布线只处理元件` });
    else throw new AutoWireError(`元件 "${id}" 不存在或无法解析`);
  }
  if (!peripherals.length) throw new AutoWireError('没有可布线的外设元件（至少选择一个除主板外的元件）');
  for (const [key, hostPin] of Object.entries(req.signal_pins ?? {})) {
    const parsed = parseAddress(key);
    const pc = parsed ? peripherals.find((p) => p.instance.id === parsed.owner) : undefined;
    if (!parsed || !pc) throw new AutoWireError(`signal_pins："${key}" 不是本次外设的 component.pin`);
    if (!pinOf(pc, parsed.name)) throw new AutoWireError(`signal_pins：元件 ${pc.instance.id} 没有引脚 "${parsed.name}"`);
    if (!pinOf(host, hostPin)) throw new AutoWireError(`signal_pins：主板 ${host.instance.id} 没有引脚 "${hostPin}"`);
  }
  // Nearest peripherals first, so buses chain outward from the host.
  const hostCentre = centre(host);
  peripherals.sort((a, b) => manhattan(centre(a), hostCentre) - manhattan(centre(b), hostCentre));

  const estimateCache = new Map<string, Candidate>();
  // Greedy baseline: always computed, so the global plan can be compared and never be worse.
  const greedy = makeCtx(model, conn, host, req, design, skipped, estimateCache);
  for (const m of classifyAll(greedy, peripherals)) {
    const failure = connectMember(greedy, m);
    if (failure) greedy.unresolved.push(failure);
  }
  let chosen = greedy;
  let globalObjective: number | null = null;
  let exhaustive = false;
  const notes: string[] = [];
  if ((req.optimize ?? 'global') === 'global') {
    const deadline = started + (req.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS);
    const global = makeCtx(model, conn, host, req, design, skipped, estimateCache);
    const members = classifyAll(global, peripherals);
    const r = planGlobal(global, members, notes, deadline);
    globalObjective = global.objective;
    exhaustive = r.exhaustive;
    // A plan that connects fewer pins is never preferred, whatever its objective says.
    if (global.connections.length > greedy.connections.length || (global.connections.length === greedy.connections.length && global.objective <= greedy.objective)) chosen = global;
  }
  const ctx = chosen;

  // An explicit hard-jumper request is never silently changed to another wire type.
  const lifted = !req.route || req.route === 'auto' ? liftCrossingWires(design, catalog, ctx.wires) : new Set<string>();
  for (const c of ctx.connections) if (lifted.has(c.wire_id)) c.route = 'elevated';
  for (const b of ctx.bridges) if (lifted.has(b.wire_id)) b.route = 'elevated';

  const ops: Op[] = [...ctx.configOps, ...ctx.wires, ...((req.net_intents ?? true) ? intentOps(ctx, design) : [])];
  const results: RuleResult[] = [...ctx.results];
  for (const u of ctx.unresolved) {
    results.push({ severity: 'warning', code: 'auto_wire_unresolved', category: 'wire', message: `自动布线未能连接 ${u.component}${u.pin ? `.${u.pin}` : ''}：${u.reason}`, objects: [u.component], endpoints: u.pin ? [terminalAddress(u.component, u.pin)] : [], blocking: false, ...(u.suggestion ? { suggestion: u.suggestion } : {}) });
  }
  for (const s of ctx.skipped) {
    if (s.code === 'already_connected' || s.code === 'pin_nc' || s.code === 'board_ignored') continue;
    results.push({ severity: 'info', code: 'auto_wire_skipped', category: 'wire', message: `自动布线跳过 ${s.component}${s.pin ? `.${s.pin}` : ''}：${s.reason}`, objects: [s.component], endpoints: s.pin ? [terminalAddress(s.component, s.pin)] : [], blocking: false, ...(s.suggestion ? { suggestion: s.suggestion } : {}) });
  }
  const flat = [...ctx.connections, ...ctx.bridges].filter((w) => w.route === 'flat').length;
  const dupont = ctx.connections.length + ctx.bridges.length - flat;
  const optimization: AutoWireOptimization = {
    strategy: chosen === greedy ? 'greedy' : 'global',
    objective_um: Math.round(ctx.objective),
    greedy_objective_um: Math.round(greedy.objective),
    global_objective_um: globalObjective === null ? null : Math.round(globalObjective),
    exhaustive: chosen !== greedy && exhaustive,
    elapsed_ms: Math.round(performance.now() - started),
    notes
  };
  const mm = (um: number) => `${(um / 1000).toFixed(1)} mm`;
  const optText = globalObjective === null
    ? `贪心规划，目标值 ${mm(ctx.objective)}`
    : chosen === greedy
      ? `全局搜索（${optimization.elapsed_ms} ms）未优于贪心：目标值 ${mm(greedy.objective)} vs ${mm(globalObjective)}，保留贪心结果`
      : `全局优化（${optimization.elapsed_ms} ms，${exhaustive ? '拓扑与电源轨组合已穷举、顺序搜索已收敛' : '部分启发式'}）：目标值 ${mm(globalObjective)}，贪心 ${mm(greedy.objective)}，${globalObjective < greedy.objective ? `改善 ${(((greedy.objective - globalObjective) / Math.max(greedy.objective, 1)) * 100).toFixed(1)}%` : '贪心结果已是搜索到的最优'}`;
  results.push({
    severity: 'info',
    code: 'auto_wire_summary',
    category: 'wire',
    message: `自动布线（主板 ${host.instance.id}）：生成 ${ctx.connections.length} 根连接线、${ctx.bridges.length} 根馈线/桥线（硬跳线 ${flat}、杜邦线 ${dupont}）；${ctx.unresolved.length} 个引脚未能连接，${ctx.skipped.length} 个跳过。${optText}。目标值 = 走线长度 + 拐弯/杜邦线/线数惩罚，按目录引脚角色生成，不是电气仿真结果。`,
    objects: [host.instance.id, ...peripherals.map((p) => p.instance.id)],
    blocking: false
  });
  const i2c_buses: AutoWireI2cBus[] = ctx.i2c.buses.filter((b) => b.devices.length || b.added).map((b) => ({ index: b.index, sda: b.sda, scl: b.scl, devices: [...b.devices], added: b.added }));
  return { host: host.instance.id, components: peripherals.map((p) => p.instance.id), optimization, i2c_buses, config_changes: ctx.configChanges, ops, connections: ctx.connections, bridges: ctx.bridges, skipped: ctx.skipped, unresolved: ctx.unresolved, results };
}
