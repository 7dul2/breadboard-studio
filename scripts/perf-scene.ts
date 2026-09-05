/**
 * Repeatable performance check: 4 × 400-hole boards, 20 modules, 100 wires.
 *   pnpm perf            → prints timings for core analysis + scene building
 *   pnpm perf --write    → also writes examples/stress_test.breadboard.json
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeDesign, applyOps, createEmptyDesign, serializeDesign, type Op } from '@breadboard-studio/core';
import { buildScene, exportSvg } from '@breadboard-studio/render';

const FIXED_NOW = '2026-09-05T00:00:00.000Z';
let design = createEmptyDesign('性能测试：4 板 / 20 模块 / 100 线');
design.metadata.created_at = FIXED_NOW;
design.metadata.updated_at = FIXED_NOW;

function run(ops: Op[], label: string) {
  const r = applyOps(design, ops, { now: () => FIXED_NOW });
  if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error).slice(0, 500)}`);
  design = r.design;
}

const t0 = performance.now();
run(
  [
    { op: 'add_board', board: { id: 'bb_1', model: 'breadboard_400@1', position_um: [0, 0], rotation_deg: 0 } },
    { op: 'add_board', board: { id: 'bb_2', model: 'breadboard_400@1', attach_to: { board_id: 'bb_1', side: 'right' } } },
    { op: 'add_board', board: { id: 'bb_3', model: 'breadboard_400@1', attach_to: { board_id: 'bb_1', side: 'bottom', gap_um: 4000 } } },
    { op: 'add_board', board: { id: 'bb_4', model: 'breadboard_400@1', attach_to: { board_id: 'bb_3', side: 'right' } } }
  ],
  'boards'
);
const comps: Op[] = [];
const boards = ['bb_1', 'bb_2', 'bb_3', 'bb_4'];
// 5 modules per board: one XIAO + four upright sensors
for (const [i, b] of boards.entries()) {
  comps.push({ op: 'add_component', component: { id: `mcu_${i}`, model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: b, anchor_hole: 'b2', anchor_pin: 'D6', rotation_deg: 90 } } });
  const models = ['sht41_breakout@1', 'bmp390_breakout@1', 'ltr390_breakout@1', 'oled_0_96_i2c@1'];
  models.forEach((m, k) => {
    comps.push({ op: 'add_component', component: { id: `s_${i}_${k}`, model: m, placement: { kind: 'board', board_id: b, anchor_hole: `j${12 + k * 5}`, anchor_pin: m.startsWith('oled') ? 'GND' : 'VCC', rotation_deg: 0 } } });
  });
}
run(comps, 'components');
const wires: Op[] = [];
let n = 0;
for (const [i, b] of boards.entries()) {
  // power + I2C per sensor (4 sensors × 4 wires = 16) + mcu power (2) + 7 misc = 25 per board
  wires.push({ op: 'add_wire', wire: { id: `w${++n}`, from: { hole: `${b}.g6` }, to: { hole: `${b}.bottom_inner_4` }, color: 'red' } });
  wires.push({ op: 'add_wire', wire: { id: `w${++n}`, from: { hole: `${b}.g7` }, to: { hole: `${b}.bottom_outer_5` }, color: 'black' } });
  for (let k = 0; k < 4; k++) {
    const c = 12 + k * 5;
    const isOled = k === 3;
    const vcc = isOled ? c + 1 : c;
    const gnd = isOled ? c : c + 1;
    wires.push({ op: 'add_wire', wire: { id: `w${++n}`, from: { hole: `${b}.i${vcc}` }, to: { hole: `${b}.bottom_inner_${6 + k * 3}` }, color: 'red' } });
    wires.push({ op: 'add_wire', wire: { id: `w${++n}`, from: { hole: `${b}.i${gnd}` }, to: { hole: `${b}.bottom_outer_${7 + k * 3}` }, color: 'black' } });
    wires.push({ op: 'add_wire', wire: { id: `w${++n}`, from: { hole: k === 0 ? `${b}.a4` : `${b}.g${c - 2}` }, to: { hole: `${b}.h${c + 3}` }, color: 'blue', route: 'elevated' } });
    wires.push({ op: 'add_wire', wire: { id: `w${++n}`, from: { hole: k === 0 ? `${b}.a3` : `${b}.g${c - 3}` }, to: { hole: `${b}.h${c + 2}` }, color: 'yellow', route: 'elevated' } });
  }
  for (let m = 0; m < 7; m++) {
    wires.push({ op: 'add_wire', wire: { id: `w${++n}`, from: { hole: `${b}.a${20 + m}` }, to: { hole: `${b}.top_inner_${10 + m}` }, color: ['green', 'orange', 'purple'][m % 3]! } });
  }
  void i;
}
run(wires, 'wires');
const tBuild = performance.now() - t0;

const timings: Record<string, number> = {};
const time = (label: string, fn: () => unknown, iterations = 5) => {
  fn(); // warm-up
  const s = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  timings[label] = Math.round(((performance.now() - s) / iterations) * 100) / 100;
};
const analysis = analyzeDesign(design);
time('analyzeDesign (model + connectivity + rules) ms', () => analyzeDesign(design));
time('buildScene ms', () => buildScene(analysis.model, { showPinLabels: true }));
time('exportSvg ms', () => exportSvg(analysis.model));
time('applyOps move_component ms', () => applyOps(design, [{ op: 'move_component', id: 's_0_0', placement: { kind: 'board', board_id: 'bb_1', anchor_hole: 'j13', anchor_pin: 'VCC', rotation_deg: 0 } }], { allow_blocking: true }));

const nodes = buildScene(analysis.model).nodes;
const count = (ns: typeof nodes): number => ns.reduce((acc, x) => acc + 1 + (x.t === 'group' ? count(x.children) : 0), 0);

console.log(JSON.stringify({
  env: { node: process.version, platform: `${process.platform} ${process.arch}` },
  design: { boards: design.boards.length, components: design.components.length, wires: design.wires.length, holes: analysis.model.holes.size, scene_nodes: count(nodes) },
  build_via_ops_ms: Math.round(tBuild),
  summary: analysis.summary,
  timings
}, null, 2));

if (process.argv.includes('--write')) {
  const out = join(import.meta.dirname, '..', 'examples', 'stress_test.breadboard.json');
  writeFileSync(out, serializeDesign(design));
  console.log('wrote', out);
}
