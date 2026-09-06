import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import type { DesignDocument } from '@breadboard-studio/schema';
import { analyzeDesign, applyOps, netOfAddress, planAutoWire, type AutoWirePlan, type Op } from '../src/index.js';
import { build, examplesDir, loadExample, oneBoard, twoBoards } from './helpers.js';

function bare(design: DesignDocument): DesignDocument {
  return { ...design, wires: [], net_intents: [], constraints: [] };
}

function autoWire(design: DesignDocument, host: string, components: string[], options: Record<string, unknown> = {}) {
  const r = applyOps(design, [{ op: 'auto_wire', host, components, options }], { catalog: builtinCatalog() });
  if (!r.ok) throw new Error(`auto_wire failed: ${JSON.stringify(r.error)}`);
  const plan = r.reports[0]!.plan;
  return { design: r.design, plan, results: r.results };
}

function connected(design: DesignDocument, a: string, b: string): boolean {
  const an = analyzeDesign(design);
  const na = netOfAddress(an.model, an.connectivity, a);
  const nb = netOfAddress(an.model, an.connectivity, b);
  return !!na && !!nb && na.id === nb.id;
}

function axisSegmentsOverlap(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  if (a[1] === b[1] && c[1] === d[1]) return a[1] === c[1] && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) < Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]));
  if (a[0] === b[0] && c[0] === d[0]) return a[0] === c[0] && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) < Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
  return false;
}

