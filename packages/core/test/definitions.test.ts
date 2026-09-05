import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeDesign, applyOps } from '../src/index.js';
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
