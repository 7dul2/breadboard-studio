#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { builtinCatalog, CATALOG_VERSION } from '@breadboard-studio/catalog';
import { designSchema } from '@breadboard-studio/schema';
import type { DesignDocument } from '@breadboard-studio/schema';
import { analyzeDesign, applyOps, buildSteps, catalogForDesign, conductiveSet, createEmptyDesign, designHash, groupHoles, loadDesign, netOfAddress, parsePatch, serializeDesign, summarize, type RuleResult } from '@breadboard-studio/core';
import { exportSvg } from '@breadboard-studio/render';

export const EXIT = { OK: 0, PROBLEMS: 1, USAGE: 2, CONFLICT: 3 } as const;

class CliError extends Error {
  constructor(
    message: string,
    public code: number = EXIT.USAGE,
    public extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

function readDesign(file: string): DesignDocument {
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`文件不存在：${file}`, EXIT.USAGE);
  const r = loadDesign(readFileSync(path, 'utf8'));
  if (!r.ok || !r.design) throw new CliError(`设计文件无效：${file}`, EXIT.PROBLEMS, { issues: r.errors });
  return r.design;
}

/** Write atomically: temp file + rename, so a failure never leaves a half-written design. */
function writeAtomic(file: string, content: string): void {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function out(json: boolean, data: Record<string, unknown>, text: () => string): void {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(text() + '\n');
}

function fmtResult(r: RuleResult): string {
  const tag = { error: 'ERROR', warning: 'WARN ', info: 'INFO ', needs_review: 'REVIEW' }[r.severity];
  const eps = r.endpoints?.length ? `  @ ${r.endpoints.join(', ')}` : '';
  const sug = r.suggestion ? `\n      → ${r.suggestion}` : '';
  return `  [${tag}] ${r.code}${r.blocking ? ' (blocking)' : ''}: ${r.message}${eps}${sug}`;
}

function resultsJson(results: RuleResult[]) {
  return results.map((r) => ({ severity: r.severity, code: r.code, category: r.category, blocking: r.blocking, message: r.message, objects: r.objects, endpoints: r.endpoints ?? [], suggestion: r.suggestion ?? null }));
}

export function buildProgram(): Command {
  const program = new Command();
  program.name('bb').description('Breadboard Studio CLI — 面向 Agent 的面包板设计校验/修改/导出工具').version(`0.1.0 (catalog ${CATALOG_VERSION})`);
  program.showHelpAfterError();

  const catalog = program.command('catalog').description('元件与面包板目录');
  catalog
    .command('list')
    .description('列出目录中的定义（--design 时包含设计文件内嵌的定义）')
    .option('--design <file>', '同时列出该设计 embedded_catalog 中的定义')
    .option('--json', 'JSON 输出')
    .action((opts: { json?: boolean; design?: string }) => {
      const c = opts.design ? catalogForDesign(readDesign(opts.design), builtinCatalog()) : builtinCatalog();
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
      out({ json: !!opts.json }.json, { ok: true, command: 'catalog.list', catalog_version: CATALOG_VERSION, items }, () =>
        items.map((i) => `${i.ref.padEnd(28)} ${i.kind.padEnd(9)} geo=${i.geometry_status.padEnd(11)} elec=${i.electrical_status.padEnd(11)} ${i.name}`).join('\n')
      );
    });
  catalog
    .command('inspect <ref>')
    .description('显示一个定义的完整内容（含引脚、参数 schema、来源与状态）')
    .option('--design <file>', '同时查找该设计内嵌的定义')
    .option('--json', 'JSON 输出')
    .action((ref: string, opts: { json?: boolean; design?: string }) => {
      const d = (opts.design ? catalogForDesign(readDesign(opts.design), builtinCatalog()) : builtinCatalog()).get(ref);
      if (!d) throw new CliError(`目录中没有 ${ref}（使用 bb catalog list 查看）`);
      out(!!opts.json, { ok: true, command: 'catalog.inspect', definition: d }, () => JSON.stringify(d, null, 2));
    });

  program
    .command('new <out>')
    .description('创建一个新的空设计文件')
    .option('--name <name>', '项目名称', '未命名项目')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { name: string; json?: boolean }) => {
      const d = createEmptyDesign(opts.name);
      writeAtomic(file, serializeDesign(d));
      out(!!opts.json, { ok: true, command: 'new', file, revision: d.metadata.revision, hash: designHash(d) }, () => `已创建 ${file}`);
    });

