import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeDesign, loadDesign } from '@breadboard-studio/core';

const root = resolve(import.meta.dirname, '..', '..', '..');
const cli = join(root, 'packages', 'cli', 'src', 'main.ts');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const examples = join(root, 'examples');

function bb(args: string[], cwd = root) {
  const r = spawnSync(tsx, [cli, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function json(args: string[]) {
  const r = bb([...args, '--json']);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // leave null
  }
  return { ...r, json: parsed as Record<string, unknown> };
}

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bb-cli-'));
});

describe('bb CLI', () => {
  it('catalog list/inspect emit stable JSON', () => {
    const list = json(['catalog', 'list']);
    expect(list.code).toBe(0);
    expect(list.json.ok).toBe(true);
    const items = list.json.items as { ref: string }[];
    expect(items.map((i) => i.ref)).toContain('xiao_esp32s3_sense@1');
    const ins = json(['catalog', 'inspect', 'xiao_esp32s3_sense@1']);
    expect(ins.code).toBe(0);
    expect((ins.json.definition as { pins: unknown[] }).pins.length).toBe(14);
    const missing = json(['catalog', 'inspect', 'nope@1']);
    expect(missing.code).toBe(2);
    expect(missing.json.ok).toBe(false);
  });

  it('validate returns 0 for the examples and 1 for the power/ground short', () => {
    const ok = json(['validate', join(examples, 'environment_node.breadboard.json')]);
    expect(ok.code).toBe(0);
    expect((ok.json.summary as { error: number }).error).toBe(0);
    const bad = json(['validate', join(examples, 'invalid', 'short_power_ground.breadboard.json')]);
    expect(bad.code).toBe(1);
    const results = bad.json.results as { code: string; severity: string; endpoints: string[] }[];
    expect(results.some((r) => r.code === 'power_ground_short' && r.severity === 'error' && r.endpoints.length > 0)).toBe(true);
    const future = json(['validate', join(examples, 'invalid', 'future_schema_version.breadboard.json')]);
    expect(future.code).toBe(1);
    expect(future.json.ok).toBe(false);
    const malformed = bb(['validate', join(examples, 'invalid', 'malformed.breadboard.json')]);
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain('JSON');
  });

  it('CLI validation matches the core analysis used by the editor', () => {
    const file = join(examples, 'desk_device.breadboard.json');
    const r = json(['validate', file]);
    const design = loadDesign(readFileSync(file, 'utf8')).design!;
    const a = analyzeDesign(design);
    const cliCodes = (r.json.results as { code: string; message: string }[]).map((x) => `${x.code}:${x.message}`).sort();
    const coreCodes = a.results.map((x) => `${x.code}:${x.message}`).sort();
    expect(cliCodes).toEqual(coreCodes);
    expect(r.json.hash).toBeDefined();
  });

  it('connectivity reports the internal group and the net', () => {
    const r = json(['connectivity', join(examples, 'environment_node.breadboard.json'), '--from', 'bb_a.a7']);
    expect(r.code).toBe(0);
    expect(r.json.group).toEqual(['bb_a.a7', 'bb_a.b7', 'bb_a.c7', 'bb_a.d7', 'bb_a.e7']);
    const r2 = json(['connectivity', join(examples, 'environment_node.breadboard.json'), '--from', 'mcu.D4']);
    expect((r2.json.net as { name: string }).name).toBe('SDA');
    const bad = json(['connectivity', join(examples, 'environment_node.breadboard.json'), '--from', 'bb_a.zz']);
    expect(bad.code).toBe(2);
  });

  it('apply is atomic and respects revision/hash expectations', () => {
    const file = join(work, 'design.breadboard.json');
    copyFileSync(join(examples, 'environment_node.breadboard.json'), file);
    const before = readFileSync(file, 'utf8');
    const patchOk = join(work, 'ok.json');
    writeFileSync(patchOk, JSON.stringify({ ops: [{ op: 'add_wire', wire: { id: 'w_new', from: { pin: 'mcu.D0' }, to: { hole: 'bb_b.j20' }, color: 'green' } }] }));
    const dry = json(['apply', file, '--patch', patchOk, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json.dry_run).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const patchBad = join(work, 'bad.json');
    writeFileSync(patchBad, JSON.stringify({ ops: [{ op: 'add_wire', wire: { id: 'w_a', from: { hole: 'bb_a.a1' }, to: { hole: 'bb_a.a2' }, color: 'red' } }, { op: 'add_wire', wire: { id: 'w_b', from: { hole: 'bb_a.zz9' }, to: { hole: 'bb_a.a3' }, color: 'red' } }] }));
    const bad = json(['apply', file, '--patch', patchBad]);
    expect(bad.code).toBe(1);
    expect(bad.json.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const conflict = json(['apply', file, '--patch', patchOk, '--expect-revision', '99']);
    expect(conflict.code).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const out = join(work, 'revised.breadboard.json');
    const applied = json(['apply', file, '--patch', patchOk, '--out', out, '--expect-revision', '2']);
    expect(applied.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const revised = loadDesign(readFileSync(out, 'utf8'));
    expect(revised.ok).toBe(true);
    expect(revised.design!.metadata.revision).toBe(3);
    expect(revised.design!.wires.some((w) => w.id === 'w_new')).toBe(true);
    // second apply against the new file with the previous hash must conflict
    const again = json(['apply', out, '--patch', patchOk, '--expect-hash', String(applied.json.previous_hash)]);
    expect(again.code).toBe(3);
  });

  it('exports an SVG that contains every wire, board and pin label, plus a legend', () => {
    const out = join(work, 'layout.svg');
    const r = bb(['export', join(examples, 'environment_node.breadboard.json'), '--format', 'svg', '--out', out]);
    expect(r.code).toBe(0);
    const svg = readFileSync(out, 'utf8');
    expect(svg.startsWith('<?xml')).toBe(true);
    const design = loadDesign(readFileSync(join(examples, 'environment_node.breadboard.json'), 'utf8')).design!;
    for (const w of design.wires) expect(svg).toContain(`data-wire="${w.id}"`);
    for (const b of design.boards) expect(svg).toContain(`id="board:${b.id}"`);
    for (const c of design.components) expect(svg).toContain(`id="component:${c.id}"`);
    expect(svg).toContain('图例');
    expect(svg).toContain('D4');
    expect(svg).toContain('几何近似');
    const vb = /viewBox="([-\d. ]+)"/.exec(svg)!;
    const [x, y, w, h] = vb[1]!.split(' ').map(Number);
    // Every polyline point must lie inside the viewBox (no clipping).
    for (const m of svg.matchAll(/points="([^"]+)"/g)) {
      for (const pair of m[1]!.split(' ')) {
        const [px, py] = pair.split(',').map(Number);
        expect(px).toBeGreaterThanOrEqual(x!);
        expect(px).toBeLessThanOrEqual(x! + w!);
        expect(py).toBeGreaterThanOrEqual(y!);
        expect(py).toBeLessThanOrEqual(y! + h!);
      }
    }
  });

  it('steps lists every wire with both endpoints', () => {
    const r = json(['steps', join(examples, 'desk_device.breadboard.json')]);
    expect(r.code).toBe(0);
    const steps = r.json.steps as { index: number; from: string; to: string | null; color: string; length_mm: number }[];
    expect(steps.length).toBe(11);
    expect(steps[0]!.index).toBe(1);
    for (const s of steps) {
      expect(s.from).toMatch(/\./);
      expect(s.to).toMatch(/\./);
      expect(s.length_mm).toBeGreaterThan(0);
    }
  });

  it('new creates a valid empty design', () => {
    const out = join(work, 'fresh.breadboard.json');
    const r = json(['new', out, '--name', '测试']);
    expect(r.code).toBe(0);
    const d = loadDesign(readFileSync(out, 'utf8'));
    expect(d.ok).toBe(true);
    expect(d.design!.metadata.name).toBe('测试');
  });

  it('autowire plans, reports and writes atomically; dry-run and require-all never touch the file', () => {
    const src = loadDesign(readFileSync(join(examples, 'desk_device.breadboard.json'), 'utf8')).design!;
    const bare = join(work, 'desk_bare.breadboard.json');
    writeFileSync(bare, JSON.stringify({ ...src, wires: [], net_intents: [] }, null, 2));
    const before = readFileSync(bare, 'utf8');

    const dry = json(['autowire', bare, '--host', 'mcu', '--all', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json.dry_run).toBe(true);
    expect(readFileSync(bare, 'utf8')).toBe(before);
    const plan = dry.json.plan as { connections: { component: string; pin: string; route: string; via: string; length_um: number }[]; bridges: { kind: string; length_um: number }[]; unresolved: unknown[] };
    expect(plan.unresolved).toEqual([]);
    expect(plan.connections.map((c) => `${c.component}.${c.pin}`).sort()).toEqual(['oled.GND', 'oled.SCL', 'oled.SDA', 'oled.VCC', 'touch.GND', 'touch.IO', 'touch.VCC']);
    expect(plan.bridges.every((b) => b.length_um < 15_000)).toBe(true);

    const out = join(work, 'desk_auto.breadboard.json');
    const run = json(['autowire', bare, '--host', 'mcu', '--components', 'oled,touch', '--signal', 'touch.IO=GPIO5', '--out', out]);
    expect(run.code).toBe(0);
    const written = loadDesign(readFileSync(out, 'utf8'));
    expect(written.ok).toBe(true);
    expect(written.design!.wires.length).toBe(plan.connections.length + plan.bridges.length);
    expect(written.design!.net_intents.find((n) => n.name === 'TOUCH_IO')!.endpoints).toContain('mcu.GPIO5');
    expect(analyzeDesign(written.design!).summary.error).toBe(0);

    const strict = json(['autowire', bare, '--host', 'mcu', '--components', 'touch', '--signal', 'touch.IO=nope', '--require-all', '--out', join(work, 'never.breadboard.json')]);
    expect(strict.code).toBe(1);
    expect(strict.json.ok).toBe(false);
    expect((strict.json.error as { message: string }).message).toContain('nope');
    expect(existsSync(join(work, 'never.breadboard.json'))).toBe(false);
    expect(readFileSync(bare, 'utf8')).toBe(before);
    const board = json(['autowire', out, '--host', 'bb', '--all', '--dry-run']);
    expect(board.code).toBe(1);
    expect((board.json.error as { message: string }).message).toContain('面包板');

    // --optimize greedy vs the default global search: both valid, global never worse under the reported objective.
    const envSrc = loadDesign(readFileSync(join(examples, 'environment_node.breadboard.json'), 'utf8')).design!;
    const envBare = join(work, 'env_bare.breadboard.json');
    writeFileSync(envBare, JSON.stringify({ ...envSrc, wires: [], net_intents: [], constraints: [] }, null, 2));
    const greedy = json(['autowire', envBare, '--host', 'mcu', '--all', '--optimize', 'greedy', '--dry-run']);
    const global = json(['autowire', envBare, '--host', 'mcu', '--all', '--dry-run']);
    expect(greedy.code).toBe(0);
    expect(global.code).toBe(0);
    const og = (greedy.json.plan as { optimization: { strategy: string; objective_um: number } }).optimization;
    const oo = (global.json.plan as { optimization: { strategy: string; objective_um: number; greedy_objective_um: number; exhaustive: boolean; notes: string[] } }).optimization;
    expect(og.strategy).toBe('greedy');
    expect(oo.greedy_objective_um).toBe(og.objective_um);
    expect(oo.objective_um).toBeLessThanOrEqual(og.objective_um);
    expect(oo.notes.length).toBeGreaterThan(0);
    const badMode = json(['autowire', envBare, '--host', 'mcu', '--all', '--optimize', 'magic', '--dry-run']);
    expect(badMode.code).toBe(2);
  });

  it('ops lists the program and simulation operations', () => {
    const r = json(['ops']);
    expect(r.code).toBe(0);
    const ops = (r.json.ops as { op: string; fields: string }[]).map((o) => o.op);
    expect(ops).toEqual(expect.arrayContaining(['add_program', 'update_program', 'remove_program', 'set_simulation_config']));
  });

  it('program import creates, activates, exports and updates a program atomically', () => {
    const file = join(work, 'programs.breadboard.json');
    copyFileSync(join(examples, 'desk_device.breadboard.json'), file);
    const before = readFileSync(file, 'utf8');
    const src = join(work, 'blink.ts');
    // Mixed line endings and non-ASCII text: export must return the exact bytes.
    const source = "// 闪灯测试\nimport { gpio, sleep } from '@bbs/runtime';\r\nexport async function loop() {\n  await sleep(500);\n}\n";
    writeFileSync(src, source);

    // A new id without --target is a usage error; the file is untouched.
    const noTarget = json(['program', 'import', file, 'p_blink', '--source', src]);
    expect(noTarget.code).toBe(2);
    expect(noTarget.json.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);

    // An unknown target is rejected by add_program (exit 1); the file is untouched.
    const badTarget = json(['program', 'import', file, 'p_blink', '--source', src, '--target', 'nope']);
    expect(badTarget.code).toBe(1);
    expect(badTarget.json.ok).toBe(false);
    expect((badTarget.json.error as { message: string }).message).toContain('nope');
    expect(readFileSync(file, 'utf8')).toBe(before);

    const added = json(['program', 'import', file, 'p_blink', '--source', src, '--target', 'mcu', '--name', '闪灯', '--activate']);
    expect(added.code).toBe(0);
    expect(added.json.action).toBe('added');
    expect(added.json.activated).toBe(true);
    expect(added.json.revision).toBe((added.json.previous_revision as number) + 1);
    expect(added.json.changed).toEqual(expect.arrayContaining(['p_blink', 'simulation']));
    const d1 = loadDesign(readFileSync(file, 'utf8')).design!;
    expect(d1.programs!.map((p) => p.id)).toEqual(['p_blink']);
    expect(d1.programs![0]!.source).toBe(source);
    expect(d1.programs![0]!.language).toBe('studio-ts');
    expect(d1.simulation?.active_program_id).toBe('p_blink');

    expect(json(['validate', file]).code).toBe(0);

    const list = json(['programs', file]);
    expect(list.code).toBe(0);
    const programs = list.json.programs as { id: string; name: string; target_component_id: string; language: string; source_lines: number }[];
    expect(programs).toHaveLength(1);
    expect(programs[0]).toMatchObject({ id: 'p_blink', name: '闪灯', target_component_id: 'mcu', language: 'studio-ts' });
    expect(programs[0]!.source_lines).toBe(source.split('\n').length);
    expect((list.json.simulation as { active_program_id: string }).active_program_id).toBe('p_blink');
    expect(list.json.active_program_id).toBe('p_blink');

    const ins = json(['inspect', file]);
    expect((ins.json.programs as { id: string }[]).map((p) => p.id)).toEqual(['p_blink']);
    expect((ins.json.simulation as { active_program_id: string }).active_program_id).toBe('p_blink');
    expect(bb(['inspect', file]).stdout).toContain('程序：1 个（启动程序：p_blink）');
    expect(bb(['inspect', join(examples, 'environment_node.breadboard.json')]).stdout).toContain('程序：0 个（启动程序：无）');

    // export writes the exact source bytes back; a missing id exits 2 without writing.
    const exported = join(work, 'blink.exported.ts');
    const ex = json(['program', 'export', file, 'p_blink', '--out', exported]);
    expect(ex.code).toBe(0);
    expect(readFileSync(exported)).toEqual(readFileSync(src));
    const exMissing = json(['program', 'export', file, 'nope', '--out', join(work, 'never.ts')]);
    expect(exMissing.code).toBe(2);
    expect(existsSync(join(work, 'never.ts'))).toBe(false);

    // Importing an existing id updates the source and bumps the revision; name is kept.
    const source2 = source + '// v2\n';
    writeFileSync(src, source2);
    const updated = json(['program', 'import', file, 'p_blink', '--source', src]);
    expect(updated.code).toBe(0);
    expect(updated.json.action).toBe('updated');
    expect(updated.json.revision).toBe(d1.metadata.revision + 1);
    const d2 = loadDesign(readFileSync(file, 'utf8')).design!;
    expect(d2.programs).toHaveLength(1);
    expect(d2.programs![0]!.source).toBe(source2);
    expect(d2.programs![0]!.name).toBe('闪灯');
    expect(d2.simulation?.active_program_id).toBe('p_blink');

    // Revision conflict exits 3 and dry-run never writes.
    const afterUpdate = readFileSync(file, 'utf8');
    const conflict = json(['program', 'import', file, 'p_blink', '--source', src, '--expect-revision', '99']);
    expect(conflict.code).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe(afterUpdate);
    const dry = json(['program', 'import', file, 'p_blink', '--source', src, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json.dry_run).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(afterUpdate);
  });

  it('apply accepts add_program + set_simulation_config in one patch', () => {
    const file = join(work, 'patch_program.breadboard.json');
    copyFileSync(join(examples, 'desk_device.breadboard.json'), file);
    const patch = join(work, 'program_patch.json');
    writeFileSync(
      patch,
      JSON.stringify({
        ops: [
          { op: 'add_program', program: { id: 'p_main', name: '主程序', target_component_id: 'mcu', source: 'export async function loop() {}\n' } },
          { op: 'set_simulation_config', patch: { active_program_id: 'p_main', speed: 2, usb_powered_components: ['mcu'] } }
        ]
      })
    );
    const r = json(['apply', file, '--patch', patch]);
    expect(r.code).toBe(0);
    expect(r.json.changed).toEqual(expect.arrayContaining(['p_main', 'simulation']));
    const d = loadDesign(readFileSync(file, 'utf8')).design!;
    expect(d.programs!.map((p) => p.id)).toEqual(['p_main']);
    expect(d.simulation).toEqual({ active_program_id: 'p_main', speed: 2, usb_powered_components: ['mcu'] });
    expect(json(['validate', file]).code).toBe(0);
  });

  it('importing into a schema 1.0 file writes 1.1 with the rest of the content unchanged', () => {
    const modernFile = join(examples, 'desk_device.breadboard.json');
    const modernBytes = readFileSync(modernFile, 'utf8');
    const original = JSON.parse(modernBytes) as Record<string, unknown> & { metadata: { revision: number; updated_at?: string } };
    expect(original.schema_version).toBe('1.1');
    expect(original.programs).toBeUndefined();
    const legacy = join(work, 'legacy.breadboard.json');
    writeFileSync(legacy, JSON.stringify({ ...original, schema_version: '1.0' }, null, 2) + '\n');
    const src = join(work, 'legacy.ts');
    writeFileSync(src, 'export async function loop() {}\n');

    const legacyOut = join(work, 'legacy_out.breadboard.json');
    const r = json(['program', 'import', legacy, 'p1', '--source', src, '--target', 'mcu', '--out', legacyOut]);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(legacyOut, 'utf8')) as typeof original;
    expect(written.schema_version).toBe('1.1');
    expect((written.programs as { id: string }[]).map((p) => p.id)).toEqual(['p1']);
    expect(written.metadata.revision).toBe(original.metadata.revision + 1);

    // Everything the import did not touch is byte-for-byte the original content (wires are
    // re-normalized by every apply, so they are compared against a 1.1 import below).
    const { programs: _p, simulation: _s, schema_version: _v, metadata: _m, wires: _w, ...rest } = written;
    const { schema_version: _ov, metadata: _om, wires: _ow, ...origRest } = original;
    expect(rest).toEqual(origRest);
    expect({ ...written.metadata, revision: original.metadata.revision, updated_at: original.metadata.updated_at }).toEqual(original.metadata);

    // The same import on the 1.1 original produces the same document and hash: migration is lossless.
    const modernOut = join(work, 'modern_out.breadboard.json');
    const r2 = json(['program', 'import', modernFile, 'p1', '--source', src, '--target', 'mcu', '--out', modernOut]);
    expect(r2.code).toBe(0);
    expect(r2.json.hash).toBe(r.json.hash);
    const modern = JSON.parse(readFileSync(modernOut, 'utf8')) as typeof original;
    expect({ ...written, metadata: { ...written.metadata, updated_at: null } }).toEqual({ ...modern, metadata: { ...modern.metadata, updated_at: null } });
    // The example itself is never modified by --out.
    expect(readFileSync(modernFile, 'utf8')).toBe(modernBytes);
  });
});
