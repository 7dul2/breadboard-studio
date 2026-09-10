#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOG_VERSION } from '@breadboard-studio/catalog';
import { designSchema } from '@breadboard-studio/schema';
import { applyOps, createEmptyDesign, designHash, serializeDesign, summarize, type AutoWirePlan, type Op, type RuleResult } from '@breadboard-studio/core';
import { EXIT, CliError, applyPatchData, autowireData, catalogInspectData, catalogListData, connectivityData, exportDesignData, inspectData, opsData, programsData, readDesign, resultsJson, stepsData, validateData, writeAtomic, type FailOn } from './queries.js';

function out(json: boolean, data: Record<string, unknown>, text: () => string): void {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(text() + '\n');
}

/** Shape of both a live `RuleResult` and its serialized form (`resultsJson`). */
interface ResultLike {
  severity: RuleResult['severity'];
  code: string;
  blocking: boolean;
  message: string;
  endpoints?: string[];
  suggestion?: string | null;
}

function fmtResult(r: ResultLike): string {
  const tag = { error: 'ERROR', warning: 'WARN ', info: 'INFO ', needs_review: 'REVIEW' }[r.severity];
  const eps = r.endpoints?.length ? `  @ ${r.endpoints.join(', ')}` : '';
  const sug = r.suggestion ? `\n      → ${r.suggestion}` : '';
  return `  [${tag}] ${r.code}${r.blocking ? ' (blocking)' : ''}: ${r.message}${eps}${sug}`;
}

function fmtI2c(plan: AutoWirePlan): string[] {
  const lines: string[] = [];
  for (const b of plan.i2c_buses) lines.push(`  I²C 总线 ${b.index + 1}（SDA=${b.sda}, SCL=${b.scl}）${b.added ? '【本次启用】' : ''}：${b.devices.join('、') || '无新器件'}`);
  for (const c of plan.config_changes) lines.push(`  配置修改  ${c.id}.${c.path} = ${JSON.stringify(c.value)}：${c.reason}`);
  return lines;
}

function fmtOptimization(o: AutoWirePlan['optimization']): string[] {
  const mm = (um: number) => `${(um / 1000).toFixed(1)} mm`;
  const lines: string[] = [];
  if (o.global_objective_um === null) lines.push(`规划：贪心，目标值 ${mm(o.objective_um)}（走线长度 + 拐弯/杜邦线/线数惩罚）`);
  else {
    const gain = o.greedy_objective_um - o.global_objective_um;
    lines.push(`规划：${o.strategy === 'global' ? '全局优化' : '贪心（全局搜索未更优）'}，目标值 ${mm(o.objective_um)}；贪心 ${mm(o.greedy_objective_um)}，全局 ${mm(o.global_objective_um)}${gain > 0 ? `，改善 ${((gain / Math.max(o.greedy_objective_um, 1)) * 100).toFixed(1)}%` : ''}；${o.exhaustive ? '拓扑与电源轨组合已穷举、顺序搜索已收敛' : '含启发式/时限截断'}；${o.elapsed_ms} ms`);
    for (const n of o.notes) lines.push(`  · ${n}`);
  }
  return lines;
}

