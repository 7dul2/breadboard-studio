import { describe, it, expect } from 'vitest';
import { analyzeDesign, applyOps } from '../src/index.js';
import { build, loadExample, oneBoard, twoBoards } from './helpers.js';

describe('electrical rules', () => {
  it('shipped examples have no errors but keep honest needs_review items', () => {
    for (const name of ['desk_device.breadboard.json', 'environment_node.breadboard.json']) {
      const a = analyzeDesign(loadExample(name));
      expect(a.summary.error, name).toBe(0);
      expect(a.summary.blocking, name).toBe(0);
      expect(a.summary.needs_review, name).toBeGreaterThan(0);
      expect(a.results.some((r) => r.code === 'model_unverified'), name).toBe(true);
    }
  });

  it('reports a direct power-to-ground short with the endpoints involved', () => {
    const a = analyzeDesign(loadExample('invalid/short_power_ground.breadboard.json'));
    const short = a.results.find((r) => r.code === 'power_ground_short');
    expect(short).toBeDefined();
    expect(short!.severity).toBe('error');
    expect(short!.blocking).toBe(false);
    expect(short!.endpoints).toContain('mcu.3V3_1');
    expect(short!.endpoints).toContain('mcu.GND_1');
    // The intent for 3V3 and GND now sit in one net.
    expect(a.results.some((r) => r.code === 'net_intent_merged')).toBe(true);
  });

  it('unknown electrical data yields needs_review, never a green light', () => {
    const a = analyzeDesign(loadExample('environment_node.breadboard.json'));
    expect(a.results.some((r) => r.code === 'power_capacity_unknown' && r.endpoints?.includes('psu.3V3'))).toBe(true);
    expect(a.results.some((r) => r.code === 'supply_range_unknown')).toBe(true);
    expect(a.results.some((r) => r.code === 'power_budget_within_datasheet')).toBe(false);
    // SEN66: average current known, peak unknown → still needs review even with a capacity.
    const withCapacity = build([{ op: 'update_property', id: 'psu', path: 'config.capacity_ma', value: 500 }], loadExample('environment_node.breadboard.json'));
    const b = analyzeDesign(withCapacity);
    expect(b.results.some((r) => r.code === 'power_peak_unknown' && r.endpoints?.includes('psu.3V3'))).toBe(true);
    expect(b.results.some((r) => r.code === 'power_capacity_unknown' && r.endpoints?.includes('psu.3V3'))).toBe(false);
  });

  it('flags a supply that is below the typical load, and different voltages in one net', () => {
    const tooSmall = build([{ op: 'update_property', id: 'psu', path: 'config.capacity_ma', value: 50 }], loadExample('environment_node.breadboard.json'));
    expect(analyzeDesign(tooSmall).results.some((r) => r.code === 'power_budget_exceeded')).toBe(true);
    const mixed = build(
      [
        { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } },
        { op: 'add_wire', wire: { id: 'w1', from: { pin: 'mcu.5V' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w2', from: { pin: 'mcu.3V3' }, to: { hole: 'bb.top_inner_2' }, color: 'red' } }
      ],
      build(oneBoard)
    );
    const v = analyzeDesign(mixed).results.find((r) => r.code === 'voltage_conflict');
    expect(v).toBeDefined();
    expect(v!.endpoints).toContain('mcu.5V');
    expect(v!.endpoints).toContain('mcu.3V3');
  });

  it('net intents: open when not wired, closed when wired, unknown endpoints rejected', () => {
    const open = analyzeDesign(loadExample('invalid/open_net_intent.breadboard.json'));
    const r = open.results.find((x) => x.code === 'net_intent_open' && x.objects.includes('n_scl'));
    expect(r).toBeDefined();
    expect(r!.endpoints).toContain('mcu.D5');
    const closed = analyzeDesign(loadExample('environment_node.breadboard.json'));
    expect(closed.results.some((x) => x.code === 'net_intent_open')).toBe(false);
    expect(closed.connectivity.nets.find((n) => n.name === 'SDA')!.pins.length).toBe(5);
    const bad = applyOps(loadExample('environment_node.breadboard.json'), [{ op: 'add_net_intent', net_intent: { id: 'n_x', name: 'X', endpoints: ['mcu.D99'] } }]);
    expect(bad.ok).toBe(false);
  });

  it('missing common ground is reported', () => {
    const d = build(
      [
        { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb_a', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } },
        { op: 'add_component', component: { id: 'oled', model: 'oled_0_96_i2c@1', placement: { kind: 'board', board_id: 'bb_b', anchor_hole: 'j5', anchor_pin: 'GND', rotation_deg: 0 } } },
        { op: 'add_wire', wire: { id: 'w1', from: { pin: 'mcu.D4' }, to: { pin: 'oled.SDA' }, color: 'blue' } },
        { op: 'add_wire', wire: { id: 'w2', from: { pin: 'mcu.GND' }, to: { hole: 'bb_a.top_outer_1' }, color: 'black' } },
        { op: 'add_wire', wire: { id: 'w3', from: { pin: 'oled.GND' }, to: { hole: 'bb_b.top_outer_1' }, color: 'black' } }
      ],
      build(twoBoards)
    );
    const a = analyzeDesign(d);
    expect(a.results.some((r) => r.code === 'no_common_ground')).toBe(true);
    const fixed = build([{ op: 'add_wire', wire: { id: 'w4', from: { hole: 'bb_a.top_outer_2' }, to: { hole: 'bb_b.top_outer_2' }, color: 'black' } }], d);
    expect(analyzeDesign(fixed).results.some((r) => r.code === 'no_common_ground')).toBe(false);
  });

  it('isolate constraints are checked', () => {
    const d = loadExample('environment_node.breadboard.json');
    const bridged = build([{ op: 'add_wire', wire: { id: 'w_bridge', from: { hole: 'bb_a.bottom_inner_24' }, to: { hole: 'bb_b.bottom_inner_1' }, color: 'red' } }], d);
    const a = analyzeDesign(bridged);
    expect(a.results.some((r) => r.code === 'isolation_violated' && r.objects.includes('c_isolate'))).toBe(true);
    expect(a.results.some((r) => r.code === 'net_intent_merged')).toBe(true);
  });
});

describe('I2C rules', () => {
  const twoSensors = (addrB: number | null, sameBus: boolean) => {
    const ops = [
      ...twoBoards,
      { op: 'add_component' as const, component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board' as const, board_id: 'bb_a', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 as const } } },
      { op: 'add_component' as const, component: { id: 'mcu2', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board' as const, board_id: 'bb_b', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 as const } } },
      { op: 'add_component' as const, component: { id: 's1', model: 'sht41_breakout@1', placement: { kind: 'board' as const, board_id: 'bb_a', anchor_hole: 'j14', anchor_pin: 'VCC', rotation_deg: 0 as const }, config: { i2c_address: 68 } } },
      { op: 'add_component' as const, component: { id: 's2', model: 'sht41_breakout@1', placement: { kind: 'board' as const, board_id: 'bb_b', anchor_hole: 'j14', anchor_pin: 'VCC', rotation_deg: 0 as const }, config: { i2c_address: addrB } } },
      { op: 'add_wire' as const, wire: { id: 'w1', from: { pin: 'mcu.D4' }, to: { pin: 's1.SDA' }, color: 'blue', route: 'elevated' as const } },
      { op: 'add_wire' as const, wire: { id: 'w2', from: { pin: 'mcu.D5' }, to: { pin: 's1.SCL' }, color: 'yellow', route: 'elevated' as const } },
      { op: 'add_wire' as const, wire: { id: 'w3', from: { pin: sameBus ? 's1.SDA' : 'mcu2.D4' }, to: { pin: 's2.SDA' }, color: 'blue', route: 'elevated' as const } },
      { op: 'add_wire' as const, wire: { id: 'w4', from: { pin: sameBus ? 's1.SCL' : 'mcu2.D5' }, to: { pin: 's2.SCL' }, color: 'yellow', route: 'elevated' as const } }
    ];
    return build(ops);
  };

  it('same address on the same bus is a conflict', () => {
    const a = analyzeDesign(twoSensors(68, true));
    const c = a.results.find((r) => r.code === 'i2c_address_conflict');
    expect(c).toBeDefined();
    expect(c!.objects.sort()).toEqual(['s1', 's2']);
    expect(c!.message).toContain('0x44');
  });

  it('same address on isolated buses is fine', () => {
    const a = analyzeDesign(twoSensors(68, false));
    expect(a.results.some((r) => r.code === 'i2c_address_conflict')).toBe(false);
  });

  it('a configurable address change re-validates; unknown address is needs_review', () => {
    const conflicted = twoSensors(68, true);
    const changed = build([{ op: 'update_property', id: 's2', path: 'config.i2c_address', value: 69 }], conflicted);
    expect(analyzeDesign(changed).results.some((r) => r.code === 'i2c_address_conflict')).toBe(false);
    const unknown = analyzeDesign(twoSensors(null, true));
    expect(unknown.results.some((r) => r.code === 'i2c_address_unknown' && r.objects.includes('s2'))).toBe(true);
    expect(unknown.results.some((r) => r.code === 'i2c_address_conflict')).toBe(false);
  });

  it('shipped counter-example reports the conflict', () => {
    const a = analyzeDesign(loadExample('invalid/i2c_address_conflict.breadboard.json'));
    expect(a.results.some((r) => r.code === 'i2c_address_conflict')).toBe(true);
  });
});
