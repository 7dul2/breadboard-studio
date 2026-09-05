import type { ComponentInstance, Constraint, DesignDocument, DesignMetadata, JsonValue, NetIntent, Placement, PointUm, RotationDeg, WireEndpoint, WireInstance, WireRoute, WirePathMode } from '@breadboard-studio/schema';
import { validateDesignSchema } from '@breadboard-studio/schema';
import { Catalog, builtinCatalog } from '@breadboard-studio/catalog';
import { parseAddress } from './address.js';
import { analyzeDesign } from './analyze.js';
import { cloneDesign, designHash } from './design.js';
import { normalizeRotation } from './geometry.js';
import { attachBoardPosition, nextFreePosition, type AttachSide } from './layout.js';
import { accessibleHolesForPin, buildModel } from './model.js';
import type { RuleResult } from './results.js';

// ---------------------------------------------------------------------------
// Operation vocabulary (structured domain operations; no scripts, no eval)
// ---------------------------------------------------------------------------

export interface PinEndpoint {
  /** `component.pin` sugar: resolved to a free hole in the pin's group when the pin is inserted, else to the terminal. */
  pin: string;
}

export type OpEndpoint = WireEndpoint | PinEndpoint;

export type Op =
  | {
      op: 'add_board';
      board: {
        id: string;
        model: string;
        name?: string;
        position_um?: PointUm;
        rotation_deg?: RotationDeg;
        attach_to?: { board_id: string; side: AttachSide; gap_um?: number; grid_align?: boolean };
        notes?: string;
      };
    }
  | { op: 'remove_board'; id: string; cascade?: boolean }
  | { op: 'move_board'; id: string; position_um: PointUm }
  | { op: 'rotate_board'; id: string; rotation_deg?: RotationDeg; by_deg?: number }
  | { op: 'add_component'; component: Omit<ComponentInstance, 'placement'> & { placement?: Placement } }
  | { op: 'remove_component'; id: string; cascade?: boolean }
  | { op: 'move_component'; id: string; placement: Placement }
  | { op: 'rotate_component'; id: string; rotation_deg?: RotationDeg; by_deg?: number }
  | {
      op: 'add_wire';
      wire: {
        id?: string;
        name?: string;
        from: OpEndpoint;
        to?: OpEndpoint;
        color?: string;
        route?: WireRoute;
        path_mode?: WirePathMode;
        waypoints_um?: PointUm[];
        notes?: string;
      };
    }
  | { op: 'remove_wire'; id: string }
  | {
      op: 'update_wire';
      id: string;
      patch: Partial<Pick<WireInstance, 'name' | 'color' | 'route' | 'path_mode' | 'waypoints_um' | 'notes' | 'locked'>> & { from?: OpEndpoint; to?: OpEndpoint | null };
    }
  | { op: 'update_property'; id: string; path: string; value: JsonValue }
  | { op: 'add_net_intent'; net_intent: NetIntent }
  | { op: 'remove_net_intent'; id: string }
  | { op: 'update_net_intent'; id: string; patch: Partial<Omit<NetIntent, 'id'>> }
  | { op: 'add_constraint'; constraint: Constraint }
  | { op: 'remove_constraint'; id: string }
  | { op: 'set_metadata'; patch: Partial<Omit<DesignMetadata, 'revision'>> }
  | { op: 'replace_design'; design: DesignDocument };

export interface Patch {
  expected_revision?: number;
  expected_hash?: string;
  ops: Op[];
}

export interface ApplyOptions {
  catalog?: Catalog;
  expected_revision?: number;
  expected_hash?: string;
  /** Commit even when blocking (structural/physical) errors remain. */
  allow_blocking?: boolean;
  /** Skip the revision bump (used by the editor for view-only edits). */
  now?: () => string;
}

export type ApplyResult =
  | { ok: true; design: DesignDocument; results: RuleResult[]; changed: string[]; revision: number; hash: string; previous_hash: string }
  | {
      ok: false;
      error: { code: 'revision_conflict' | 'op_failed' | 'blocking_errors' | 'schema_invalid'; message: string; op_index?: number; results?: RuleResult[]; issues?: { path: string; message: string }[] };
    };