describe('auto wire', () => {
  it('wires an OLED and a touch module to the DevKit: power/ground via rails, I²C to the bus pins, IO to a free GPIO', () => {
    const { design, plan } = autoWire(bare(loadExample('desk_device.breadboard.json')), 'mcu', ['oled', 'touch']);
    expect(plan.unresolved).toEqual([]);
    const byPin = Object.fromEntries(plan.connections.map((c) => [`${c.component}.${c.pin}`, c]));
    expect(byPin['oled.SDA']!.host_pin).toBe('GPIO8');
    expect(byPin['oled.SCL']!.host_pin).toBe('GPIO9');
    expect(byPin['oled.GND']!.via).toBe('rail');
    expect(byPin['oled.VCC']!.via).toBe('rail');
    expect(byPin['touch.IO']!.host_pin).toBe('GPIO4');
    expect(byPin['touch.IO']!.role).toBe('signal_out');
    // Feeders are short hops from the nearest host group onto the nearest matching rail; the broken 830 rail is bridged, not bypassed with one long wire.
    const feeders = plan.bridges.filter((b) => b.kind === 'feeder');
    const bridges = plan.bridges.filter((b) => b.kind === 'bridge');
    expect(feeders.map((b) => b.net).sort()).toEqual(['3V3', 'GND']);
    for (const f of feeders) expect(f.length_um, `${f.net} feeder ${f.from} → ${f.to}`).toBeLessThan(15_000);
    expect(bridges.map((b) => `${b.from}→${b.to}`).sort()).toEqual(['bb.top_inner_25→bb.top_inner_26', 'bb.top_outer_25→bb.top_outer_26']);
    // Short rail taps are hard jumpers; the long I²C and IO runs across the DevKit become Dupont wires.
    for (const c of plan.connections) {
      if (c.via === 'rail') expect(c.route, `${c.component}.${c.pin}`).toBe('flat');
      else expect(c.route, `${c.component}.${c.pin}`).toBe('elevated');
    }
    expect(Math.max(...plan.connections.filter((c) => c.route === 'flat').map((c) => c.length_um))).toBeLessThan(30_000);
    // The generated design is electrically consistent and its intents are satisfied.
    expect(connected(design, 'oled.SDA', 'mcu.GPIO8')).toBe(true);
    expect(connected(design, 'touch.VCC', 'mcu.3V3_1')).toBe(true);
    expect(connected(design, 'touch.GND', 'mcu.GND_1')).toBe(true);
    expect(connected(design, 'touch.IO', 'mcu.GPIO4')).toBe(true);
    const a = analyzeDesign(design);
    expect(a.summary.error).toBe(0);
    expect(a.results.some((r) => r.code === 'net_intent_open')).toBe(false);
    expect(design.net_intents.map((n) => n.name).sort()).toEqual(['3V3', 'GND', 'SCL', 'SDA', 'TOUCH_IO']);
    // Every generated wire lands on a free hole (no conflicts) and has a name for the build steps.
    for (const w of design.wires) expect(w.name).toBeTruthy();
  });

  it('is idempotent: a second run adds nothing and reports every pin as already connected', () => {
    const first = autoWire(bare(loadExample('desk_device.breadboard.json')), 'mcu', ['oled', 'touch']);
    const second = autoWire(first.design, 'mcu', ['oled', 'touch']);
    expect(second.plan.connections).toEqual([]);
    expect(second.plan.bridges).toEqual([]);
    expect(second.design.wires.length).toBe(first.design.wires.length);
    expect(second.plan.skipped.every((s) => s.code === 'already_connected')).toBe(true);
  });

  it('keeps an explicit hard-jumper choice and produces orthogonal paths without shared segments', () => {
    const { design, plan } = autoWire(bare(loadExample('desk_device.breadboard.json')), 'mcu', ['oled', 'touch'], { route: 'flat' });
    expect(plan.connections.length + plan.bridges.length).toBeGreaterThan(0);
    expect(design.wires.every((w) => w.route === 'flat')).toBe(true);
    const a = analyzeDesign(design);
    expect(a.results.some((r) => r.code === 'wire_crosses_body')).toBe(false);
    for (const rw of a.model.wires.values()) {
      for (let i = 1; i < rw.points.length; i++) {
        const p = rw.points[i - 1]!;
        const q = rw.points[i]!;
        expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
      }
    }
    const wires = [...a.model.wires.values()];
    for (let x = 0; x < wires.length; x++) {
      for (let y = x + 1; y < wires.length; y++) {
        const left = wires[x]!;
        const right = wires[y]!;
        for (let i = 1; i < left.points.length; i++) {
          for (let j = 1; j < right.points.length; j++) {
            expect(axisSegmentsOverlap(left.points[i - 1]!, left.points[i]!, right.points[j - 1]!, right.points[j]!), `${left.instance.id} overlaps ${right.instance.id}`).toBe(false);
          }
        }
      }
    }
  });

  it('chains I²C through hole groups, bridges power rails across two boards and ties SEN66 SEL to ground', () => {
    const { design, plan } = autoWire(bare(loadExample('environment_node.breadboard.json')), 'mcu', ['sht41', 'bmp390', 'ltr390', 'sen66']);
    expect(plan.unresolved).toEqual([]);
    const sel = plan.connections.find((c) => c.component === 'sen66' && c.pin === 'SEL')!;
    expect(sel.net).toBe('GND');
    expect(sel.route).toBe('elevated');
    expect(plan.skipped.some((s) => s.component === 'sen66' && s.pin === 'NC' && s.code === 'pin_nc')).toBe(true);
    // Power and ground reach every module over the rails (the SEN66 cables land on rail holes, not on the host group).
    for (const c of plan.connections.filter((c) => c.net === 'GND' || c.net === '3V3')) expect(c.via, `${c.component}.${c.pin}`).toBe('rail');
    expect(plan.bridges.filter((b) => b.kind === 'feeder').map((b) => b.net).sort()).toEqual(['3V3', 'GND']);
    // The I²C bus chains outward through the sensors' hole groups as straight hard jumpers, SDA and SCL on different rows.
    const chained = plan.connections.filter((c) => ['bmp390', 'ltr390'].includes(c.component) && (c.pin === 'SDA' || c.pin === 'SCL'));
    expect(chained.length).toBe(4);
    const a0 = analyzeDesign(design);
    for (const c of chained) {
      expect(c.route, `${c.component}.${c.pin}`).toBe('flat');
      expect(c.via).toBe('group');
      expect(a0.model.wires.get(c.wire_id)!.points.length, `${c.component}.${c.pin} should be a straight run`).toBe(2);
    }
    for (const id of ['bmp390', 'ltr390']) {
      const row = (addr: string) => addr.split('.')[1]![0];
      const sda = chained.find((c) => c.component === id && c.pin === 'SDA')!;
      const scl = chained.find((c) => c.component === id && c.pin === 'SCL')!;
      expect(row(sda.from)).toBe(row(sda.to));
      expect(row(scl.from)).toBe(row(scl.to));
      expect(row(sda.from)).not.toBe(row(scl.from));
    }
    // All SDA pins share one net with the host, and the SCL net is separate.
    for (const id of ['sht41', 'bmp390', 'ltr390', 'sen66']) {
      expect(connected(design, `${id}.SDA`, 'mcu.D4'), id).toBe(true);
      expect(connected(design, `${id}.SCL`, 'mcu.D5'), id).toBe(true);
      expect(connected(design, `${id}.SDA`, 'mcu.D5'), id).toBe(false);
    }
    expect(connected(design, 'sen66.SEL', 'mcu.GND')).toBe(true);
    const a = analyzeDesign(design);
    expect(a.summary.error).toBe(0);
    expect(a.results.some((r) => r.code === 'net_intent_open')).toBe(false);
    expect(a.results.some((r) => r.code === 'no_common_ground')).toBe(false);
  });

  it('does not double-wire a terminal that is already connected elsewhere and refuses to parallel a peripheral supply', () => {
    const env = loadExample('environment_node.breadboard.json');
    const r = autoWire(env, 'mcu', ['sen66', 'psu']);
    // sen66.VDD is fed by the external PSU in the example: leave it alone, report it.
    const vdd = r.plan.unresolved.find((u) => u.component === 'sen66' && u.pin === 'VDD');
    expect(vdd?.code).toBe('terminal_in_use');
    expect(r.plan.skipped.some((s) => s.component === 'psu' && s.pin === '3V3' && s.code === 'peripheral_power_out')).toBe(true);
    expect(r.plan.skipped.some((s) => s.component === 'psu' && s.pin === 'VIN' && s.code === 'pin_skip_hint')).toBe(true);
    expect(r.design.wires.length).toBe(env.wires.length);
    // The B-board + rail belongs to the PSU net: it must never be bridged to the MCU's 3V3.
    expect(analyzeDesign(r.design).results.some((x) => x.code === 'isolation_violated')).toBe(false);
    expect(r.results.some((x) => x.code === 'auto_wire_unresolved' && x.endpoints?.includes('sen66.VDD'))).toBe(true);
  });

  it('a power module as host wires only supply and ground, and explains why signals were skipped', () => {
    const env = bare(loadExample('environment_node.breadboard.json'));
    const { design, plan } = autoWire(env, 'psu', ['sen66']);
    expect(plan.connections.map((c) => c.pin).sort()).toEqual(['GND', 'SEL', 'VDD']);
    expect(plan.skipped.filter((s) => s.code === 'host_power_only').map((s) => s.pin).sort()).toEqual(['SCL', 'SDA']);
    expect(plan.unresolved).toEqual([]);
    expect(connected(design, 'sen66.VDD', 'psu.3V3')).toBe(true);
    expect(connected(design, 'sen66.SEL', 'psu.GND')).toBe(true);
    // The PSU terminal feeds a rail and the module taps the rail, not the terminal directly.
    expect(plan.bridges.some((b) => b.kind === 'feeder' && b.from === 'psu.3V3')).toBe(true);
  });

  it('honours explicit signal pins, avoids strapping pins until nothing else is free, and fails clearly when GPIOs run out', () => {
    const base = build([
      ...oneBoard,
      { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } },
      { op: 'add_component', component: { id: 't1', model: 'ttp223_module@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j14', anchor_pin: 'VCC', rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 't2', model: 'ttp223_module@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j19', anchor_pin: 'VCC', rotation_deg: 0 } } }
    ]);
    const explicit = autoWire(base, 'mcu', ['t1', 't2'], { signal_pins: { 't1.IO': 'D9' } });
    const io = Object.fromEntries(explicit.plan.connections.filter((c) => c.pin === 'IO').map((c) => [c.component, c.host_pin]));
    expect(io.t1).toBe('D9');
    // t2 gets a free ordinary GPIO (never the UART pins D6/D7 while others are free), chosen near the module.
    expect(['D0', 'D1', 'D2', 'D3', 'D8', 'D10']).toContain(io.t2);
    expect(explicit.design.net_intents.map((n) => n.name)).toContain('T1_IO');

    // Occupy every ordinary GPIO with intents-free wires so only the "avoid" UART pins remain.
    const busy: Op[] = ['D0', 'D1', 'D2', 'D3', 'D8', 'D9', 'D10'].map((pin, i) => ({ op: 'add_wire', wire: { id: `busy${i}`, from: { pin: `mcu.${pin}` }, to: { hole: `bb.j${22 + i}` }, color: 'white' } }));
    const crowded = build(busy, base);
    const avoided = autoWire(crowded, 'mcu', ['t1']);
    const t1 = avoided.plan.connections.find((c) => c.pin === 'IO')!;
    expect(['D6', 'D7']).toContain(t1.host_pin);
    expect(avoided.results.some((r) => r.code === 'auto_wire_avoid_pin_used' && r.severity === 'needs_review')).toBe(true);

    const exhausted = autoWire(build([{ op: 'add_wire', wire: { id: 'busy7', from: { pin: 'mcu.D6' }, to: { hole: 'bb.j30' }, color: 'white' } }, { op: 'add_wire', wire: { id: 'busy8', from: { pin: 'mcu.D7' }, to: { hole: 'bb.i30' }, color: 'white' } }], crowded), 'mcu', ['t1']);
    expect(exhausted.plan.unresolved.some((u) => u.code === 'host_no_free_gpio')).toBe(true);
    // Power and ground were still wired: partial results are applied and the rest reported.
    expect(exhausted.plan.connections.map((c) => c.pin).sort()).toEqual(['GND', 'VCC']);
    const strict = applyOps(crowded, [{ op: 'auto_wire', host: 'mcu', components: ['t1'], options: { require_all: true, signal_pins: { 't1.IO': 'nope' } } }]);
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error.code).toBe('op_failed');
  });

  it('picks a supply the peripheral accepts and flags an assumed voltage when the range is unknown', () => {
    const custom = JSON.parse(readFileSync(join(examplesDir, 'custom_definition_example.json'), 'utf8')) as Record<string, unknown>;
    const fiveVolt = { ...custom, id: 'five_volt_only', electrical: { ...(custom.electrical as object), supply_voltage_v: { min: 4.5, max: 5.5 } } };
    const unknownRange = { ...custom, id: 'range_unknown', electrical: { ...(custom.electrical as object), supply_voltage_v: null } };
    const base = build([
      ...oneBoard,
      { op: 'add_definition', definition: custom },
      { op: 'add_definition', definition: fiveVolt },
      { op: 'add_definition', definition: unknownRange },
      { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } },
      { op: 'add_component', component: { id: 'm33', model: 'my_3pin_module@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j14', anchor_pin: 'VCC', rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 'm5', model: 'five_volt_only@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j19', anchor_pin: 'VCC', rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 'mu', model: 'range_unknown@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j24', anchor_pin: 'VCC', rotation_deg: 0 } } }
    ]);
    const { design, plan, results } = autoWire(base, 'mcu', ['m33', 'm5', 'mu']);
    const vcc = Object.fromEntries(plan.connections.filter((c) => c.pin === 'VCC').map((c) => [c.component, c]));
    expect(vcc.m33!.net).toBe('3V3');
    expect(vcc.m5!.net).toBe('5V');
    expect(vcc.m5!.host_pin).toBe('5V');
    expect(vcc.mu!.net).toBe('3V3');
    expect(results.some((r) => r.code === 'auto_wire_supply_assumed' && r.endpoints?.includes('mu.VCC'))).toBe(true);
    // 5 V and 3.3 V live on different rails: no voltage conflict, and separate power intents.
    const a = analyzeDesign(design);
    expect(a.results.some((r) => r.code === 'voltage_conflict')).toBe(false);
    expect(design.net_intents.map((n) => n.name)).toEqual(expect.arrayContaining(['3V3', '5V']));
    // A host without a fitting supply is reported, not guessed.
    const mismatch = planAutoWire(build([{ op: 'update_property', id: 'm5', path: 'config.supply_voltage_v', value: { min: 9, max: 12 } }], base), builtinCatalog(), { host: 'mcu', components: ['m5'] });
    expect(mismatch.unresolved.some((u) => u.code === 'supply_mismatch' && u.pin === 'VCC')).toBe(true);
    expect(mismatch.connections.map((c) => c.pin).sort()).toEqual(['GND', 'OUT']);
  });

  it('extends existing rails and intents instead of duplicating them, and can be undone as one transaction', () => {
    const base = build([
      ...twoBoards,
      { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb_a', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } },
      { op: 'add_component', component: { id: 'oled', model: 'oled_0_96_i2c@1', placement: { kind: 'board', board_id: 'bb_b', anchor_hole: 'j10', anchor_pin: 'GND', rotation_deg: 0 } } },
      // The user already ran GND to the A-board rail and declared the intent.
      { op: 'add_wire', wire: { id: 'gnd_feed', from: { pin: 'mcu.GND' }, to: { hole: 'bb_a.bottom_outer_3' }, color: 'black' } },
      { op: 'add_net_intent', net_intent: { id: 'n_gnd', name: 'GND', endpoints: ['mcu.GND'] } }
    ]);
    const r = applyOps(base, [{ op: 'auto_wire', host: 'mcu', components: ['oled', 'bb_b'] }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.reports[0]!.plan;
    expect(plan.skipped.some((s) => s.code === 'board_ignored' && s.component === 'bb_b')).toBe(true);
    // No new GND feeder: the existing rail is reused and bridged to board B.
    expect(plan.bridges.filter((b) => b.net === 'GND').map((b) => b.kind)).toEqual(['bridge']);
    expect(r.design.net_intents.filter((n) => n.name === 'GND').length).toBe(1);
    expect(r.design.net_intents.find((n) => n.id === 'n_gnd')!.endpoints).toContain('oled.GND');
    expect(connected(r.design, 'oled.GND', 'bb_a.bottom_outer_3')).toBe(true);
    expect(connected(r.design, 'oled.SDA', 'mcu.D4')).toBe(true);
    // Cross-board signal wires are elevated; the whole plan is one revision step.
    const sda = plan.connections.find((c) => c.pin === 'SDA')!;
    expect(sda.route).toBe('elevated');
    expect(r.revision).toBe(base.metadata.revision + 1);
    expect(r.changed).toEqual(expect.arrayContaining(plan.connections.map((c) => c.wire_id)));
  });

  it('rejects a breadboard or a missing component as host without touching the design', () => {
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } }]);
    const asBoard = applyOps(base, [{ op: 'auto_wire', host: 'bb', components: ['mcu'] }]);
    expect(asBoard.ok).toBe(false);
    if (!asBoard.ok) expect(asBoard.error.message).toContain('面包板');
    const missing = applyOps(base, [{ op: 'auto_wire', host: 'mcu', components: ['ghost'] }]);
    expect(missing.ok).toBe(false);
    const nothing = applyOps(base, [{ op: 'auto_wire', host: 'mcu', components: ['mcu'] }]);
    expect(nothing.ok).toBe(false);
    expect(base.wires.length).toBe(0);
  });

  it('global optimisation never loses to greedy, is exhaustive on the shipped examples and keeps rails per voltage', () => {
    for (const [name, host, comps] of [
      ['environment_node.breadboard.json', 'mcu', ['sht41', 'bmp390', 'ltr390', 'sen66', 'psu']],
      ['desk_device.breadboard.json', 'mcu', ['oled', 'touch']]
    ] as [string, string, string[]][]) {
      const base = bare(loadExample(name));
      const greedy = autoWire(base, host, comps, { optimize: 'greedy' });
      const global = autoWire(base, host, comps);
      expect(greedy.plan.optimization.strategy).toBe('greedy');
      expect(greedy.plan.optimization.global_objective_um).toBeNull();
      expect(global.plan.optimization.global_objective_um).not.toBeNull();
      expect(global.plan.optimization.objective_um, name).toBeLessThanOrEqual(greedy.plan.optimization.objective_um);
      expect(global.plan.optimization.greedy_objective_um).toBe(greedy.plan.optimization.objective_um);
      expect(global.plan.connections.length, name).toBeGreaterThanOrEqual(greedy.plan.connections.length);
      expect(global.plan.unresolved).toEqual([]);
      expect(global.plan.optimization.notes.some((n) => n.includes('穷举') || n.includes('枚举'))).toBe(true);
      expect(global.plan.optimization.elapsed_ms).toBeLessThan(1500);
      const a = analyzeDesign(global.design);
      expect(a.summary.error, name).toBe(0);
      expect(a.results.some((r) => r.code === 'net_intent_open'), name).toBe(false);
      // The summary tells the user what was searched and how it compares.
      const summary = global.results.find((r) => r.code === 'auto_wire_summary')!;
      expect(summary.message).toMatch(/全局|贪心/);
    }
    // The two-board example is small enough for an exhaustive search and the global plan is strictly better there.
    const env = autoWire(bare(loadExample('environment_node.breadboard.json')), 'mcu', ['sht41', 'bmp390', 'ltr390', 'sen66', 'psu']);
    expect(env.plan.optimization.strategy).toBe('global');
    expect(env.plan.optimization.exhaustive).toBe(true);
    expect(env.plan.optimization.objective_um).toBeLessThan(env.plan.optimization.greedy_objective_um);
    // Deterministic.
    const again = autoWire(bare(loadExample('environment_node.breadboard.json')), 'mcu', ['sht41', 'bmp390', 'ltr390', 'sen66', 'psu']);
    expect(JSON.stringify(again.plan.ops)).toBe(JSON.stringify(env.plan.ops));
  });

  it('a tiny time budget still returns a valid plan (falls back to greedy or a partial search)', () => {
    const r = autoWire(bare(loadExample('environment_node.breadboard.json')), 'mcu', ['sht41', 'bmp390', 'ltr390', 'sen66'], { time_budget_ms: 1 });
    expect(r.plan.unresolved).toEqual([]);
    expect(r.plan.connections.length).toBe(17); // 4 sensors × 4 pins + SEN66 SEL
    expect(analyzeDesign(r.design).summary.error).toBe(0);
  });

  it('planAutoWire is pure: the same input yields the same plan and never mutates the design', () => {
    const d = bare(loadExample('desk_device.breadboard.json'));
    const before = JSON.stringify(d);
    const p1: AutoWirePlan = planAutoWire(d, builtinCatalog(), { host: 'mcu', components: ['oled', 'touch'] });
    const p2 = planAutoWire(d, builtinCatalog(), { host: 'mcu', components: ['oled', 'touch'] });
    expect(JSON.stringify(p1.ops)).toBe(JSON.stringify(p2.ops));
    expect(JSON.stringify(d)).toBe(before);
    expect(p1.results.some((r) => r.code === 'auto_wire_summary')).toBe(true);
  });
});

