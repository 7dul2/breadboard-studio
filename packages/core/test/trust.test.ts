import { describe, it, expect } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import type { ComponentDefinition, DefinitionEvidence } from '@breadboard-studio/schema';
import { validateBoardDefinition, validateComponentDefinition } from '@breadboard-studio/schema';
import { analyzeDesign, createEmptyDesign, planAutoWire, applyOps, loadDesign } from '../src/index.js';

function fixture(state: 'present' | 'absent' | 'unknown' = 'absent') {
  const catalog = builtinCatalog();
  const host = structuredClone(catalog.getComponent('esp32s3_n16r8_dual_usb@1')!);
  const oled = structuredClone(catalog.getComponent('oled_0_96_i2c@1')!);
  host.electrical.i2c!.pullups = { state: 'absent' };
  oled.electrical.i2c!.pullups = state === 'present' ? { state, supply_pin: 'VCC', resistance_ohms: 4700 } : { state };
  const d = createEmptyDesign('trust');
  d.embedded_catalog = { components: [host, oled] };
  d.components = [
    { id: 'mcu', model: `${host.id}@1`, placement: { kind: 'off_board', position_um: [0, 0], rotation_deg: 0 } },
    { id: 'oled', model: `${oled.id}@1`, placement: { kind: 'off_board', position_um: [100000, 0], rotation_deg: 0 } }
  ];
  const wire = (a: string, b: string) => d.wires.push({ id: `w${d.wires.length}`, from: { terminal: a }, to: { terminal: b }, color: 'red', route: 'elevated', path_mode: 'manual', waypoints_um: [] });
  wire('mcu.GPIO8', 'oled.SDA'); wire('mcu.GPIO9', 'oled.SCL'); wire('mcu.3V3_1', 'oled.VCC');
  const resistor = (id: string, a: string, b: string, value = '4.7k') => {
    d.components.push({ id, model: 'resistor_axial@1', params: { value }, placement: { kind: 'off_board', position_um: [200000, d.components.length * 20000], rotation_deg: 0 } });
    wire(a, `${id}.P1`); wire(`${id}.P2`, b);
  };
  return { d, host, oled, wire, resistor, results: () => analyzeDesign(d).results };
}

describe('I²C pull-ups', () => {
  it('distinguishes known missing from unknown and ignores unused buses', () => {
    const f = fixture();
    expect(f.results().filter((r) => r.code === 'i2c_pullup_missing')).toHaveLength(2);
    f.oled.electrical.i2c!.pullups = { state: 'unknown' };
    expect(f.results().filter((r) => r.code === 'i2c_pullup_unknown')).toHaveLength(2);
    f.d.wires = [];
    expect(f.results().filter((r) => r.code.startsWith('i2c_pullup_'))).toHaveLength(0);
  });
  it('recognizes powered internal pull-ups but reviews disconnected supplies', () => {
    const f = fixture('present');
    expect(f.results().filter((r) => r.code.startsWith('i2c_pullup_'))).toHaveLength(0);
    f.d.wires.pop();
    expect(f.results().filter((r) => r.code === 'i2c_pullup_unknown')).toHaveLength(2);
  });
  it('recognizes two external resistors without merging SDA/SCL or losing the bus', () => {
    const f = fixture();
    f.resistor('r1', 'mcu.GPIO8', 'mcu.3V3_1');
    f.resistor('r2', 'mcu.GPIO9', 'mcu.3V3_1');
    const codes = f.results().map((r) => r.code);
    expect(codes).not.toContain('i2c_pullup_missing');
    expect(codes).not.toContain('i2c_sda_scl_shorted');
    expect(codes).not.toContain('i2c_bus_mismatch');
    expect(codes).not.toContain('i2c_device_without_controller');
  });
  it('counts parallel pulls per line and reports equivalent resistance', () => {
    const f = fixture('present');
    f.resistor('r1', 'mcu.GPIO8', 'mcu.3V3_1');
    const parallel = f.results().filter((r) => r.code === 'i2c_pullup_parallel');
    expect(parallel).toHaveLength(1);
    expect(parallel[0]!.message).toContain('2350 Ω');
  });
  it('does not count a pulldown, a zero-ohm link or an unknown resistor as a valid pull-up', () => {
    for (const [supply, value] of [['mcu.GND_1', '4.7k'], ['mcu.3V3_1', '0'], ['mcu.3V3_1', '?']]) {
      const f = fixture(); f.resistor('r1', 'mcu.GPIO8', supply!, value!);
      expect(f.results().filter((r) => ['i2c_pullup_missing', 'i2c_pullup_unknown'].includes(r.code))).toHaveLength(2);
    }
  });
  it('retains review when a known external pull coexists with unknown module pulls', () => {
    const f = fixture('unknown');
    f.resistor('r1', 'mcu.GPIO8', 'mcu.3V3_1');
    expect(f.results().filter((r) => r.code === 'i2c_pullup_unknown')).toHaveLength(2);
  });
  it('does not give a same-supply parallel estimate for separate supplies', () => {
    const f = fixture('present');
    f.resistor('r1', 'mcu.GPIO8', 'mcu.5V');
    const result = f.results().find((r) => r.code === 'i2c_pullup_parallel');
    expect(result?.message).toContain('不同电源节点');
    expect(result?.message).not.toContain('2350');
  });
  it('keeps fixed internal pulls on original pins when firmware remaps I²C', () => {
    const f = fixture();
    f.host.electrical.i2c!.pullups = { state: 'present', supply_pin: '3V3_1', resistance_ohms: 4700 };
    f.d.components[0]!.config = { i2c_sda_pin: 'GPIO4', i2c_scl_pin: 'GPIO5' };
    f.d.wires[0]!.from = { terminal: 'mcu.GPIO4' }; f.d.wires[1]!.from = { terminal: 'mcu.GPIO5' };
    expect(f.results().filter((r) => r.code === 'i2c_pullup_missing')).toHaveLength(2);
  });
});