class OpError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function mustFind<T extends { id: string }>(list: T[], id: string, kind: string): T {
  const x = list.find((i) => i.id === id);
  if (!x) throw new OpError(`${kind} "${id}" 不存在`);
  return x;
}

function ensureUnlocked(obj: { locked?: boolean; id: string }, what: string): void {
  if (obj.locked) throw new OpError(`${what} "${obj.id}" 已锁定，先解锁再修改`);
}

function ensureUniqueId(design: DesignDocument, id: string): void {
  const all = [...design.boards, ...design.components, ...design.wires, ...design.net_intents, ...design.constraints];
  if (all.some((o) => o.id === id)) throw new OpError(`ID "${id}" 已被占用`);
}

function nextId(design: DesignDocument, prefix: string): string {
  const used = new Set([...design.boards, ...design.components, ...design.wires, ...design.net_intents, ...design.constraints].map((o) => o.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function resolveOpEndpoint(design: DesignDocument, catalog: Catalog, ep: OpEndpoint, exclude: Set<string>): WireEndpoint {
  if ('pin' in ep) {
    const parsed = parseAddress(ep.pin);
    if (!parsed) throw new OpError(`端点 "${ep.pin}" 格式应为 component.pin`);
    const model = buildModel(design, catalog);
    const pc = model.components.get(parsed.owner);
    if (!pc) throw new OpError(`元件 "${parsed.owner}" 不存在`);
    const pin = pc.pins.find((p) => p.name === parsed.name);
    if (!pin) throw new OpError(`元件 "${parsed.owner}" 没有引脚 "${parsed.name}"（可用：${pc.pins.map((p) => p.name).join(', ')}）`);
    if (!pin.hole) return { terminal: ep.pin };
    const candidates = accessibleHolesForPin(model, pc.instance.id, pin.name).filter((h) => !exclude.has(h));
    if (!candidates.length) throw new OpError(`引脚 ${ep.pin} 所在孔组没有可用的空闲孔`);
    return { hole: candidates[0]! };
  }
  return ep;
}

function applyOne(design: DesignDocument, catalog: Catalog, op: Op, changed: Set<string>): void {
  switch (op.op) {
    case 'add_board': {
      const def = catalog.getBoard(op.board.model);
      if (!def) throw new OpError(`未知面包板型号 ${op.board.model}`);
      ensureUniqueId(design, op.board.id);
      const rotation = op.board.rotation_deg ?? 0;
      let position: PointUm = op.board.position_um ?? [0, 0];
      const model = buildModel(design, catalog);
      if (op.board.attach_to) {
        const target = model.boards.get(op.board.attach_to.board_id);
        if (!target) throw new OpError(`attach_to 引用的面包板 "${op.board.attach_to.board_id}" 不存在`);
        position = attachBoardPosition(target, def, rotation, op.board.attach_to.side, op.board.attach_to.gap_um ?? 0, op.board.attach_to.grid_align ?? true);
      } else if (!op.board.position_um && design.boards.length) {
        position = nextFreePosition(model, def.size_um);
      }
      design.boards.push({ id: op.board.id, model: op.board.model, position_um: position, rotation_deg: rotation, ...(op.board.name ? { name: op.board.name } : {}), ...(op.board.notes ? { notes: op.board.notes } : {}) });
      changed.add(op.board.id);
      return;
    }
    case 'remove_board': {
      const b = mustFind(design.boards, op.id, '面包板');
      ensureUnlocked(b, '面包板');
      const dependents = design.components.filter((c) => c.placement.kind === 'board' && c.placement.board_id === op.id);
      const wires = design.wires.filter((w) => [w.from, w.to].some((e) => e?.hole?.startsWith(`${op.id}.`)));
      if ((dependents.length || wires.length) && !op.cascade) {
        throw new OpError(`面包板 "${op.id}" 仍被使用：元件 ${dependents.map((d) => d.id).join(', ') || '无'}；导线 ${wires.map((w) => w.id).join(', ') || '无'}。设置 cascade=true 一并删除`);
      }
      for (const d of dependents) changed.add(d.id);
      for (const w of wires) changed.add(w.id);
      design.components = design.components.filter((c) => !dependents.includes(c));
      design.wires = design.wires.filter((w) => !wires.includes(w));
      design.boards = design.boards.filter((x) => x.id !== op.id);
      changed.add(op.id);
      return;
    }
    case 'move_board': {
      const b = mustFind(design.boards, op.id, '面包板');
      ensureUnlocked(b, '面包板');
      b.position_um = [Math.round(op.position_um[0]), Math.round(op.position_um[1])];
      changed.add(op.id);
      return;
    }
    case 'rotate_board': {
      const b = mustFind(design.boards, op.id, '面包板');
      ensureUnlocked(b, '面包板');
      b.rotation_deg = op.rotation_deg ?? normalizeRotation(b.rotation_deg + (op.by_deg ?? 90));
      changed.add(op.id);
      return;
    }
    case 'add_component': {
      const def = catalog.getComponent(op.component.model);
      if (!def) throw new OpError(`未知元件型号 ${op.component.model}`);
      ensureUniqueId(design, op.component.id);
      let placement = op.component.placement;
      if (!placement) {
        const model = buildModel(design, catalog);
        placement = { kind: 'off_board', position_um: nextFreePosition(model, def.body.size_um), rotation_deg: def.preferred_rotation_deg ?? 0 };
      }
      const { placement: _p, ...rest } = op.component;
      design.components.push({ ...rest, placement });
      changed.add(op.component.id);
      return;
    }
    case 'remove_component': {
      const c = mustFind(design.components, op.id, '元件');
      ensureUnlocked(c, '元件');
      const wires = design.wires.filter((w) => [w.from, w.to].some((e) => e?.terminal?.startsWith(`${op.id}.`)));
      if (wires.length && !op.cascade) throw new OpError(`元件 "${op.id}" 的端子仍连着导线 ${wires.map((w) => w.id).join(', ')}。设置 cascade=true 一并删除`);
      design.wires = design.wires.filter((w) => !wires.includes(w));
      for (const w of wires) changed.add(w.id);
      design.components = design.components.filter((x) => x.id !== op.id);
      changed.add(op.id);
      return;
    }
    case 'move_component': {
      const c = mustFind(design.components, op.id, '元件');
      ensureUnlocked(c, '元件');
      c.placement = op.placement;
      changed.add(op.id);
      return;
    }
    case 'rotate_component': {
      const c = mustFind(design.components, op.id, '元件');
      ensureUnlocked(c, '元件');
      const r = op.rotation_deg ?? normalizeRotation(c.placement.rotation_deg + (op.by_deg ?? 90));
      c.placement = { ...c.placement, rotation_deg: r };
      changed.add(op.id);
      return;
    }
    case 'add_wire': {
      const id = op.wire.id ?? nextId(design, 'w');
      ensureUniqueId(design, id);
      const used = new Set<string>();
      for (const w of design.wires) for (const e of [w.from, w.to]) if (e?.hole) used.add(e.hole);
      const from = resolveOpEndpoint(design, catalog, op.wire.from, used);
      if (from.hole) used.add(from.hole);
      const to = op.wire.to ? resolveOpEndpoint(design, catalog, op.wire.to, used) : undefined;
      const wire: WireInstance = {
        id,
        from,
        ...(to ? { to } : {}),
        color: op.wire.color ?? 'red',
        route: op.wire.route ?? 'flat',
        path_mode: op.wire.waypoints_um?.length ? (op.wire.path_mode ?? 'manual') : (op.wire.path_mode ?? 'auto'),
        waypoints_um: op.wire.waypoints_um ?? [],
        ...(op.wire.name ? { name: op.wire.name } : {}),
        ...(op.wire.notes ? { notes: op.wire.notes } : {})
      };
      design.wires.push(wire);
      changed.add(id);
      return;
    }
    case 'remove_wire': {
      const w = mustFind(design.wires, op.id, '导线');
      ensureUnlocked(w, '导线');
      design.wires = design.wires.filter((x) => x.id !== op.id);
      changed.add(op.id);
      return;
    }
    case 'update_wire': {
      const w = mustFind(design.wires, op.id, '导线');
      if (op.patch.locked === undefined) ensureUnlocked(w, '导线');
      const { from, to, ...rest } = op.patch;
      const used = new Set<string>();
      for (const other of design.wires) if (other.id !== w.id) for (const e of [other.from, other.to]) if (e?.hole) used.add(e.hole);
      if (from) w.from = resolveOpEndpoint(design, catalog, from, used);
      if (to === null) delete w.to;
      else if (to) w.to = resolveOpEndpoint(design, catalog, to, used);
      Object.assign(w, stripUndefined(rest));
      if (op.patch.waypoints_um && !('path_mode' in op.patch)) w.path_mode = 'manual';
      changed.add(op.id);
      return;
    }
    case 'update_property': {
      const target = [...design.boards, ...design.components, ...design.wires, ...design.net_intents].find((o) => o.id === op.id);
      if (!target) throw new OpError(`对象 "${op.id}" 不存在`);
      const path = op.path.split('.');
      const allowedRoots = ['name', 'notes', 'locked', 'color', 'params', 'config', 'position_um', 'rotation_deg', 'route', 'path_mode', 'waypoints_um', 'endpoints'];
      if (!allowedRoots.includes(path[0]!)) throw new OpError(`不允许通过 update_property 修改 "${op.path}"`);
      if (path[0] !== 'locked') ensureUnlocked(target as { locked?: boolean; id: string }, '对象');
      setPath(target as unknown as Record<string, JsonValue>, path, op.value);
      changed.add(op.id);
      return;
    }
    case 'add_net_intent': {
      ensureUniqueId(design, op.net_intent.id);
      design.net_intents.push(op.net_intent);
      changed.add(op.net_intent.id);
      return;
    }
    case 'remove_net_intent': {
      mustFind(design.net_intents, op.id, '网络意图');
      design.net_intents = design.net_intents.filter((n) => n.id !== op.id);
      changed.add(op.id);
      return;
    }
    case 'update_net_intent': {
      const n = mustFind(design.net_intents, op.id, '网络意图');
      Object.assign(n, stripUndefined(op.patch));
      changed.add(op.id);
      return;
    }
    case 'add_constraint': {
      ensureUniqueId(design, op.constraint.id);
      design.constraints.push(op.constraint);
      changed.add(op.constraint.id);
      return;
    }
    case 'remove_constraint': {
      mustFind(design.constraints, op.id, '约束');
      design.constraints = design.constraints.filter((c) => c.id !== op.id);
      changed.add(op.id);
      return;
    }
    case 'set_metadata': {
      const { revision: _r, ...rest } = op.patch as DesignMetadata;
      Object.assign(design.metadata, stripUndefined(rest));
      changed.add('metadata');
      return;
    }
    case 'replace_design': {
      const v = validateDesignSchema(op.design);
      if (!v.ok || !v.value) throw new OpError(`替换的设计不符合 schema：${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
      const next = cloneDesign(v.value);
      design.schema_version = next.schema_version;
      design.catalog_versions = next.catalog_versions;
      design.metadata = { ...next.metadata, revision: design.metadata.revision };
      design.boards = next.boards;
      design.components = next.components;
      design.wires = next.wires;
      design.net_intents = next.net_intents;
      design.constraints = next.constraints;
      if (next.embedded_catalog) design.embedded_catalog = next.embedded_catalog;
      else delete design.embedded_catalog;
      if (next.view) design.view = next.view;
      changed.add('design');
      return;
    }
    default: {
      const unknown = op as { op?: string };
      throw new OpError(`未知操作 "${unknown.op}"`);
    }
  }
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function setPath(target: Record<string, JsonValue>, path: string[], value: JsonValue): void {
  let cur: Record<string, JsonValue> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    const next = cur[k];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, JsonValue>;
  }
  const last = path[path.length - 1]!;
  if (value === null && path.length > 1) delete cur[last];
  else cur[last] = value;
}

/** Refresh derived wire geometry so the saved file matches what the model computes. */
function normalizeWires(design: DesignDocument, catalog: Catalog): void {
  const model = buildModel(design, catalog);
  for (const w of design.wires) {
    const rw = model.wires.get(w.id);
    if (!rw) continue;
    if (w.path_mode === 'auto') w.waypoints_um = rw.waypoints_um.map((p) => [p[0], p[1]]);
  }
}

/**
 * Apply a batch of operations atomically. The input design is never mutated;
 * on any failure the original is returned untouched via `ok: false`.
 */
export function applyOps(design: DesignDocument, ops: Op[], options: ApplyOptions = {}): ApplyResult {
  const catalog = options.catalog ?? builtinCatalog();
  const previous_hash = designHash(design);
  if (options.expected_revision !== undefined && options.expected_revision !== design.metadata.revision) {
    return { ok: false, error: { code: 'revision_conflict', message: `期望 revision ${options.expected_revision}，当前为 ${design.metadata.revision}` } };
  }
  if (options.expected_hash !== undefined && options.expected_hash !== previous_hash) {
    return { ok: false, error: { code: 'revision_conflict', message: `期望 hash ${options.expected_hash.slice(0, 12)}…，当前为 ${previous_hash.slice(0, 12)}…` } };
  }
  const draft = cloneDesign(design);
  const changed = new Set<string>();
  for (let i = 0; i < ops.length; i++) {
    try {
      applyOne(draft, catalog, ops[i]!, changed);
    } catch (e) {
      if (e instanceof OpError) return { ok: false, error: { code: 'op_failed', message: `第 ${i + 1} 个操作（${ops[i]!.op}）失败：${e.message}`, op_index: i } };
      throw e;
    }
  }
  draft.metadata.revision = design.metadata.revision + 1;
  draft.metadata.updated_at = (options.now ?? (() => new Date().toISOString()))();
  const schema = validateDesignSchema(draft);
  if (!schema.ok) {
    return { ok: false, error: { code: 'schema_invalid', message: '修改后的设计不符合 schema', issues: schema.issues.map((i) => ({ path: i.path, message: i.message })) } };
  }
  normalizeWires(draft, catalog);
  const analysis = analyzeDesign(draft, catalog);
  if (analysis.hasBlocking && !options.allow_blocking) {
    const blocking = analysis.results.filter((r) => r.blocking);
    return { ok: false, error: { code: 'blocking_errors', message: `修改后存在 ${blocking.length} 个结构/物理错误，补丁未应用`, results: blocking } };
  }
  return { ok: true, design: draft, results: analysis.results, changed: [...changed], revision: draft.metadata.revision, hash: designHash(draft), previous_hash };
}

export function parsePatch(raw: unknown): { ok: true; patch: Patch } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'patch 必须是 JSON 对象' };
  const o = raw as Record<string, unknown>;
  const ops = Array.isArray(o.ops) ? o.ops : Array.isArray(raw) ? (raw as unknown[]) : null;
  if (!ops) return { ok: false, message: 'patch 需要 ops 数组' };
  for (const [i, op] of ops.entries()) {
    if (typeof op !== 'object' || op === null || typeof (op as { op?: unknown }).op !== 'string') return { ok: false, message: `ops[${i}] 缺少 op 字段` };
  }
  const patch: Patch = { ops: ops as Op[] };
  if (typeof o.expected_revision === 'number') patch.expected_revision = o.expected_revision;
  if (typeof o.expected_hash === 'string') patch.expected_hash = o.expected_hash;
  return { ok: true, patch };
}
