import type { BoardDefinition, BoardInstance, ComponentDefinition, ComponentInstance, DesignDocument, PinMeta, PointUm, WireEndpoint, WireInstance } from '@breadboard-studio/schema';
import { Catalog } from '@breadboard-studio/catalog';
import { holeAddress, parseAddress, terminalAddress } from './address.js';
import { holeAtLocal, resolveBoard, type ResolvedBoard, type ResolvedHole } from './board.js';
import { findPin, pinMetaOf, resolveComponent, type ResolvedComponent } from './component.js';
import { polylineLength, rectContains, rectToGlobal, rectUnion, rotateVec, toGlobal, toLocal, type Rect, type Transform } from './geometry.js';
import type { RuleResult } from './results.js';
import { autoRoute, type RouteEnd } from './wire-route.js';

export interface HoleRef {
  board_id: string;
  hole: string;
}

export interface PlacedBoard {
  instance: BoardInstance;
  def: BoardDefinition;
  resolved: ResolvedBoard;
  transform: Transform;
  bounds: Rect;
}

export interface PlacedPin {
  name: string;
  local_um: PointUm;
  global_um: PointUm;
  kind: 'header' | 'terminal' | 'pad';
  meta: PinMeta;
  /** Hole this pin is inserted in, when resolved. */
  hole?: HoleRef;
}

export interface PlacedComponent {
  instance: ComponentInstance;
  def: ComponentDefinition;
  resolved: ResolvedComponent;
  transform: Transform;
  pins: PlacedPin[];
  /** Global axis-aligned rect of the blocking footprint. */
  footprint: Rect;
  /** Global rect of the drawn outline. */
  bounds: Rect;
  onBoard: boolean;
  /** Holes covered by the body but not used by pins. */
  blockedHoles: HoleRef[];
  zRange: [number, number];
}

export type HoleStatus = 'free' | 'occupied' | 'blocked';

export interface HoleState {
  board_id: string;
  hole: string;
  status: HoleStatus;
  component_id?: string;
  pin?: string;
  /** Wire ids whose endpoints use this hole. */
  wires: string[];
}

export type ResolvedEndpoint =
  | { kind: 'hole'; address: string; board_id: string; hole: string; global_um: PointUm }
  | { kind: 'terminal'; address: string; component_id: string; pin: string; global_um: PointUm };

export interface ResolvedWire {
  instance: WireInstance;
  from: ResolvedEndpoint | null;
  to: ResolvedEndpoint | null;
  /** Full path: from, waypoints, to (global µm). */
  points: PointUm[];
  waypoints_um: PointUm[];
  length_um: number;
  /** Wire conducts only when both ends are resolved and physically insertable. */
  conducts: boolean;
}

export interface DesignModel {
  design: DesignDocument;
  catalog: Catalog;
  boards: Map<string, PlacedBoard>;
  components: Map<string, PlacedComponent>;
  wires: Map<string, ResolvedWire>;
  /** keyed by hole address `board.hole` */
  holes: Map<string, HoleState>;
  /** Structural issues found while building the model. */
  issues: RuleResult[];
  bounds: Rect | null;
}

function err(code: string, category: RuleResult['category'], message: string, objects: string[], extra: Partial<RuleResult> = {}): RuleResult {
  return { severity: 'error', code, category, message, objects, blocking: true, ...extra };
}

/** Catalog with the design's embedded definitions layered on top. */
export function catalogForDesign(design: DesignDocument, base: Catalog): Catalog {
  const emb = design.embedded_catalog;
  if (!emb || (!emb.boards?.length && !emb.components?.length)) return base;
  return base.overlay([...(emb.boards ?? []), ...(emb.components ?? [])]);
}