describe('GPIO multiplexing', () => {
  it('warns only when externally used, including passive paths and reserved pins', () => {
    for (const [pin, code] of [['GPIO0', 'gpio_strapping_used'], ['GPIO19', 'gpio_usb_used'], ['GPIO39', 'gpio_jtag_used'], ['GPIO35', 'reserved_pin_used']]) {
      const f = fixture();
      expect(f.results().some((r) => r.code === code)).toBe(false);
      f.resistor('r1', `mcu.${pin}`, 'mcu.GND_1');
      expect(f.results().some((r) => r.code === code && r.endpoints?.includes(`mcu.${pin}`))).toBe(true);
    }
  });
  it('avoids metadata-marked pins without an auto_wire hint and warns on an explicit selection', () => {
    const f = fixture(); f.d.wires = [];
    f.d.components.push({ id: 'touch', model: 'ttp223_module@1', placement: { kind: 'off_board', position_um: [300000, 0], rotation_deg: 0 } });
    for (const p of Object.values(f.host.pin_meta)) if (p.multiplex) delete p.auto_wire;
    const plan = planAutoWire(f.d, builtinCatalog(), { host: 'mcu', components: ['touch'], optimize: 'greedy' });
    const applied = applyOps(f.d, plan.ops);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(analyzeDesign(applied.design).results.some((r) => r.code.startsWith('gpio_'))).toBe(false);
    const explicit = planAutoWire(f.d, builtinCatalog(), { host: 'mcu', components: ['touch'], signal_pins: { 'touch.IO': 'GPIO19' }, optimize: 'greedy' });
    expect(explicit.results.some((r) => r.code === 'auto_wire_avoid_pin_used')).toBe(true);
  });
});

const evidence = (facet: 'geometry' | 'electrical', level: 'documented' | 'measured'): DefinitionEvidence => ({ facet, level, source_url: 'https://example.com/test-report', scope: 'Test fixture only', method: 'Fixture', result: 'Fixture', recorded_at: '2026-09-10', reviewer: 'Fixture reviewer', reviewed_at: '2026-09-11' });
describe('verified evidence gate', () => {
  it('requires reviewed measurements for geometry and reviewed records for electrical data', () => {
    const d: ComponentDefinition = structuredClone(builtinCatalog().getComponent('resistor_axial@1')!);
    d.geometry_status = 'verified'; d.electrical_status = 'verified';
    expect(validateComponentDefinition(d).ok).toBe(false);
    d.evidence = [evidence('geometry', 'documented'), evidence('electrical', 'documented')];
    expect(validateComponentDefinition(d).ok).toBe(false);
    d.evidence[0]!.level = 'measured';
    expect(validateComponentDefinition(d).ok).toBe(true);
    delete d.evidence[1]!.reviewer;
    expect(validateComponentDefinition(d).ok).toBe(false);
  });
  it('applies the same gate to boards and rejects malformed or backwards-dated evidence', () => {
    const d = structuredClone(builtinCatalog().getBoard('breadboard_400@1')!);
    d.geometry_status = 'verified';
    expect(validateBoardDefinition(d).ok).toBe(false);
    d.evidence = [evidence('geometry', 'measured')];
    expect(validateBoardDefinition(d).ok).toBe(true);
    d.evidence[0]!.reviewed_at = '2026-09-09';
    expect(validateBoardDefinition(d).ok).toBe(false);
    d.evidence[0]!.reviewed_at = '2026-09-11'; d.evidence[0]!.source_url = 'not a URL';
    expect(validateBoardDefinition(d).ok).toBe(false);
  });
  it('rejects evidence-free promotion through add_definition and invalid pull-up references', () => {
    const f = fixture();
    expect(applyOps(createEmptyDesign(), [{ op: 'add_definition', definition: { ...f.oled, geometry_status: 'verified' } }]).ok).toBe(false);
    f.oled.geometry_status = 'verified';
    expect(loadDesign(f.d).ok).toBe(false);
    f.oled.geometry_status = 'approximate';
    f.oled.electrical.i2c!.pullups = { state: 'present', supply_pin: 'MISSING' };
    expect(validateComponentDefinition(f.oled).ok).toBe(false);
  });
});