describe('auto wire: I²C address conflicts', () => {
  const threeOleds = (row = 'e'): DesignDocument =>
    build([
      { op: 'add_board', board: { id: 'bb_1', model: 'breadboard_400@1', position_um: [0, 0], rotation_deg: 0 } },
      { op: 'add_board', board: { id: 'bb_2', model: 'breadboard_400@1', attach_to: { board_id: 'bb_1', side: 'bottom', grid_align: true } } },
      { op: 'add_component', component: { id: 'mcu', model: 'esp32s3_n16r8_dual_usb@1', placement: { kind: 'board', board_id: 'bb_1', anchor_hole: 'a9', anchor_pin: 'GND_3', rotation_deg: 90 } } },
      { op: 'add_component', component: { id: 'oled1', model: 'oled_0_96_ssd1315_i2c@1', placement: { kind: 'board', board_id: 'bb_2', anchor_hole: `${row}2`, anchor_pin: 'GND', rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 'oled2', model: 'oled_0_96_ssd1315_i2c@1', placement: { kind: 'board', board_id: 'bb_2', anchor_hole: `${row}13`, anchor_pin: 'GND', rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 'oled3', model: 'oled_0_96_ssd1315_i2c@1', placement: { kind: 'board', board_id: 'bb_2', anchor_hole: `${row}24`, anchor_pin: 'GND', rotation_deg: 0 } } }
    ]);

  it('three identical OLEDs: second bus + alternative address, no rule errors, every change reported for review', () => {
    const { design, plan, results } = autoWire(threeOleds(), 'mcu', ['oled1', 'oled2', 'oled3']);
    expect(plan.unresolved).toEqual([]);
    expect(plan.connections.filter((c) => c.pin === 'SDA' || c.pin === 'SCL').length).toBe(6);
    // Two buses in use, one of them created by the plan; one device moved to 0x3D.
    expect(plan.i2c_buses.length).toBe(2);
    const added = plan.i2c_buses.find((b) => b.added)!;
    expect(added.index).toBe(1);
    expect(added.devices.length).toBe(1);
    expect(plan.config_changes.some((c) => c.id === 'mcu' && c.path === 'config.i2c_buses')).toBe(true);
    const addr = plan.config_changes.find((c) => c.path === 'config.i2c_address')!;
    expect(addr.value).toBe(61);
    expect(design.components.find((c) => c.id === addr.id)!.config!.i2c_address).toBe(61);
    expect(design.components.find((c) => c.id === 'mcu')!.config!.i2c_buses).toEqual([{ sda: added.sda, scl: added.scl }]);
    // Nets and intents for the second bus exist and the rule engine agrees: no address conflict.
    expect(design.net_intents.map((n) => n.name).sort()).toEqual(['3V3', 'GND', 'SCL', 'SCL1', 'SDA', 'SDA1']);
    const a = analyzeDesign(design);
    expect(a.summary.error).toBe(0);
    expect(a.results.some((r) => r.code === 'i2c_address_conflict')).toBe(false);
    expect(a.results.some((r) => r.code === 'net_intent_open')).toBe(false);
    expect(connected(design, `${added.devices[0]}.SDA`, `mcu.${added.sda}`)).toBe(true);
    expect(connected(design, `${added.devices[0]}.SDA`, 'mcu.GPIO8')).toBe(false);
    expect(results.filter((r) => r.code === 'auto_wire_i2c_bus_added' && r.severity === 'needs_review').length).toBe(1);
    expect(results.filter((r) => r.code === 'auto_wire_i2c_address_changed' && r.severity === 'needs_review').length).toBe(1);
    // The new bus pins are ordinary GPIOs, not strapping/USB pins, and are not reused for anything else.
    for (const pin of [added.sda, added.scl]) {
      const meta = a.model.components.get('mcu')!.pins.find((p) => p.name === pin)!.meta;
      expect(meta.role).toBe('gpio');
      expect(meta.auto_wire).not.toBe('avoid');
    }
  });

  it('address_first prefers the jumper change; report leaves the conflicting device unwired with a clear reason', () => {
    const first = autoWire(threeOleds(), 'mcu', ['oled1', 'oled2', 'oled3'], { i2c_conflicts: 'address_first' });
    expect(first.plan.unresolved).toEqual([]);
    expect(first.plan.config_changes.filter((c) => c.path === 'config.i2c_address').length).toBe(1);
    expect(first.plan.i2c_buses.length).toBe(2);
    expect(analyzeDesign(first.design).summary.error).toBe(0);

    const report = autoWire(threeOleds(), 'mcu', ['oled1', 'oled2', 'oled3'], { i2c_conflicts: 'report' });
    expect(report.plan.config_changes).toEqual([]);
    expect(report.plan.i2c_buses.length).toBe(1);
    const conflicts = report.plan.unresolved.filter((u) => u.code === 'i2c_address_conflict');
    expect(conflicts.map((u) => u.pin).sort()).toEqual(['SCL', 'SCL', 'SDA', 'SDA']);
    expect(conflicts[0]!.reason).toContain('0x3C');
    // Power still gets wired for the conflicting displays; no bus is ever created with a duplicate address.
    expect(report.plan.connections.filter((c) => c.pin === 'VCC').length).toBe(3);
    expect(analyzeDesign(report.design).results.some((r) => r.code === 'i2c_address_conflict')).toBe(false);
  });

  it('a fixed-address sensor beyond the host bus count is reported, and the rule engine checks addresses per bus', () => {
    const base = build([
      ...oneBoard,
      { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } },
      { op: 'add_component', component: { id: 'uv1', model: 'ltr390_breakout@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j12', anchor_pin: 'VCC', rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 'uv2', model: 'ltr390_breakout@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j18', anchor_pin: 'VCC', rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 'uv3', model: 'ltr390_breakout@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j24', anchor_pin: 'VCC', rotation_deg: 0 } } }
    ]);
    const r = autoWire(base, 'mcu', ['uv1', 'uv2', 'uv3']);
    // LTR390 is fixed at 0x53: two buses cover two sensors, the third cannot be placed.
    expect(r.plan.i2c_buses.length).toBe(2);
    expect(r.plan.config_changes.some((c) => c.path === 'config.i2c_address')).toBe(false);
    const stuck = r.plan.unresolved.filter((u) => u.code === 'i2c_address_conflict');
    expect(stuck.length).toBe(2);
    expect(stuck[0]!.suggestion).toContain('多路复用器');
    expect(analyzeDesign(r.design).summary.error).toBe(0);
    // Rule engine: a second device at 0x53 forced onto bus 1 by hand is a conflict on that bus only.
    const bus1 = r.plan.i2c_buses.find((b) => b.index === 1)!;
    const forced = applyOps(r.design, [
      { op: 'add_wire', wire: { from: { pin: `${stuck[0]!.component}.SDA` }, to: { pin: `mcu.${bus1.sda}` }, color: 'blue' } },
      { op: 'add_wire', wire: { from: { pin: `${stuck[0]!.component}.SCL` }, to: { pin: `mcu.${bus1.scl}` }, color: 'yellow' } }
    ]);
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    const conflict = forced.results.filter((x) => x.code === 'i2c_address_conflict');
    expect(conflict.length).toBe(1);
    expect(conflict[0]!.message).toContain('第 2 条总线');
  });
});