export function buildModel(design: DesignDocument, baseCatalog: Catalog): DesignModel {
  const catalog = catalogForDesign(design, baseCatalog);
  const issues: RuleResult[] = [];
  const boards = new Map<string, PlacedBoard>();
  const components = new Map<string, PlacedComponent>();
  const wires = new Map<string, ResolvedWire>();
  const holes = new Map<string, HoleState>();

  // ---- duplicate ids across all object kinds ----
  const seen = new Map<string, string>();
  const checkId = (id: string, kind: string) => {
    const prev = seen.get(id);
    if (prev) issues.push(err('duplicate_id', 'schema', `重复的 ID "${id}"（${prev} 与 ${kind}）`, [id], { suggestion: '为每个对象使用唯一 ID。' }));
    else seen.set(id, kind);
  };
  for (const b of design.boards) checkId(b.id, 'board');
  for (const c of design.components) checkId(c.id, 'component');
  for (const w of design.wires) checkId(w.id, 'wire');
  for (const n of design.net_intents) checkId(n.id, 'net_intent');
  for (const c of design.constraints) checkId(c.id, 'constraint');

  // ---- boards ----
  for (const b of design.boards) {
    const def = catalog.getBoard(b.model);
    if (!def) {
      issues.push(err('unknown_model', 'schema', `面包板 "${b.id}" 引用了未知型号 ${b.model}`, [b.id], { suggestion: '使用 `bb catalog list` 查看可用型号，或在 embedded_catalog 中提供定义。' }));
      continue;
    }
    const resolved = resolveBoard(def);
    const transform: Transform = { position: b.position_um, rotation: b.rotation_deg };
    boards.set(b.id, { instance: b, def, resolved, transform, bounds: rectToGlobal(resolved.bounds, transform) });
    for (const h of resolved.holes.values()) {
      holes.set(holeAddress(b.id, h.name), { board_id: b.id, hole: h.name, status: 'free', wires: [] });
    }
  }

  const findHoleGlobal = (global: PointUm): { board: PlacedBoard; hole: ResolvedHole } | null => {
    for (const pb of boards.values()) {
      const local = toLocal(global, pb.transform);
      const h = holeAtLocal(pb.resolved, local);
      if (h) return { board: pb, hole: h };
    }
    return null;
  };

  // ---- components ----
  for (const c of design.components) {
    const def = catalog.getComponent(c.model);
    if (!def) {
      issues.push(err('unknown_model', 'schema', `元件 "${c.id}" 引用了未知型号 ${c.model}`, [c.id], { suggestion: '使用 `bb catalog list` 查看可用型号。' }));
      continue;
    }
    const resolved = resolveComponent(def, c.params, c.config);
    for (const msg of resolved.issues) {
      issues.push(err('params_invalid', 'schema', `元件 "${c.id}" 的参数无效：${msg}`, [c.id]));
    }
    let transform: Transform | null = null;
    let onBoard = false;
    if (c.placement.kind === 'board') {
      const pb = boards.get(c.placement.board_id);
      if (!pb) {
        issues.push(err('unknown_board', 'schema', `元件 "${c.id}" 放置在不存在的面包板 "${c.placement.board_id}" 上`, [c.id]));
        continue;
      }
      const hole = pb.resolved.holes.get(c.placement.anchor_hole);
      if (!hole) {
        issues.push(err('invalid_hole', 'schema', `元件 "${c.id}" 的锚点孔 "${c.placement.board_id}.${c.placement.anchor_hole}" 不存在`, [c.id], { endpoints: [holeAddress(c.placement.board_id, c.placement.anchor_hole)], suggestion: '孔名形如 a1–j30 或 top_outer_1。' }));
        continue;
      }
      const pin = findPin(resolved, c.placement.anchor_pin);
      if (!pin) {
        issues.push(err('unknown_pin', 'schema', `元件 "${c.id}" 没有名为 "${c.placement.anchor_pin}" 的引脚`, [c.id], { suggestion: `可用引脚：${resolved.pins.map((p) => p.name).join(', ')}` }));
        continue;
      }
      if (pin.kind !== 'header') {
        issues.push(err('component_not_insertable', 'placement', `元件 "${c.id}" 的引脚 "${pin.name}" 是 ${pin.kind} 端子，不能插入面包板`, [c.id], { suggestion: '把它放到板外（placement.kind = off_board），用导线连接端子。' }));
        continue;
      }
      const holeGlobal = toGlobal(hole.local_um, pb.transform);
      const rot = c.placement.rotation_deg;
      const off = rotateVec(pin.local_um, rot);
      transform = { position: [holeGlobal[0] - off[0], holeGlobal[1] - off[1]], rotation: rot };
      onBoard = true;
    } else {
      transform = { position: c.placement.position_um, rotation: c.placement.rotation_deg };
    }
    const pins: PlacedPin[] = resolved.pins.map((p) => ({
      name: p.name,
      local_um: p.local_um,
      global_um: toGlobal(p.local_um, transform!),
      kind: p.kind,
      meta: pinMetaOf(def, p.name)
    }));
    if (onBoard) {
      for (const p of pins) {
        if (p.kind !== 'header') continue;
        const found = findHoleGlobal(p.global_um);
        if (!found) {
          issues.push(
            err('pin_not_on_hole', 'placement', `元件 "${c.id}" 的引脚 "${p.name}" 没有落在任何面包板孔上`, [c.id], {
              endpoints: [terminalAddress(c.id, p.name)],
              suggestion: '检查旋转方向、锚点孔和面包板位置；排针间距必须与 2.54 mm 孔阵对齐。'
            })
          );
          continue;
        }
        p.hole = { board_id: found.board.instance.id, hole: found.hole.name };
        const state = holes.get(holeAddress(p.hole.board_id, p.hole.hole))!;
        if (state.status === 'occupied') {
          issues.push(
            err('hole_conflict', 'placement', `孔 ${holeAddress(p.hole.board_id, p.hole.hole)} 同时被 ${state.component_id}.${state.pin} 和 ${c.id}.${p.name} 占用`, [state.component_id!, c.id], {
              endpoints: [holeAddress(p.hole.board_id, p.hole.hole)],
              suggestion: '移动其中一个元件。'
            })
          );
        } else {
          state.status = 'occupied';
          state.component_id = c.id;
          state.pin = p.name;
        }
      }
    }
    const footprint = rectToGlobal(resolved.footprint, transform);
    const bounds = rectToGlobal(resolved.outline, transform);
    components.set(c.id, {
      instance: c,
      def,
      resolved,
      transform,
      pins,
      footprint,
      bounds,
      onBoard,
      blockedHoles: [],
      zRange: [resolved.body.standoff_um, resolved.body.standoff_um + resolved.body.height_um]
    });
  }

  // ---- blocked holes (body over board) ----
  for (const pc of components.values()) {
    if (pc.resolved.body.standoff_um > 6000) continue; // far above the board: does not block access
    for (const pb of boards.values()) {
      if (!rectsIntersect(pc.footprint, pb.bounds)) continue;
      for (const h of pb.resolved.holes.values()) {
        const g = toGlobal(h.local_um, pb.transform);
        if (!rectContains(pc.footprint, g, 100)) continue;
        const addr = holeAddress(pb.instance.id, h.name);
        const st = holes.get(addr)!;
        if (st.status === 'free') {
          st.status = 'blocked';
          st.component_id = pc.instance.id;
          pc.blockedHoles.push({ board_id: pb.instance.id, hole: h.name });
        }
      }
    }
  }

  // ---- wires ----
  const resolveEndpoint = (w: WireInstance, ep: WireEndpoint, which: 'from' | 'to'): ResolvedEndpoint | null => {
    if (ep.hole !== undefined) {
      const parsed = parseAddress(ep.hole);
      const pb = parsed ? boards.get(parsed.owner) : undefined;
      if (!parsed || !pb) {
        issues.push(err('unknown_reference', 'wire', `导线 "${w.id}" 的 ${which} 端引用了不存在的面包板：${ep.hole}`, [w.id], { endpoints: [ep.hole] }));
        return null;
      }
      const hole = pb.resolved.holes.get(parsed.name);
      if (!hole) {
        issues.push(err('invalid_hole', 'wire', `导线 "${w.id}" 的 ${which} 端孔位 ${ep.hole} 不存在`, [w.id], { endpoints: [ep.hole], suggestion: '孔名形如 a1–j30 或 top_outer_1。' }));
        return null;
      }
      const st = holes.get(ep.hole)!;
      if (st.status === 'occupied') {
        issues.push(
          err('wire_endpoint_occupied', 'wire', `导线 "${w.id}" 的 ${which} 端孔位 ${ep.hole} 已被 ${st.component_id}.${st.pin} 的引脚占用`, [w.id, st.component_id!], {
            endpoints: [ep.hole],
            suggestion: '改接同一组内的空闲孔（同列 a–e 或 f–j）。'
          })
        );
      } else if (st.status === 'blocked') {
        issues.push(
          err('wire_endpoint_blocked', 'wire', `导线 "${w.id}" 的 ${which} 端孔位 ${ep.hole} 被元件 ${st.component_id} 的板体遮挡`, [w.id, st.component_id!], {
            endpoints: [ep.hole],
            suggestion: '改接同一组内未被遮挡的孔。'
          })
        );
      } else if (st.wires.length) {
        issues.push(
          err('wire_hole_conflict', 'wire', `孔位 ${ep.hole} 已经插有导线 ${st.wires.join(', ')}，不能再插 ${w.id}`, [w.id, ...st.wires], {
            endpoints: [ep.hole],
            suggestion: '一个孔只能插一根线；改用同组的其他空孔。'
          })
        );
      }
      st.wires.push(w.id);
      return { kind: 'hole', address: ep.hole, board_id: pb.instance.id, hole: hole.name, global_um: toGlobal(hole.local_um, pb.transform) };
    }
    const addr = ep.terminal!;
    const parsed = parseAddress(addr);
    const pc = parsed ? components.get(parsed.owner) : undefined;
    if (!parsed || !pc) {
      issues.push(err('unknown_reference', 'wire', `导线 "${w.id}" 的 ${which} 端引用了不存在的元件：${addr}`, [w.id], { endpoints: [addr] }));
      return null;
    }
    const pin = pc.pins.find((p) => p.name === parsed.name);
    if (!pin) {
      issues.push(err('unknown_pin', 'wire', `导线 "${w.id}" 的 ${which} 端引脚 ${addr} 不存在`, [w.id], { endpoints: [addr], suggestion: `可用引脚：${pc.pins.map((p) => p.name).join(', ')}` }));
      return null;
    }
    if (pin.hole) {
      issues.push(
        err('wire_endpoint_inserted_pin', 'wire', `导线 "${w.id}" 直接接在已插入面包板的引脚 ${addr} 上`, [w.id, pc.instance.id], {
          endpoints: [addr, holeAddress(pin.hole.board_id, pin.hole.hole)],
          suggestion: `改接与 ${holeAddress(pin.hole.board_id, pin.hole.hole)} 同组的空闲孔。`
        })
      );
    }
    return { kind: 'terminal', address: addr, component_id: pc.instance.id, pin: pin.name, global_um: pin.global_um };
  };

  const routeEnd = (ep: ResolvedEndpoint): RouteEnd => (ep.kind === 'terminal' ? terminalRouteEnd(components.get(ep.component_id), ep.pin, ep.global_um) : { point: ep.global_um });

  for (const w of design.wires) {
    const issuesBefore = issues.length;
    const from = resolveEndpoint(w, w.from, 'from');
    const to = w.to ? resolveEndpoint(w, w.to, 'to') : null;
    if (!w.to) {
      issues.push({ severity: 'warning', code: 'wire_dangling', category: 'wire', message: `导线 "${w.id}" 只有起点，没有终点（未完成草稿）`, objects: [w.id], blocking: false, suggestion: '补全终点或删除这根线。' });
    }
    let waypoints: PointUm[] = w.waypoints_um;
    let points: PointUm[] = [];
    if (from && to) {
      if (w.path_mode === 'auto') {
        if (w.route === 'elevated') {
          // A Dupont wire may pass over components and is represented by the
          // direct point-to-point span. Manual waypoints remain untouched.
          waypoints = [];
        } else {
          const terminalOwners = new Set<string>();
          for (const ep of [from, to]) {
            if (ep.kind === 'terminal') terminalOwners.add(ep.component_id);
          }
          const priorFlat = [...wires.values()].filter((prior) => prior.instance.route === 'flat').map((prior) => prior.points);
          waypoints = autoRoute(routeEnd(from), routeEnd(to), flatRouteObstacles(components.values(), priorFlat, terminalOwners));
        }
      }
      points = [from.global_um, ...waypoints, to.global_um];
    } else if (from) {
      points = [from.global_um, ...waypoints];
    }
    const hadBlocking = issues.slice(issuesBefore).some((i) => i.blocking && i.objects.includes(w.id));
    wires.set(w.id, {
      instance: w,
      from,
      to,
      points,
      waypoints_um: waypoints,
      length_um: polylineLength(points),
      conducts: !!from && !!to && !hadBlocking
    });
  }

  const allRects = [...[...boards.values()].map((b) => b.bounds), ...[...components.values()].map((c) => c.bounds)];
  for (const w of wires.values()) {
    for (const p of w.points) allRects.push({ x: p[0], y: p[1], w: 0, h: 0 });
  }

  return { design, catalog, boards, components, wires, holes, issues, bounds: rectUnion(allRects) };
}

