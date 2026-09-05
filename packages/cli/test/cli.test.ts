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
});
