import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { analyzeDesign, applyOps, resolveComponent } from '../src/index.js';
import { build, examplesDir, oneBoard } from './helpers.js';

describe('embedded definitions', () => {
  const custom = JSON.parse(readFileSync(join(examplesDir, 'custom_definition_example.json'), 'utf8')) as Record<string, unknown>;

  it('imports a definition JSON, places it and keeps it in the file', () => {
    const d = build([...oneBoard, { op: 'add_definition', definition: custom }, { op: 'add_component', component: { id: 'm1', model: 'my_3pin_module@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j10', anchor_pin: 'VCC', rotation_deg: 0 } } }]);
    expect(d.embedded_catalog?.components?.[0]?.id).toBe('my_3pin_module');
    const a = analyzeDesign(d);
    const pc = a.model.components.get('m1')!;
    expect(pc.pins.map((p) => `${p.name}=${p.hole?.hole}`)).toEqual(['VCC=j10', 'OUT=j11', 'GND=j12']);
    expect(a.results.some((r) => r.code === 'model_unverified' && r.objects.includes('m1'))).toBe(true);
  });

  it('rejects invalid definitions and refuses to remove definitions in use', () => {
    const bad = applyOps(build(oneBoard), [{ op: 'add_definition', definition: { ...custom, pins: 'nope' } }]);
    expect(bad.ok).toBe(false);
    const d = build([...oneBoard, { op: 'add_definition', definition: custom }, { op: 'add_component', component: { id: 'm1', model: 'my_3pin_module@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j10', anchor_pin: 'VCC', rotation_deg: 0 } } }]);
    expect(applyOps(d, [{ op: 'remove_definition', ref: 'my_3pin_module@1' }]).ok).toBe(false);
    const removed = applyOps(d, [{ op: 'remove_component', id: 'm1' }, { op: 'remove_definition', ref: 'my_3pin_module@1' }]);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.design.embedded_catalog).toBeUndefined();
  });
});

describe('configured component rendering', () => {
  it('switches the SSD1315 OLED sample between white and blue', () => {
    const def = builtinCatalog().getComponent('oled_0_96_ssd1315_i2c@1')!;
    const white = resolveComponent(def);
    const blue = resolveComponent(def, undefined, { display_color: 'blue' });

    expect(white.orientation).toBe('flat');
    expect(white.footprint).toEqual({ x: 0, y: 0, w: 27000, h: 26500 });
    expect(white.render).toContainEqual(expect.objectContaining({ t: 'text', text: 'White', fill: '#f8fafc' }));
    expect(blue.render).toContainEqual(expect.objectContaining({ t: 'text', text: 'Blue', fill: '#38bdf8' }));
    expect(blue.render.some((primitive) => JSON.stringify(primitive).includes('$display_color'))).toBe(false);
  });

  it('resolves the 44-pin N16R8 board geometry, pin roles and RGB state', () => {
    const def = builtinCatalog().getComponent('esp32s3_n16r8_dual_usb@1')!;
    const off = resolveComponent(def);
    const blue = resolveComponent(def, undefined, { rgb_led_color: 'blue' });
    const custom = resolveComponent(def, undefined, { rgb_led_color: [12, 34, 56] });

    expect(off.body.size_um).toEqual([27940, 57150]);
    expect(off.pins).toHaveLength(44);
    expect(off.pins.find((pin) => pin.name === 'GND_1')?.local_um).toEqual([1270, 1905]);
    expect(off.pins.find((pin) => pin.name === 'GND_3')?.local_um).toEqual([1270, 55245]);
    expect(off.pins.find((pin) => pin.name === '3V3_1')?.local_um).toEqual([26670, 55245]);
    expect(def.pin_meta.GPIO8?.role).toBe('i2c_sda');
    expect(def.pin_meta.GPIO9?.role).toBe('i2c_scl');
    expect(def.pin_meta.GPIO35?.auto_wire).toBe('avoid');
    expect(def.pin_render).toEqual(expect.objectContaining({ shape: 'circle', show_labels: false }));
    expect(off.render.length).toBeGreaterThanOrEqual(260);
    for (const label of ['CH343', '1117', 'RGB', 'BOOT', 'RST', 'ESP32-S3-N16R8']) {
      expect(off.render).toContainEqual(expect.objectContaining({ t: 'text', text: label }));
    }
    expect(off.render).toContainEqual(expect.objectContaining({ t: 'circle', fill: 'rgb(0, 0, 0)' }));
    expect(blue.render).toContainEqual(expect.objectContaining({ t: 'circle', fill: '#3b82f6' }));
    expect(custom.render).toContainEqual(expect.objectContaining({ t: 'circle', fill: 'rgb(12, 34, 56)' }));
  });
});
