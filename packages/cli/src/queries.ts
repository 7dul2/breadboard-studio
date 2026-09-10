/**
 * The JSON data layer shared by the CLI (`main.ts`) and the MCP server
 * (`mcp.ts`). Every function here builds exactly the payload the CLI prints
 * with `--json`, so agents get one format whether they talk to `bb` over a
 * shell or over MCP — there is no second schema to keep in sync.
 *
 * Presentation (text rendering, exit codes, stdout) stays in `main.ts`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { builtinCatalog, CATALOG_VERSION } from '@breadboard-studio/catalog';
import { activeProgram, analyzeDesign, applyOps, buildSteps, catalogForDesign, conductiveSet, designHash, groupHoles, loadDesign, netOfAddress, parsePatch, serializeDesign, summarize, type AutoWireOptions, type AutoWirePlan, type RuleResult } from '@breadboard-studio/core';
import { exportSvg } from '@breadboard-studio/render';
import type { DesignDocument } from '@breadboard-studio/schema';

export const EXIT = { OK: 0, PROBLEMS: 1, USAGE: 2, CONFLICT: 3 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    public code: number = EXIT.USAGE,
    public extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export function readDesign(file: string): DesignDocument {
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`文件不存在：${file}`, EXIT.USAGE);
  const r = loadDesign(readFileSync(path, 'utf8'));
  if (!r.ok || !r.design) throw new CliError(`设计文件无效：${file}`, EXIT.PROBLEMS, { issues: r.errors });
  return r.design;
}

/** Write atomically: temp file + rename, so a failure never leaves a half-written design. */
export function writeAtomic(file: string, content: string): void {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function resultsJson(results: RuleResult[]) {
  return results.map((r) => ({ severity: r.severity, code: r.code, category: r.category, blocking: r.blocking, message: r.message, objects: r.objects, endpoints: r.endpoints ?? [], suggestion: r.suggestion ?? null }));
}

export function planJson(plan: AutoWirePlan) {
  return { host: plan.host, components: plan.components, optimization: plan.optimization, i2c_buses: plan.i2c_buses, config_changes: plan.config_changes, connections: plan.connections, bridges: plan.bridges, skipped: plan.skipped, unresolved: plan.unresolved, ops: plan.ops.length };
}

/** Program list without the source text (use `program export` for that). */
export function programsJson(design: DesignDocument) {
  return (design.programs ?? []).map((p) => ({ id: p.id, name: p.name, target_component_id: p.target_component_id, language: p.language, entry: p.entry ?? null, source_lines: p.source.length ? p.source.split('\n').length : 0 }));
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

/** `catalog list`. `design` adds the document's embedded definitions on top. */
export function catalogListData(design: DesignDocument | null) {
  const c = design ? catalogForDesign(design, builtinCatalog()) : builtinCatalog();
  const items = c.list().map((d) => ({
    ref: `${d.id}@${d.version}`,
    kind: d.kind,
    name: d.name,
    category: d.kind === 'component' ? d.category : 'board',
    mount: d.kind === 'component' ? d.mount : null,
    geometry_status: d.geometry_status,
    electrical_status: d.electrical_status,
    pins: d.kind === 'component' ? (d.pins.length ? d.pins.map((p) => p.name) : Object.keys(d.pin_meta)) : null,
    parametric: d.kind === 'component' && !!d.generator
  }));
  return { ok: true, command: 'catalog.list', catalog_version: CATALOG_VERSION, items };
}

/** `catalog inspect <ref>`. Throws when the ref does not exist. */
export function catalogInspectData(ref: string, design: DesignDocument | null) {
  const d = (design ? catalogForDesign(design, builtinCatalog()) : builtinCatalog()).get(ref);
  if (!d) throw new CliError(`目录中没有 ${ref}（使用 bb catalog list 查看）`);
  return { ok: true, command: 'catalog.inspect', definition: d };
}

/** The `ops` reference: every operation `apply_patch` accepts. */
export function opsData() {
  const ops = [
    { op: 'add_board', fields: 'board{id, model, name?, position_um?, rotation_deg?, attach_to?{board_id, side, gap_um?, grid_align?}}' },
    { op: 'remove_board', fields: 'id, cascade?' },
    { op: 'move_board', fields: 'id, position_um' },
    { op: 'rotate_board', fields: 'id, rotation_deg? | by_deg?' },
    { op: 'add_component', fields: 'component{id, model, name?, placement?, params?, config?, notes?}' },
    { op: 'remove_component', fields: 'id, cascade?' },
    { op: 'move_component', fields: 'id, placement{kind: board|off_board, ...}' },
    { op: 'rotate_component', fields: 'id, rotation_deg? | by_deg?' },
    { op: 'add_wire', fields: 'wire{id?, from{hole|terminal|pin}, to?{hole|terminal|pin}, color?, route?, path_mode?, waypoints_um?, name?}' },
    { op: 'remove_wire', fields: 'id' },
    { op: 'update_wire', fields: 'id, patch{name?, color?, route?, path_mode?, waypoints_um?, from?, to?, notes?, locked?}' },
    { op: 'update_property', fields: 'id, path (name|notes|locked|color|params.*|config.*|position_um|rotation_deg|route|path_mode|waypoints_um|endpoints), value' },
    { op: 'add_net_intent', fields: 'net_intent{id, name, endpoints[]}' },
    { op: 'remove_net_intent', fields: 'id' },
    { op: 'update_net_intent', fields: 'id, patch{name?, endpoints?, notes?}' },
    { op: 'add_constraint', fields: 'constraint{id, type: isolate|wire_length_max_um|note, ...}' },
    { op: 'remove_constraint', fields: 'id' },
    { op: 'set_metadata', fields: 'patch{name?, description?, author?, tags?, notes?}' },
    { op: 'replace_design', fields: 'design (完整设计文档)' },
    { op: 'add_definition', fields: 'definition (板/元件定义 JSON，内嵌到 embedded_catalog)' },
    { op: 'remove_definition', fields: 'ref (id@version)' },
    { op: 'auto_wire', fields: 'host, components[], options?{supply_voltage_v?, power_distribution?: auto|rail|direct, signal_pins?{"comp.pin": "hostPin"}, net_intents?, route?: auto|flat|elevated, optimize?: global|greedy, time_budget_ms?, i2c_conflicts?: bus_first|address_first|report, require_all?}' },
    { op: 'add_program', fields: 'program{id, name, target_component_id (必须是现有元件), source, language?: studio-ts, entry?}' },
    { op: 'update_program', fields: 'id, patch{name?, target_component_id?, source?, entry?, language?}' },
    { op: 'remove_program', fields: 'id（同时清除 simulation.active_program_id）' },
    { op: 'set_simulation_config', fields: 'patch{active_program_id?, speed?: 0.1|0.25|0.5|1|2|5|10, random_seed?, usb_powered_components?[]}（值为 null 表示清除该键；引用必须存在）' }
  ];
  return { ok: true, command: 'ops', ops };
}

// ---------------------------------------------------------------------------
// read-only design queries
// ---------------------------------------------------------------------------

/** `inspect <file>`: boards, component pin placement, wires, nets. */
export function inspectData(file: string) {
  const design = readDesign(file);
  const a = analyzeDesign(design);
  const boards = [...a.model.boards.values()].map((b) => ({ id: b.instance.id, name: b.instance.name ?? null, model: b.instance.model, position_um: b.instance.position_um, rotation_deg: b.instance.rotation_deg, holes: b.resolved.holes.size }));
  const components = [...a.model.components.values()].map((c) => ({
    id: c.instance.id,
    name: c.instance.name ?? null,
    model: c.instance.model,
    placement: c.instance.placement,
    on_board: c.onBoard,
    geometry_status: c.def.geometry_status,
    electrical_status: c.def.electrical_status,
    pins: c.pins.map((p) => ({ name: p.name, role: p.meta.role, hole: p.hole ? `${p.hole.board_id}.${p.hole.hole}` : null })),
    blocked_holes: c.blockedHoles.map((h) => `${h.board_id}.${h.hole}`)
  }));
  const wires = [...a.model.wires.values()].map((w) => ({ id: w.instance.id, name: w.instance.name ?? null, from: w.from?.address ?? null, to: w.to?.address ?? null, color: w.instance.color, route: w.instance.route, length_um: w.length_um, conducts: w.conducts }));
  const nets = a.connectivity.nets.map((n) => ({ id: n.id, name: n.name, intents: n.intent_ids, pins: n.pins, wires: n.wires, holes: n.holes.length }));
  return { ok: true, command: 'inspect', file, metadata: design.metadata, revision: design.metadata.revision, hash: designHash(design), catalog_versions: design.catalog_versions, boards, components, wires, nets, programs: programsJson(design), active_program_id: activeProgram(design)?.id ?? null, simulation: design.simulation ?? null, summary: a.summary };
}

export type FailOn = 'error' | 'warning' | 'never';

/** `validate <file>`: full rule results; `ok` is false when the failOn level is met. */
export function validateData(file: string, failOn: FailOn = 'error') {
  const design = readDesign(file);
  const a = analyzeDesign(design);
  const s = a.summary;
  const failed = failOn === 'never' ? false : failOn === 'warning' ? s.error + s.warning > 0 : s.error > 0;
  return { ok: !failed, command: 'validate', file, revision: design.metadata.revision, hash: designHash(design), summary: s, results: resultsJson(a.results) };
}

/** `connectivity <file> --from <address>`: internal group, net and conductive set. */
export function connectivityData(file: string, from: string) {
  const design = readDesign(file);
  const a = analyzeDesign(design);
  const group = groupHoles(a.model, from);
  const net = netOfAddress(a.model, a.connectivity, from);
  const set = conductiveSet(a.model, a.connectivity, from);
  if (!group.length && !set.holes.length && !set.pins.length) throw new CliError(`地址 ${from} 不存在`, EXIT.USAGE);
  return { ok: true, command: 'connectivity', file, from, group, net: net ? { id: net.id, name: net.name, intents: net.intent_ids, pins: net.pins, wires: net.wires } : null, conductive: set };
}

/** `steps <file>`: wire-by-wire build instructions. */
export function stepsData(file: string) {
  const design = readDesign(file);
  const a = analyzeDesign(design);
  const steps = buildSteps(a.model, a.connectivity, design.view?.build_done ?? []);
  return { ok: true, command: 'steps', file, count: steps.length, note: '搭建步骤只是指导，不代表实物已经导通；长度不含插入深度与弯折余量。', steps };
}

/** `programs <file>`: program list and simulation config, without source text. */
export function programsData(file: string) {
  const design = readDesign(file);
  const programs = programsJson(design);
  const active = activeProgram(design);
  return { ok: true, command: 'programs', file, name: design.metadata.name, revision: design.metadata.revision, hash: designHash(design), programs, simulation: design.simulation ?? null, active_program_id: active?.id ?? null };
}

/** `export <file>`: SVG or canonical JSON, returned inline — never writes a file. */
export function exportDesignData(file: string, opts: { format?: 'svg' | 'json'; legend?: boolean; holeLabels?: boolean; pinLabels?: boolean; title?: string }) {
  const design = readDesign(file);
  const format = opts.format ?? 'svg';
  let content: string;
  if (format === 'svg') {
    const a = analyzeDesign(design);
    content = exportSvg(a.model, { legend: opts.legend !== false, showHoleLabels: !!opts.holeLabels, showPinLabels: opts.pinLabels !== false, title: opts.title ?? design.metadata.name });
  } else if (format === 'json') {
    content = serializeDesign(design);
  } else throw new CliError(`不支持的格式 ${format}（svg|json）`);
  return { ok: true, command: 'export', file, format, bytes: content.length, content };
}

// ---------------------------------------------------------------------------
// transactions (write only when the caller opts in)
// ---------------------------------------------------------------------------

export interface ApplyPatchArgs {
  /** Parsed patch object: `{expected_revision?, expected_hash?, ops: [...]}`. */
  patch: unknown;
  out?: string;
  /** true = only report, never write (the safe default everywhere). */
  dryRun: boolean;
  expectRevision?: number;
  expectHash?: string;
  /** Write even when blocking errors remain. */
  force?: boolean;
}

/** `apply <file> --patch …`: atomic structured patch. */
export function applyPatchData(file: string, args: ApplyPatchArgs) {
  const design = readDesign(file);
  const parsed = parsePatch(args.patch);
  if (!parsed.ok) throw new CliError(`补丁无效：${parsed.message}`);
  const patch = parsed.patch;
  const r = applyOps(design, patch.ops, {
    expected_revision: args.expectRevision ?? patch.expected_revision,
    expected_hash: args.expectHash ?? patch.expected_hash,
    allow_blocking: !!args.force
  });
  if (!r.ok) {
    const code = r.error.code === 'revision_conflict' ? EXIT.CONFLICT : EXIT.PROBLEMS;
    throw new CliError(r.error.message, code, { error: { ...r.error, results: r.error.results ? resultsJson(r.error.results) : undefined } });
  }
  const target = args.out ?? file;
  if (!args.dryRun) writeAtomic(target, serializeDesign(r.design));
  const s = summarize(r.results);
  return { ok: true, command: 'apply', file, out: args.dryRun ? null : target, dry_run: !!args.dryRun, previous_revision: design.metadata.revision, revision: r.revision, previous_hash: r.previous_hash, hash: r.hash, changed: r.changed, reports: r.reports.map((x) => ({ op: x.op, op_index: x.op_index, plan: planJson(x.plan) })), summary: s, results: resultsJson(r.results) };
}

export interface AutoWireArgs {
  host: string;
  components?: string[];
  all?: boolean;
  supply?: number;
  power?: AutoWireOptions['power_distribution'];
  route?: AutoWireOptions['route'];
  /** Generate/update net_intents (default true, like `bb autowire`). */
  intents?: boolean;
  optimize?: AutoWireOptions['optimize'];
  i2cConflicts?: AutoWireOptions['i2c_conflicts'];
  timeBudget?: number;
  signalPins?: Record<string, string>;
  requireAll?: boolean;
  out?: string;
  dryRun: boolean;
  expectRevision?: number;
  expectHash?: string;
}

/** `autowire <file>`: plan pin-role wiring with the same engine as the UI. */
export function autowireData(file: string, args: AutoWireArgs) {
  const design = readDesign(file);
  let components: string[];
  if (args.all) components = design.components.map((c) => c.id).filter((id) => id !== args.host);
  else if (args.components?.length) components = args.components;
  else throw new CliError('请用 --components a,b,c 或 --all 指定外设');
  const options: AutoWireOptions = {
    power_distribution: args.power ?? 'auto',
    route: args.route ?? 'auto',
    net_intents: args.intents !== false,
    optimize: args.optimize ?? 'global',
    i2c_conflicts: args.i2cConflicts ?? 'bus_first',
    ...(args.timeBudget !== undefined ? { time_budget_ms: args.timeBudget } : {}),
    ...(args.supply !== undefined ? { supply_voltage_v: args.supply } : {}),
    ...(args.signalPins && Object.keys(args.signalPins).length ? { signal_pins: args.signalPins } : {}),
    ...(args.requireAll ? { require_all: true } : {})
  };
  const r = applyOps(design, [{ op: 'auto_wire', host: args.host, components, options }], { expected_revision: args.expectRevision, expected_hash: args.expectHash });
  if (!r.ok) {
    const code = r.error.code === 'revision_conflict' ? EXIT.CONFLICT : EXIT.PROBLEMS;
    throw new CliError(r.error.message, code, { error: { ...r.error, results: r.error.results ? resultsJson(r.error.results) : undefined } });
  }
  const plan = r.reports.find((x) => x.op === 'auto_wire')!.plan;
  const target = args.out ?? file;
  if (!args.dryRun) writeAtomic(target, serializeDesign(r.design));
  const s = summarize(r.results);
  return { ok: true, command: 'autowire', file, out: args.dryRun ? null : target, dry_run: !!args.dryRun, previous_revision: design.metadata.revision, revision: r.revision, previous_hash: r.previous_hash, hash: r.hash, plan: planJson(plan), changed: r.changed, summary: s, results: resultsJson(r.results), note: '按目录引脚角色生成导线，不是电气仿真；请核对 needs_review 项。' };
}
