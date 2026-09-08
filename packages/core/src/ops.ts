import type { ComponentInstance, Constraint, DesignDocument, DesignMetadata, JsonValue, NetIntent, Placement, PointUm, ProgramAsset, ProgramLanguage, RotationDeg, SimulationConfig, WireEndpoint, WireInstance, WireRoute, WirePathMode } from '@breadboard-studio/schema';
import { PROGRAM_LANGUAGES, SIMULATION_SPEEDS, migrateDesign, validateDesignSchema } from '@breadboard-studio/schema';
import { Catalog, builtinCatalog } from '@breadboard-studio/catalog';
import { parseAddress } from './address.js';
import { analyzeDesign } from './analyze.js';
import { cloneDesign, designHash } from './design.js';
import { normalizeRotation } from './geometry.js';
import { attachBoardPosition, nextFreePosition, type AttachSide } from './layout.js';
import { accessibleHolesForPin, buildModel, catalogForDesign } from './model.js';
import { AutoWireError, planAutoWire, type AutoWireOptions, type AutoWirePlan } from './autowire.js';
import { sortResults, type RuleResult } from './results.js';

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
  | { op: 'replace_design'; design: DesignDocument }
  /** Embed a board/component definition (validated against the definition schema) so the design carries it. */
  | { op: 'add_definition'; definition: unknown }
  | { op: 'remove_definition'; ref: string }
  /** Auto-wire peripherals to a host by pin role (power/ground via rails, I²C, free GPIOs). Expands into add_wire / net intent ops. */
  | { op: 'auto_wire'; host: string; components: string[]; options?: AutoWireOptions }
  /** Programs (schema 1.1) are design content: the target component must exist; `language` defaults to studio-ts. */
  | { op: 'add_program'; program: Omit<ProgramAsset, 'language'> & { language?: ProgramLanguage } }
  | { op: 'update_program'; id: string; patch: Partial<Omit<ProgramAsset, 'id'>> }
  | { op: 'remove_program'; id: string }
  /** Merge into `simulation`; `null` clears a key. Referenced programs/components must exist. */
  | { op: 'set_simulation_config'; patch: SimulationConfigPatch };

export type SimulationConfigPatch = { [K in keyof SimulationConfig]?: SimulationConfig[K] | null };

/** Extra output produced by ops that plan work (currently only `auto_wire`). */
export type OpReport = { op: 'auto_wire'; op_index: number; plan: AutoWirePlan };

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
  | { ok: true; design: DesignDocument; results: RuleResult[]; changed: string[]; revision: number; hash: string; previous_hash: string; reports: OpReport[] }
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

function allIds(design: DesignDocument): { id: string }[] {
  return [...design.boards, ...design.components, ...design.wires, ...design.net_intents, ...design.constraints, ...(design.programs ?? [])];
}

function ensureUniqueId(design: DesignDocument, id: string): void {
  if (allIds(design).some((o) => o.id === id)) throw new OpError(`ID "${id}" 已被占用`);
}