function fmtPlan(plan: AutoWirePlan): string[] {
  const lines: string[] = [];
  const mm = (um: number) => `${(um / 1000).toFixed(1)} mm`;
  const kind = (route: string) => (route === 'elevated' ? '杜邦线' : '硬质跳线');
  for (const b of plan.bridges) lines.push(`  ${b.wire_id.padEnd(5)} ${b.net.padEnd(9)} ${b.kind === 'feeder' ? '馈线' : '桥线'}  ${b.from} → ${b.to}  [${kind(b.route)} ${mm(b.length_um)}]`);
  for (const c of plan.connections) lines.push(`  ${c.wire_id.padEnd(5)} ${c.net.padEnd(9)} ${c.component}.${c.pin} → ${plan.host}.${c.host_pin}  ${c.from} → ${c.to}  [${c.color}/${kind(c.route)} ${mm(c.length_um)}${c.via === 'rail' ? '，经电源轨' : c.via === 'terminal' ? '，接端子' : ''}]`);
  for (const u of plan.unresolved) lines.push(`  未连接  ${u.component}${u.pin ? `.${u.pin}` : ''}: ${u.reason}${u.suggestion ? `\n      → ${u.suggestion}` : ''}`);
  for (const k of plan.skipped) if (k.code !== 'already_connected') lines.push(`  跳过    ${k.component}${k.pin ? `.${k.pin}` : ''}: ${k.reason}`);
  const already = plan.skipped.filter((k) => k.code === 'already_connected');
  if (already.length) lines.push(`  已导通  ${already.map((k) => `${k.component}.${k.pin}`).join(', ')}`);
  return lines;
}