/** Cable terminals leave the body outward so auto-routed wires do not cross their own module. */
export function terminalRouteEnd(pc: PlacedComponent | undefined, pinName: string, global: PointUm): RouteEnd {
  if (!pc) return { point: global };
  const cx = pc.bounds.x + pc.bounds.w / 2;
  const cy = pc.bounds.y + pc.bounds.h / 2;
  const dx = global[0] - cx;
  const dy = global[1] - cy;
  const stub = 5000;
  const exit: PointUm = Math.abs(dx) * pc.bounds.h > Math.abs(dy) * pc.bounds.w ? [dx < 0 ? -stub : stub, 0] : [0, dy < 0 ? -stub : stub];
  const lane = pc.pins.findIndex((p) => p.name === pinName);
  return { point: global, exit, bounds: pc.bounds, lane: lane < 0 ? 0 : lane };
}

/**
 * Obstacles for a hard jumper on the board plane: every component footprint
 * except the modules that own a cable terminal of this wire (the terminal sits
 * on its own body and leaves through an outward stub), plus each segment of
 * the hard jumpers routed before it, so later jumpers take separate lanes
 * instead of sharing a segment. Dupont wires never block anything.
 */
export function flatRouteObstacles(components: Iterable<PlacedComponent>, priorFlatPaths: PointUm[][], terminalOwners: Set<string> = new Set()): Rect[] {
  const obstacles: Rect[] = [];
  for (const pc of components) if (!terminalOwners.has(pc.instance.id)) obstacles.push(pc.footprint);
  for (const path of priorFlatPaths) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      obstacles.push({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) });
    }
  }
  return obstacles;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Hole address for a pin, when it is inserted. */