  program
    .command('schema')
    .description('输出设计文件的 JSON Schema (2020-12)')
    .action(() => {
      process.stdout.write(JSON.stringify(designSchema, null, 2) + '\n');
    });

  program
    .command('ops')
    .description('列出 apply 支持的操作类型')
    .option('--json', 'JSON 输出')
    .action((opts: { json?: boolean }) => {
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
        { op: 'remove_definition', fields: 'ref (id@version)' }
      ];
      out(!!opts.json, { ok: true, command: 'ops', ops }, () => ops.map((o) => `${o.op.padEnd(20)} ${o.fields}`).join('\n'));
    });

  program
    .command('inspect <file>')
    .description('汇总设计：元数据、面包板、元件引脚落孔、导线、网络')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { json?: boolean }) => {
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
      const data = { ok: true, command: 'inspect', file, metadata: design.metadata, revision: design.metadata.revision, hash: designHash(design), catalog_versions: design.catalog_versions, boards, components, wires, nets, summary: a.summary };
      out(!!opts.json, data, () => {
        const lines = [`${design.metadata.name}  (revision ${design.metadata.revision}, hash ${designHash(design).slice(0, 12)})`, `面包板 ${boards.length}，元件 ${components.length}，导线 ${wires.length}，网络 ${nets.length}`];
        for (const b of boards) lines.push(`  board ${b.id} ${b.model} @ (${b.position_um.join(', ')}) rot ${b.rotation_deg}`);
        for (const c of components) lines.push(`  component ${c.id} ${c.model} ${c.on_board ? '' : '(板外)'}: ${c.pins.map((p) => `${p.name}${p.hole ? '=' + p.hole : ''}`).join(' ')}`);
        for (const w of wires) lines.push(`  wire ${w.id} ${w.color} ${w.from} → ${w.to ?? '(草稿)'} ${(w.length_um / 1000).toFixed(1)}mm`);
        for (const n of nets) lines.push(`  net ${n.name}: ${n.pins.join(', ')}`);
        lines.push(`结果：error ${a.summary.error}, warning ${a.summary.warning}, needs_review ${a.summary.needs_review}, info ${a.summary.info}`);
        return lines.join('\n');
      });
    });

  program
    .command('validate <file>')
    .description('运行全部规则；存在 error 时退出码 1')
    .option('--json', 'JSON 输出')
    .option('--fail-on <level>', 'error|warning|never', 'error')
    .action((file: string, opts: { json?: boolean; failOn: string }) => {
      const design = readDesign(file);
      const a = analyzeDesign(design);
      const s = a.summary;
      const failed = opts.failOn === 'never' ? false : opts.failOn === 'warning' ? s.error + s.warning > 0 : s.error > 0;
      out(!!opts.json, { ok: !failed, command: 'validate', file, revision: design.metadata.revision, hash: designHash(design), summary: s, results: resultsJson(a.results) }, () => {
        const lines = [`${file}: ${s.error} error, ${s.warning} warning, ${s.needs_review} needs_review, ${s.info} info${s.blocking ? ` (${s.blocking} blocking)` : ''}`];
        for (const r of a.results) lines.push(fmtResult(r));
        lines.push(failed ? '未通过。' : '没有 error。注意：这不等于电路已验证；needs_review 项需人工核对。');
        return lines.join('\n');
      });
      if (failed) process.exitCode = EXIT.PROBLEMS;
    });

  program
    .command('connectivity <file>')
    .description('查询一个孔或端子的内部导通组与实际网络')
    .requiredOption('--from <address>', '孔地址 board.hole 或端子 component.pin')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { from: string; json?: boolean }) => {
      const design = readDesign(file);
      const a = analyzeDesign(design);
      const group = groupHoles(a.model, opts.from);
      const net = netOfAddress(a.model, a.connectivity, opts.from);
      const set = conductiveSet(a.model, a.connectivity, opts.from);
      if (!group.length && !set.holes.length && !set.pins.length) throw new CliError(`地址 ${opts.from} 不存在`, EXIT.USAGE);
      const data = { ok: true, command: 'connectivity', file, from: opts.from, group, net: net ? { id: net.id, name: net.name, intents: net.intent_ids, pins: net.pins, wires: net.wires } : null, conductive: set };
      out(!!opts.json, data, () => {
        const lines = [`${opts.from}`];
        lines.push(`  内部导通组：${group.join(', ') || '（端子，无板内组）'}`);
        lines.push(`  导通集合：${set.holes.length} 孔，${set.pins.length} 引脚`);
        if (set.pins.length) lines.push(`  引脚：${set.pins.join(', ')}`);
        lines.push(`  网络：${net ? `${net.name} (${net.id})，导线 ${net.wires.join(', ') || '无'}` : '无（未接线）'}`);
        return lines.join('\n');
      });
    });

  program
    .command('apply <file>')
    .description('原子应用结构化补丁（ops 数组）；失败时不写文件')
    .requiredOption('--patch <patch>', '补丁 JSON 文件（{expected_revision?, expected_hash?, ops: [...]}）')
    .option('--out <out>', '输出文件（默认覆盖输入文件）')
    .option('--dry-run', '只报告，不写入')
    .option('--expect-revision <n>', '期望的 revision', (v) => Number(v))
    .option('--expect-hash <hash>', '期望的内容 hash')
    .option('--force', '即使存在 blocking 错误也写入')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { patch: string; out?: string; dryRun?: boolean; expectRevision?: number; expectHash?: string; force?: boolean; json?: boolean }) => {
      const design = readDesign(file);
      let rawPatch: unknown;
      try {
        rawPatch = JSON.parse(readFileSync(resolve(opts.patch), 'utf8'));
      } catch (e) {
        throw new CliError(`补丁文件无法读取或不是 JSON：${(e as Error).message}`);
      }
      const parsed = parsePatch(rawPatch);
      if (!parsed.ok) throw new CliError(`补丁无效：${parsed.message}`);
      const patch = parsed.patch;
      const r = applyOps(design, patch.ops, {
        expected_revision: opts.expectRevision ?? patch.expected_revision,
        expected_hash: opts.expectHash ?? patch.expected_hash,
        allow_blocking: !!opts.force
      });
      if (!r.ok) {
        const code = r.error.code === 'revision_conflict' ? EXIT.CONFLICT : EXIT.PROBLEMS;
        throw new CliError(r.error.message, code, { error: { ...r.error, results: r.error.results ? resultsJson(r.error.results) : undefined } });
      }
      const target = opts.out ?? file;
      if (!opts.dryRun) writeAtomic(target, serializeDesign(r.design));
      const s = summarize(r.results);
      out(!!opts.json, { ok: true, command: 'apply', file, out: opts.dryRun ? null : target, dry_run: !!opts.dryRun, previous_revision: design.metadata.revision, revision: r.revision, previous_hash: r.previous_hash, hash: r.hash, changed: r.changed, summary: s, results: resultsJson(r.results) }, () => {
        const lines = [`${opts.dryRun ? '[dry-run] ' : ''}已应用 ${patch.ops.length} 个操作：revision ${design.metadata.revision} → ${r.revision}${opts.dryRun ? '' : `，写入 ${target}`}`];
        lines.push(`变更对象：${r.changed.join(', ')}`);
        lines.push(`结果：error ${s.error}, warning ${s.warning}, needs_review ${s.needs_review}, info ${s.info}`);
        for (const x of r.results.filter((x) => x.severity === 'error' || x.severity === 'warning')) lines.push(fmtResult(x));
        return lines.join('\n');
      });
    });

  program
    .command('export <file>')
    .description('导出 SVG（或规范化 JSON）')
    .option('--format <fmt>', 'svg|json', 'svg')
    .option('--out <out>', '输出文件（缺省输出到 stdout）')
    .option('--no-legend', '不绘制图例')
    .option('--hole-labels', '标注每个孔名')
    .option('--no-pin-labels', '不标注引脚名')
    .option('--title <title>', '标题')
    .option('--json', 'JSON 输出（仅报告）')
    .action((file: string, opts: { format: string; out?: string; legend: boolean; holeLabels?: boolean; pinLabels: boolean; title?: string; json?: boolean }) => {
      const design = readDesign(file);
      let content: string;
      if (opts.format === 'svg') {
        const a = analyzeDesign(design);
        content = exportSvg(a.model, { legend: opts.legend, showHoleLabels: !!opts.holeLabels, showPinLabels: opts.pinLabels, title: opts.title ?? design.metadata.name });
      } else if (opts.format === 'json') {
        content = serializeDesign(design);
      } else throw new CliError(`不支持的格式 ${opts.format}（svg|json）`);
      if (opts.out) {
        writeAtomic(opts.out, content);
        out(!!opts.json, { ok: true, command: 'export', file, format: opts.format, out: opts.out, bytes: content.length }, () => `已导出 ${opts.out}（${content.length} 字节）`);
      } else process.stdout.write(content);
    });

  program
    .command('steps <file>')
    .description('逐线搭建步骤（仅为指导，不代表实物已导通）')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { json?: boolean }) => {
      const design = readDesign(file);
      const a = analyzeDesign(design);
      const steps = buildSteps(a.model, a.connectivity, design.view?.build_done ?? []);
      out(!!opts.json, { ok: true, command: 'steps', file, count: steps.length, note: '搭建步骤只是指导，不代表实物已经导通；长度不含插入深度与弯折余量。', steps }, () =>
        steps.map((s) => `${String(s.index).padStart(3)}. [${s.color}${s.route === 'elevated' ? '/软线' : ''}] ${s.from_label}  →  ${s.to_label}${s.length_mm !== null ? `  (~${s.length_mm} mm)` : ''}${s.net ? `  net ${s.net}` : ''}${s.complete ? '  ✓' : ''}`).join('\n')
      );
    });

  return program;
}

export async function runCli(argv: string[]): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => process.stderr.write(s) });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return typeof process.exitCode === "number" ? process.exitCode : EXIT.OK;
  } catch (e) {
    if (e instanceof CliError) {
      const json = argv.includes('--json');
      if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, ...e.extra } }, null, 2) + '\n');
      else {
        process.stderr.write(`错误：${e.message}\n`);
        const issues = e.extra.issues as { path: string; message: string }[] | undefined;
        if (issues) for (const i of issues) process.stderr.write(`  ${i.path}: ${i.message}\n`);
        const err = e.extra.error as { results?: { severity: string; code: string; message: string }[] } | undefined;
        if (err?.results) for (const r of err.results) process.stderr.write(`  [${r.severity}] ${r.code}: ${r.message}\n`);
      }
      return e.code;
    }
    const ce = e as { code?: string; exitCode?: number; message?: string };
    if (ce.code === 'commander.helpDisplayed' || ce.code === 'commander.version') return EXIT.OK;
    if (typeof ce.exitCode === 'number') return ce.exitCode === 0 ? 0 : EXIT.USAGE;
    process.stderr.write(`内部错误：${(e as Error).message}\n`);
    return EXIT.USAGE;
  }
}

const isMain = process.argv[1] && /main\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