function fmtProgramsLine(programs: { id: string }[], activeId: string | null): string {
  return `程序：${programs.length} 个（启动程序：${activeId ?? '无'}）`;
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
      const data = catalogListData(opts.design ? readDesign(opts.design) : null);
      out(!!opts.json, data, () =>
        data.items.map((i) => `${i.ref.padEnd(28)} ${i.kind.padEnd(9)} geo=${i.geometry_status.padEnd(11)} elec=${i.electrical_status.padEnd(11)} ${i.name}`).join('\n')
      );
    });
  catalog
    .command('inspect <ref>')
    .description('显示一个定义的完整内容（含引脚、参数 schema、来源与状态）')
    .option('--design <file>', '同时查找该设计内嵌的定义')
    .option('--json', 'JSON 输出')
    .action((ref: string, opts: { json?: boolean; design?: string }) => {
      const data = catalogInspectData(ref, opts.design ? readDesign(opts.design) : null);
      out(!!opts.json, data, () => JSON.stringify(data.definition, null, 2));
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
      const data = opsData();
      out(!!opts.json, data, () => data.ops.map((o) => `${o.op.padEnd(22)} ${o.fields}`).join('\n'));
    });

  program
    .command('inspect <file>')
    .description('汇总设计：元数据、面包板、元件引脚落孔、导线、网络')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { json?: boolean }) => {
      const data = inspectData(file);
      out(!!opts.json, data, () => {
        const lines = [`${data.metadata.name}  (revision ${data.revision}, hash ${data.hash.slice(0, 12)})`, `面包板 ${data.boards.length}，元件 ${data.components.length}，导线 ${data.wires.length}，网络 ${data.nets.length}`];
        for (const b of data.boards) lines.push(`  board ${b.id} ${b.model} @ (${b.position_um.join(', ')}) rot ${b.rotation_deg}`);
        for (const c of data.components) lines.push(`  component ${c.id} ${c.model} ${c.on_board ? '' : '(板外)'}: ${c.pins.map((p) => `${p.name}${p.hole ? '=' + p.hole : ''}`).join(' ')}`);
        for (const w of data.wires) lines.push(`  wire ${w.id} ${w.color} ${w.from} → ${w.to ?? '(草稿)'} ${(w.length_um / 1000).toFixed(1)}mm`);
        for (const n of data.nets) lines.push(`  net ${n.name}: ${n.pins.join(', ')}`);
        lines.push(fmtProgramsLine(data.programs, data.active_program_id));
        lines.push(`结果：error ${data.summary.error}, warning ${data.summary.warning}, needs_review ${data.summary.needs_review}, info ${data.summary.info}`);
        return lines.join('\n');
      });
    });

  program
    .command('validate <file>')
    .description('运行全部规则；存在 error 时退出码 1')
    .option('--json', 'JSON 输出')
    .option('--fail-on <level>', 'error|warning|never', 'error')
    .action((file: string, opts: { json?: boolean; failOn: string }) => {
      const data = validateData(file, opts.failOn as FailOn);
      const s = data.summary;
      out(!!opts.json, data, () => {
        const lines = [`${file}: ${s.error} error, ${s.warning} warning, ${s.needs_review} needs_review, ${s.info} info${s.blocking ? ` (${s.blocking} blocking)` : ''}`];
        for (const r of data.results) lines.push(fmtResult(r));
        lines.push(data.ok ? '没有 error。注意：这不等于电路已验证；needs_review 项需人工核对。' : '未通过。');
        return lines.join('\n');
      });
      if (!data.ok) process.exitCode = EXIT.PROBLEMS;
    });

  program
    .command('connectivity <file>')
    .description('查询一个孔或端子的内部导通组与实际网络')
    .requiredOption('--from <address>', '孔地址 board.hole 或端子 component.pin')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { from: string; json?: boolean }) => {
      const data = connectivityData(file, opts.from);
      out(!!opts.json, data, () => {
        const lines = [`${data.from}`];
        lines.push(`  内部导通组：${data.group.join(', ') || '（端子，无板内组）'}`);
        lines.push(`  导通集合：${data.conductive.holes.length} 孔，${data.conductive.pins.length} 引脚`);
        if (data.conductive.pins.length) lines.push(`  引脚：${data.conductive.pins.join(', ')}`);
        lines.push(`  网络：${data.net ? `${data.net.name} (${data.net.id})，导线 ${data.net.wires.join(', ') || '无'}` : '无（未接线）'}`);
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
      let rawPatch: unknown;
      try {
        rawPatch = JSON.parse(readFileSync(resolve(opts.patch), 'utf8'));
      } catch (e) {
        throw new CliError(`补丁文件无法读取或不是 JSON：${(e as Error).message}`);
      }
      const opCount = (rawPatch as { ops?: unknown[] }).ops?.length ?? 0;
      const data = applyPatchData(file, { patch: rawPatch, out: opts.out, dryRun: !!opts.dryRun, expectRevision: opts.expectRevision, expectHash: opts.expectHash, force: opts.force });
      const s = data.summary;
      out(!!opts.json, data, () => {
        const lines = [`${data.dry_run ? '[dry-run] ' : ''}已应用 ${opCount} 个操作：revision ${data.previous_revision} → ${data.revision}${data.dry_run ? '' : `，写入 ${data.out}`}`];
        lines.push(`变更对象：${data.changed.join(', ')}`);
        for (const rep of data.reports) {
          lines.push(`自动布线（第 ${rep.op_index + 1} 个操作，主板 ${rep.plan.host}）：${rep.plan.connections.length} 根连接线、${rep.plan.bridges.length} 根馈线/桥线、${rep.plan.unresolved.length} 个未连接`);
          lines.push(...fmtPlan(rep.plan as unknown as AutoWirePlan));
        }
        lines.push(`结果：error ${s.error}, warning ${s.warning}, needs_review ${s.needs_review}, info ${s.info}`);
        for (const x of data.results.filter((x) => x.severity === 'error' || x.severity === 'warning')) lines.push(fmtResult(x));
        return lines.join('\n');
      });
    });

  program
    .command('autowire <file>')
    .description('自动布线：按引脚角色把外设接到主板（电源/地经电源轨，I²C 接总线引脚，信号接空闲 GPIO）；与 UI 的“自动布线”共用同一引擎')
    .requiredOption('--host <id>', '主板元件 ID（主控或电源模块）')
    .option('--components <ids>', '外设元件 ID，逗号分隔')
    .option('--all', '除主板外的全部元件')
    .option('--supply <volts>', '外设允许范围未知或有多种选择时优先使用的主板电压', (v) => Number(v))
    .option('--power <mode>', 'auto|rail|direct：电源/地走电源轨或只在孔组间串接', 'auto')
    .option('--signal <map...>', '指定信号引脚，如 touch.IO=GPIO4')
    .option('--route <mode>', 'auto|flat|elevated', 'auto')
    .option('--no-intents', '不生成/更新 net_intents')
    .option('--optimize <mode>', 'global|greedy：全局搜索（默认，结果不劣于贪心）或只做逐引脚贪心', 'global')
    .option('--i2c-conflicts <mode>', 'bus_first|address_first|report：同地址器件的处理——先开第二条总线 / 先改可配置地址 / 只报告', 'bus_first')
    .option('--time-budget <ms>', '全局搜索时限（毫秒）', (v) => Number(v))
    .option('--require-all', '有引脚无法连接时整体失败、不写文件')
    .option('--out <out>', '输出文件（默认覆盖输入文件）')
    .option('--dry-run', '只报告，不写入')
    .option('--expect-revision <n>', '期望的 revision', (v) => Number(v))
    .option('--expect-hash <hash>', '期望的内容 hash')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { host: string; components?: string; all?: boolean; supply?: number; power: string; signal?: string[]; route: string; intents: boolean; optimize: string; i2cConflicts: string; timeBudget?: number; requireAll?: boolean; out?: string; dryRun?: boolean; expectRevision?: number; expectHash?: string; json?: boolean }) => {
      let components: string[] | undefined;
      if (opts.all) components = undefined; // the data layer expands `all` from the design
      else if (opts.components) components = opts.components.split(',').map((x) => x.trim()).filter(Boolean);
      else throw new CliError('请用 --components a,b,c 或 --all 指定外设');
      if (!['auto', 'rail', 'direct'].includes(opts.power)) throw new CliError(`--power 只能是 auto|rail|direct（收到 ${opts.power}）`);
      if (!['auto', 'flat', 'elevated'].includes(opts.route)) throw new CliError(`--route 只能是 auto|flat|elevated（收到 ${opts.route}）`);
      if (!['global', 'greedy'].includes(opts.optimize)) throw new CliError(`--optimize 只能是 global|greedy（收到 ${opts.optimize}）`);
      if (!['bus_first', 'address_first', 'report'].includes(opts.i2cConflicts)) throw new CliError(`--i2c-conflicts 只能是 bus_first|address_first|report（收到 ${opts.i2cConflicts}）`);
      const signal_pins: Record<string, string> = {};
      for (const m of opts.signal ?? []) {
        const [k, v] = m.split('=');
        if (!k || !v) throw new CliError(`--signal 需要 comp.pin=hostPin 形式（收到 ${m}）`);
        signal_pins[k.trim()] = v.trim();
      }
      const data = autowireData(file, {
        host: opts.host,
        ...(components ? { components } : {}),
        ...(opts.all ? { all: true } : {}),
        power: opts.power as 'auto' | 'rail' | 'direct',
        route: opts.route as 'auto' | 'flat' | 'elevated',
        intents: opts.intents,
        optimize: opts.optimize as 'global' | 'greedy',
        i2cConflicts: opts.i2cConflicts as 'bus_first' | 'address_first' | 'report',
        ...(opts.timeBudget !== undefined ? { timeBudget: opts.timeBudget } : {}),
        ...(opts.supply !== undefined ? { supply: opts.supply } : {}),
        ...(Object.keys(signal_pins).length ? { signalPins: signal_pins } : {}),
        ...(opts.requireAll ? { requireAll: true } : {}),
        out: opts.out,
        dryRun: !!opts.dryRun,
        expectRevision: opts.expectRevision,
        expectHash: opts.expectHash
      });
      const plan = data.plan as unknown as AutoWirePlan;
      const s = data.summary;
      out(!!opts.json, data, () => {
        const lines = [`${data.dry_run ? '[dry-run] ' : ''}自动布线（主板 ${plan.host}，外设 ${plan.components.join(', ')}）：生成 ${plan.connections.length} 根连接线、${plan.bridges.length} 根馈线/桥线；${plan.unresolved.length} 个引脚未能连接`];
        lines.push(...fmtPlan(plan));
        lines.push(...fmtI2c(plan));
        lines.push(...fmtOptimization(plan.optimization));
        lines.push(`revision ${data.previous_revision} → ${data.revision}${data.dry_run ? '（未写入）' : `，写入 ${data.out}`}`);
        lines.push(`结果：error ${s.error}, warning ${s.warning}, needs_review ${s.needs_review}, info ${s.info}`);
        for (const x of data.results.filter((x) => x.severity === 'error' || x.severity === 'warning' || (x.severity === 'needs_review' && x.code.startsWith('auto_wire')))) lines.push(fmtResult(x));
        lines.push('说明：按目录引脚角色生成导线，不是电气仿真；needs_review 项需人工核对。');
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
      const data = exportDesignData(file, { format: opts.format as 'svg' | 'json', legend: opts.legend, holeLabels: opts.holeLabels, pinLabels: opts.pinLabels, title: opts.title });
      if (opts.out) {
        writeAtomic(opts.out, data.content);
        out(!!opts.json, { ok: true, command: 'export', file, format: data.format, out: opts.out, bytes: data.bytes }, () => `已导出 ${opts.out}（${data.bytes} 字节）`);
      } else process.stdout.write(data.content);
    });

  program
    .command('steps <file>')
    .description('逐线搭建步骤（仅为指导，不代表实物已导通）')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { json?: boolean }) => {
      const data = stepsData(file);
      out(!!opts.json, data, () =>
        data.steps.map((s) => `${String(s.index).padStart(3)}. [${s.color}/${s.route === 'elevated' ? '杜邦线' : '硬质跳线'}] ${s.from_label}  →  ${s.to_label}${s.length_mm !== null ? `  (~${s.length_mm} mm)` : ''}${s.net ? `  net ${s.net}` : ''}${s.complete ? '  ✓' : ''}`).join('\n')
      );
    });

  program
    .command('programs <file>')
    .description('列出设计中的程序与仿真配置（本版本只保存与校验程序，不执行）')
    .option('--json', 'JSON 输出')
    .action((file: string, opts: { json?: boolean }) => {
      const data = programsData(file);
      out(!!opts.json, data, () => {
        const lines = [`${data.name}  ${fmtProgramsLine(data.programs, data.active_program_id)}`];
        for (const p of data.programs) lines.push(`  ${p.id.padEnd(16)} ${p.name}  → ${p.target_component_id}  [${p.language}${p.entry ? `, ${p.entry}` : ''}, ${p.source_lines} 行]${data.active_program_id === p.id ? '  (启动)' : ''}`);
        const sim = data.simulation;
        lines.push(sim ? `仿真配置：${Object.entries(sim).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('，')}` : '仿真配置：无');
        lines.push('说明：程序随项目保存并参与校验与 hash；本版本尚不执行代码。');
        return lines.join('\n');
      });
    });

  const prog = program.command('program').description('程序源码的导出与导入（写入走 add_program / update_program 事务）');
  prog
    .command('export <file> <id>')
    .description('把一个程序的源码原样写到文件')
    .requiredOption('--out <path>', '输出文件')
    .option('--json', 'JSON 输出')
    .action((file: string, id: string, opts: { out: string; json?: boolean }) => {
      const design = readDesign(file);
      const p = (design.programs ?? []).find((x) => x.id === id);
      if (!p) throw new CliError(`程序 ${id} 不存在（使用 bb programs ${file} 查看）`, EXIT.USAGE);
      writeAtomic(opts.out, p.source);
      out(!!opts.json, { ok: true, command: 'program.export', file, id, name: p.name, target_component_id: p.target_component_id, language: p.language, entry: p.entry ?? null, out: opts.out, bytes: Buffer.byteLength(p.source, 'utf8') }, () => `已导出程序 ${id}（${p.name}，目标 ${p.target_component_id}）到 ${opts.out}`);
    });
  prog
    .command('import <file> <id>')
    .description('从源码文件新建或更新程序：id 不存在时 add_program（需要 --target），否则 update_program 替换源码')
    .requiredOption('--source <path>', '源码文件（studio-ts）')
    .option('--name <name>', '程序名称（新建时默认为 id）')
    .option('--target <componentId>', '目标主控元件 ID（新建时必填）')
    .option('--activate', '同时设为启动程序（simulation.active_program_id）')
    .option('--out <out>', '输出文件（默认覆盖输入文件）')
    .option('--dry-run', '只报告，不写入')
    .option('--expect-revision <n>', '期望的 revision', (v) => Number(v))
    .option('--expect-hash <hash>', '期望的内容 hash')
    .option('--json', 'JSON 输出')
    .action((file: string, id: string, opts: { source: string; name?: string; target?: string; activate?: boolean; out?: string; dryRun?: boolean; expectRevision?: number; expectHash?: string; json?: boolean }) => {
      const design = readDesign(file);
      const sourcePath = resolve(opts.source);
      if (!existsSync(sourcePath)) throw new CliError(`源码文件不存在：${opts.source}`, EXIT.USAGE);
      const source = readFileSync(sourcePath, 'utf8');
      const existing = (design.programs ?? []).find((p) => p.id === id);
      const ops: Op[] = [];
      if (existing) {
        ops.push({ op: 'update_program', id, patch: { source, ...(opts.name !== undefined ? { name: opts.name } : {}), ...(opts.target !== undefined ? { target_component_id: opts.target } : {}) } });
      } else {
        if (!opts.target) throw new CliError(`程序 ${id} 不存在；新建程序需要 --target <主控元件 ID>`, EXIT.USAGE);
        ops.push({ op: 'add_program', program: { id, name: opts.name ?? id, target_component_id: opts.target, source } });
      }
      if (opts.activate) ops.push({ op: 'set_simulation_config', patch: { active_program_id: id } });
      const r = applyOps(design, ops, { expected_revision: opts.expectRevision, expected_hash: opts.expectHash });
      if (!r.ok) {
        const code = r.error.code === 'revision_conflict' ? EXIT.CONFLICT : EXIT.PROBLEMS;
        throw new CliError(r.error.message, code, { error: { ...r.error, results: r.error.results ? resultsJson(r.error.results) : undefined } });
      }
      const target = opts.out ?? file;
      if (!opts.dryRun) writeAtomic(target, serializeDesign(r.design));
      const s = summarize(r.results);
      const action = existing ? 'updated' : 'added';
      const sourceLines = source.length ? source.split('\n').length : 0;
      out(!!opts.json, { ok: true, command: 'program.import', file, out: opts.dryRun ? null : target, dry_run: !!opts.dryRun, id, action, activated: !!opts.activate, source: opts.source, source_lines: sourceLines, previous_revision: design.metadata.revision, revision: r.revision, previous_hash: r.previous_hash, hash: r.hash, changed: r.changed, summary: s, results: resultsJson(r.results) }, () => {
        const lines = [`${opts.dryRun ? '[dry-run] ' : ''}${action === 'added' ? '已新建' : '已更新'}程序 ${id}（${sourceLines} 行${opts.activate ? '，设为启动程序' : ''}）：revision ${design.metadata.revision} → ${r.revision}${opts.dryRun ? '' : `，写入 ${target}`}`];
        lines.push(`变更对象：${r.changed.join(', ')}`);
        lines.push(`结果：error ${s.error}, warning ${s.warning}, needs_review ${s.needs_review}, info ${s.info}`);
        for (const x of r.results.filter((x) => x.severity === 'error' || x.severity === 'warning')) lines.push(fmtResult(x));
        lines.push('说明：程序随项目保存并参与校验与 hash；本版本尚不执行代码。');
        return lines.join('\n');
      });
    });

  program
    .command('mcp')
    .description('以 stdio 启动 MCP server（Agent 通道，与 CLI 共用同一引擎；见 docs/AGENT_GUIDE.md）')
    .action(async () => {
      const { startMcpServer } = await import('./mcp.js');
      await startMcpServer();
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