export function pinHoleAddress(pin: PlacedPin): string | null {
  return pin.hole ? holeAddress(pin.hole.board_id, pin.hole.hole) : null;
}

/** All holes in the same internal group as `addr` (including itself). */
export function groupHoles(model: DesignModel, addr: string): string[] {
  const parsed = parseAddress(addr);
  const pb = parsed ? model.boards.get(parsed.owner) : undefined;
  if (!parsed || !pb) return [];
  const hole = pb.resolved.holes.get(parsed.name);
  if (!hole) return [];
  return (pb.resolved.groups.get(hole.group) ?? []).map((n) => holeAddress(pb.instance.id, n));
}

/** Free holes reachable for wiring from a pin's group, nearest first. */
export function accessibleHolesForPin(model: DesignModel, componentId: string, pinName: string): string[] {
  const pc = model.components.get(componentId);
  const pin = pc?.pins.find((p) => p.name === pinName);
  if (!pc || !pin || !pin.hole) return [];
  const own = holeAddress(pin.hole.board_id, pin.hole.hole);
  const pb = model.boards.get(pin.hole.board_id)!;
  const ownHole = pb.resolved.holes.get(pin.hole.hole)!;
  return groupHoles(model, own)
    .filter((a) => a !== own)
    .filter((a) => model.holes.get(a)?.status === 'free' && (model.holes.get(a)?.wires.length ?? 0) === 0)
    .sort((a, b) => {
      const ha = pb.resolved.holes.get(parseAddress(a)!.name)!;
      const hb = pb.resolved.holes.get(parseAddress(b)!.name)!;
      const da = Math.hypot(ha.local_um[0] - ownHole.local_um[0], ha.local_um[1] - ownHole.local_um[1]);
      const db = Math.hypot(hb.local_um[0] - ownHole.local_um[0], hb.local_um[1] - ownHole.local_um[1]);
      return da - db;
    });
}