function nextId(design: DesignDocument, prefix: string): string {
  const used = new Set(allIds(design).map((o) => o.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function addressBelongsTo(address: string, owners: Set<string>): boolean {
  const parsed = parseAddress(address);
  return !!parsed && owners.has(parsed.owner);
}

function wireBelongsToOwners(wire: WireInstance, owners: Set<string>): boolean {
  return [wire.from, wire.to].some((endpoint) => {
    const address = endpoint?.hole ?? endpoint?.terminal;
    return !!address && addressBelongsTo(address, owners);
  });
}

function programsTargeting(design: DesignDocument, owners: Set<string>): ProgramAsset[] {
  return (design.programs ?? []).filter((program) => owners.has(program.target_component_id));
}

/** Drop simulation settings that point at removed programs/components; delete the section when it becomes empty. */
function pruneSimulationConfig(design: DesignDocument, removedPrograms: Set<string>, removedOwners: Set<string>, changed: Set<string>): void {
  const sim = design.simulation;
  if (!sim) return;
  const next: SimulationConfig = { ...sim };
  let touched = false;
  if (next.active_program_id !== undefined && removedPrograms.has(next.active_program_id)) {
    delete next.active_program_id;
    touched = true;
  }
  if (next.usb_powered_components) {
    const kept = next.usb_powered_components.filter((id) => !removedOwners.has(id));
    if (kept.length !== next.usb_powered_components.length) {
      touched = true;
      if (kept.length) next.usb_powered_components = kept;
      else delete next.usb_powered_components;
    }
  }
  if (!touched) return;
  changed.add('simulation');
  if (Object.keys(next).length) design.simulation = next;
  else delete design.simulation;
}

/** Remove or trim declarations that would otherwise retain dangling references after a cascade. */
function pruneDependentReferences(design: DesignDocument, removedOwners: Set<string>, removedWireIds: Set<string>, changed: Set<string>): void {
  const removedPrograms = new Set<string>();
  if (design.programs?.length) {
    design.programs = design.programs.filter((program) => {
      if (!removedOwners.has(program.target_component_id)) return true;
      removedPrograms.add(program.id);
      changed.add(program.id);
      return false;
    });
    if (!design.programs.length) delete design.programs;
  }
  pruneSimulationConfig(design, removedPrograms, removedOwners, changed);

  design.net_intents = design.net_intents.flatMap((intent) => {
    const endpoints = intent.endpoints.filter((endpoint) => !addressBelongsTo(endpoint, removedOwners));
    if (endpoints.length === intent.endpoints.length) return [intent];
    changed.add(intent.id);
    return endpoints.length ? [{ ...intent, endpoints }] : [];
  });

  design.constraints = design.constraints.flatMap((constraint) => {
    if (constraint.type === 'isolate' && (addressBelongsTo(constraint.a, removedOwners) || addressBelongsTo(constraint.b, removedOwners))) {
      changed.add(constraint.id);
      return [];
    }
    if (constraint.type === 'wire_length_max_um' && constraint.wire_ids) {
      const wireIds = constraint.wire_ids.filter((id) => !removedWireIds.has(id));
      if (wireIds.length === constraint.wire_ids.length) return [constraint];
      changed.add(constraint.id);
      return wireIds.length ? [{ ...constraint, wire_ids: wireIds }] : [];
    }
    return [constraint];
  });
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

interface OpContext {
  changed: Set<string>;
  reports: OpReport[];
  notes: RuleResult[];
  op_index: number;
}

function applyOne(design: DesignDocument, catalog: Catalog, op: Op, changed: Set<string>, ctx?: OpContext): void {
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
      const owners = new Set([op.id, ...dependents.map((component) => component.id)]);
      const wires = design.wires.filter((wire) => wireBelongsToOwners(wire, owners));
      const intents = design.net_intents.filter((intent) => intent.endpoints.some((endpoint) => addressBelongsTo(endpoint, owners)));
      const constraints = design.constraints.filter((constraint) => constraint.type === 'isolate' && (addressBelongsTo(constraint.a, owners) || addressBelongsTo(constraint.b, owners)));
      const programs = programsTargeting(design, owners);
      if ((dependents.length || wires.length || intents.length || constraints.length || programs.length) && !op.cascade) {
        throw new OpError(`面包板 "${op.id}" 仍被使用：元件 ${dependents.map((d) => d.id).join(', ') || '无'}；导线 ${wires.map((w) => w.id).join(', ') || '无'}；网络意图 ${intents.map((n) => n.id).join(', ') || '无'}；约束 ${constraints.map((c) => c.id).join(', ') || '无'}；程序 ${programs.map((p) => p.id).join(', ') || '无'}。设置 cascade=true 一并清理`);
      }
      for (const d of dependents) changed.add(d.id);
      for (const w of wires) changed.add(w.id);
      design.components = design.components.filter((c) => !dependents.includes(c));
      design.wires = design.wires.filter((w) => !wires.includes(w));
      design.boards = design.boards.filter((x) => x.id !== op.id);
      pruneDependentReferences(design, owners, new Set(wires.map((wire) => wire.id)), changed);
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
      const owners = new Set([op.id]);
      const wires = design.wires.filter((wire) => wireBelongsToOwners(wire, owners));
      const intents = design.net_intents.filter((intent) => intent.endpoints.some((endpoint) => addressBelongsTo(endpoint, owners)));
      const constraints = design.constraints.filter((constraint) => constraint.type === 'isolate' && (addressBelongsTo(constraint.a, owners) || addressBelongsTo(constraint.b, owners)));
      const programs = programsTargeting(design, owners);
      if ((wires.length || intents.length || constraints.length || programs.length) && !op.cascade) {
        throw new OpError(`元件 "${op.id}" 仍被使用：导线 ${wires.map((w) => w.id).join(', ') || '无'}；网络意图 ${intents.map((n) => n.id).join(', ') || '无'}；约束 ${constraints.map((item) => item.id).join(', ') || '无'}；程序 ${programs.map((p) => p.id).join(', ') || '无'}。设置 cascade=true 一并清理`);
      }
      design.wires = design.wires.filter((w) => !wires.includes(w));
      for (const w of wires) changed.add(w.id);
      design.components = design.components.filter((x) => x.id !== op.id);
      pruneDependentReferences(design, owners, new Set(wires.map((wire) => wire.id)), changed);
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
      pruneDependentReferences(design, new Set(), new Set([op.id]), changed);
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
      const mig = migrateDesign(op.design);
      if (!mig.ok) throw new OpError(`替换的设计无法载入：${mig.error}`);
      const v = validateDesignSchema(mig.doc);
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
      if (next.programs?.length) design.programs = next.programs;
      else delete design.programs;
      if (next.simulation && Object.keys(next.simulation).length) design.simulation = next.simulation;
      else delete design.simulation;
      if (next.view) design.view = next.view;
      changed.add('design');
      return;
    }
    case 'add_program': {
      const p = op.program;
      ensureUniqueId(design, p.id);
      const language = p.language ?? 'studio-ts';
      if (!(PROGRAM_LANGUAGES as readonly string[]).includes(language)) throw new OpError(`不支持的程序语言 "${language}"（支持：${PROGRAM_LANGUAGES.join(', ')}）`);
      if (typeof p.source !== 'string') throw new OpError(`程序 "${p.id}" 缺少 source 字符串`);
      if (!design.components.some((c) => c.id === p.target_component_id)) throw new OpError(`程序 "${p.id}" 的目标元件 "${p.target_component_id}" 不存在`);
      const program: ProgramAsset = { id: p.id, name: p.name, target_component_id: p.target_component_id, language, source: p.source, ...(p.entry ? { entry: p.entry } : {}) };
      design.programs = [...(design.programs ?? []), program];
      changed.add(p.id);
      return;
    }
    case 'update_program': {
      const p = mustFind(design.programs ?? [], op.id, '程序');
      const { id: _id, ...rest } = op.patch as Partial<ProgramAsset>;
      const patch = stripUndefined(rest);
      if (patch.language !== undefined && !(PROGRAM_LANGUAGES as readonly string[]).includes(patch.language)) throw new OpError(`不支持的程序语言 "${patch.language}"（支持：${PROGRAM_LANGUAGES.join(', ')}）`);
      if (patch.target_component_id !== undefined && !design.components.some((c) => c.id === patch.target_component_id)) throw new OpError(`程序 "${op.id}" 的目标元件 "${patch.target_component_id}" 不存在`);
      Object.assign(p, patch);
      changed.add(op.id);
      return;
    }
    case 'remove_program': {
      mustFind(design.programs ?? [], op.id, '程序');
      design.programs = (design.programs ?? []).filter((p) => p.id !== op.id);
      if (!design.programs.length) delete design.programs;
      pruneSimulationConfig(design, new Set([op.id]), new Set(), changed);
      changed.add(op.id);
      return;
    }
    case 'set_simulation_config': {
      if (typeof op.patch !== 'object' || op.patch === null || Array.isArray(op.patch)) throw new OpError('set_simulation_config 需要一个 patch 对象');
      const cfg: Record<string, unknown> = { ...(design.simulation ?? {}) };
      for (const [key, value] of Object.entries(op.patch)) {
        if (value === undefined) continue;
        if (value === null) delete cfg[key];
        else cfg[key] = value;
      }
      const next = cfg as SimulationConfig;
      if (next.active_program_id !== undefined && !(design.programs ?? []).some((p) => p.id === next.active_program_id)) throw new OpError(`程序 "${next.active_program_id}" 不存在，不能设为启动程序`);
      if (next.speed !== undefined && !(SIMULATION_SPEEDS as readonly number[]).includes(next.speed)) throw new OpError(`仿真倍速必须是 ${SIMULATION_SPEEDS.join('/')} 之一`);
      if (next.random_seed !== undefined && (!Number.isInteger(next.random_seed) || next.random_seed < 0)) throw new OpError('random_seed 必须是非负整数');
      for (const id of next.usb_powered_components ?? []) if (!design.components.some((c) => c.id === id)) throw new OpError(`usb_powered_components 引用的元件 "${id}" 不存在`);
      if (next.usb_powered_components && !next.usb_powered_components.length) delete next.usb_powered_components;
      if (Object.keys(next).length) design.simulation = next;
      else delete design.simulation;
      changed.add('simulation');
      return;
    }
    case 'add_definition': {
      const probe = new Catalog();
      const r = probe.addUnknown(op.definition);
      if (!r.ok) throw new OpError(`元件定义无效：${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
      const def = r.def;
      const emb = design.embedded_catalog ?? {};
      const ref = `${def.id}@${def.version}`;
      if (def.kind === 'board') emb.boards = [...(emb.boards ?? []).filter((d) => `${d.id}@${d.version}` !== ref), def];
      else emb.components = [...(emb.components ?? []).filter((d) => `${d.id}@${d.version}` !== ref), def];
      design.embedded_catalog = emb;
      changed.add(ref);
      return;
    }
    case 'remove_definition': {
      const emb = design.embedded_catalog;
      const inUse = [...design.boards, ...design.components].filter((o) => o.model === op.ref);
      if (inUse.length) throw new OpError(`定义 ${op.ref} 仍被 ${inUse.map((o) => o.id).join(', ')} 使用`);
      if (!emb) throw new OpError(`设计中没有内嵌定义 ${op.ref}`);
      const before = (emb.boards?.length ?? 0) + (emb.components?.length ?? 0);
      emb.boards = (emb.boards ?? []).filter((d) => `${d.id}@${d.version}` !== op.ref);
      emb.components = (emb.components ?? []).filter((d) => `${d.id}@${d.version}` !== op.ref);
      if ((emb.boards.length + emb.components.length) === before) throw new OpError(`设计中没有内嵌定义 ${op.ref}`);
      if (!emb.boards.length) delete emb.boards;
      if (!emb.components.length) delete emb.components;
      if (!emb.boards && !emb.components) delete design.embedded_catalog;
      changed.add(op.ref);
      return;
    }
    case 'auto_wire': {
      let plan: AutoWirePlan;
      try {
        plan = planAutoWire(design, catalog, { host: op.host, components: op.components, ...(op.options ?? {}) });
      } catch (e) {
        if (e instanceof AutoWireError) throw new OpError(`自动布线失败：${e.message}`);
        throw e;
      }
      if (op.options?.require_all && plan.unresolved.length) {
        throw new OpError(`自动布线有 ${plan.unresolved.length} 个引脚无法连接（require_all）：${plan.unresolved.map((u) => `${u.component}.${u.pin} ${u.reason}`).join('；')}`);
      }
      for (const sub of plan.ops) applyOne(design, catalog, sub, changed);
      if (ctx) {
        ctx.reports.push({ op: 'auto_wire', op_index: ctx.op_index, plan });
        ctx.notes.push(...plan.results);
      }
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
  const ctx: OpContext = { changed, reports: [], notes: [], op_index: 0 };
  for (let i = 0; i < ops.length; i++) {
    ctx.op_index = i;
    try {
      applyOne(draft, catalogForDesign(draft, catalog), ops[i]!, changed, ctx);
    } catch (e) {
      if (e instanceof OpError) return { ok: false, error: { code: 'op_failed', message: `第 ${i + 1} 个操作（${ops[i]!.op}）失败：${e.message}`, op_index: i } };
      throw e;
    }
  }
  if (draft.programs && !draft.programs.length) delete draft.programs;
  if (draft.simulation && !Object.keys(draft.simulation).length) delete draft.simulation;
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
  const results = ctx.notes.length ? sortResults([...analysis.results, ...ctx.notes]) : analysis.results;
  return { ok: true, design: draft, results, changed: [...changed], revision: draft.metadata.revision, hash: designHash(draft), previous_hash, reports: ctx.reports };
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
