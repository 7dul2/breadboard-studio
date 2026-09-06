import { describe, it, expect } from 'vitest';
import { analyzeDesign, applyOps } from '../src/index.js';
import { build, oneBoard } from './helpers.js';

const xiao = (hole: string, rot: 0 | 90 | 180 | 270, id = 'mcu') => ({
  op: 'add_component' as const,
  component: { id, model: 'xiao_esp32s3_sense@1', placement: { kind: 'board' as const, board_id: 'bb', anchor_hole: hole, anchor_pin: 'D6', rotation_deg: rot } }
});

function pinMap(design: ReturnType<typeof build>, id = 'mcu'): Record<string, string> {
  const a = analyzeDesign(design);
  const pc = a.model.components.get(id)!;
  const out: Record<string, string> = {};
  for (const p of pc.pins) out[p.name] = p.hole ? `${p.hole.board_id}.${p.hole.hole}` : 'none';
  return out;
}

describe('placement', () => {
  it('maps XIAO pins to holes when rotated 90° across the ravine', () => {
    const d = build([...oneBoard, xiao('b3', 90)]);
    const m = pinMap(d);
    expect(m.D6).toBe('bb.b3');
    expect(m.D5).toBe('bb.b4');
    expect(m.D0).toBe('bb.b9');
    expect(m.D7).toBe('bb.f3');
    expect(m['5V']).toBe('bb.f9');
    expect(m.GND).toBe('bb.f8');
    expect(m['3V3']).toBe('bb.f7');
  });

  it('four 90° rotations return to the original pin-to-hole map', () => {
    let d = build([...oneBoard, xiao('c10', 0)], undefined, true);
    const start = pinMap(d);
    for (let i = 0; i < 4; i++) {
      const r = applyOps(d, [{ op: 'rotate_component', id: 'mcu', by_deg: 90 }], { allow_blocking: true });
      expect(r.ok).toBe(true);
      if (r.ok) d = r.design;
    }
    expect(pinMap(d)).toEqual(start);
    expect(d.components[0]!.placement.rotation_deg).toBe(0);
  });

  it('reports pins that fall off the hole grid or off the board', () => {
    const r = applyOps(build(oneBoard), [xiao('a28', 90)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.results?.some((x) => x.code === 'pin_not_on_hole')).toBe(true);
  });

  it('refuses two pins in the same hole and reports both components', () => {
    const base = build([...oneBoard, xiao('b3', 90)]);
    const r = applyOps(base, [{ op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b4', anchor_pin: 'A', rotation_deg: 0 } } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const hc = r.error.results?.find((x) => x.code === 'hole_conflict');
      expect(hc).toBeDefined();
      expect(hc!.objects.sort()).toEqual(['led', 'mcu']);
    }
  });

  it('flags pins shorted by the board (same column, rail) but keeps the design editable', () => {
    const d = build([...oneBoard, xiao('c10', 0)], undefined, true);
    const a = analyzeDesign(d);
    const shorted = a.results.filter((r) => r.code === 'pins_shorted_by_board');
    expect(shorted.length).toBeGreaterThan(0);
    expect(shorted.every((r) => !r.blocking)).toBe(true);
    const rail = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'top_inner_3', anchor_pin: 'A', rotation_deg: 0 } } }]);
    const b = analyzeDesign(rail);
    expect(b.results.some((r) => r.code === 'pins_shorted_by_board' && r.message.includes('电源轨'))).toBe(true);
  });

  it('distinguishes holes occupied by pins from holes blocked by the body', () => {
    const d = build([...oneBoard, xiao('b3', 90)]);
    const a = analyzeDesign(d);
    expect(a.model.holes.get('bb.b3')!.status).toBe('occupied');
    expect(a.model.holes.get('bb.c5')!.status).toBe('blocked');
    expect(a.model.holes.get('bb.a5')!.status).toBe('free');
    expect(a.model.holes.get('bb.g5')!.status).toBe('free');
    const pc = a.model.components.get('mcu')!;
    expect(pc.blockedHoles.length).toBeGreaterThan(0);
    // A wire into a blocked hole is refused.
    const r = applyOps(d, [{ op: 'add_wire', wire: { id: 'w', from: { hole: 'bb.c5' }, to: { hole: 'bb.a1' }, color: 'red' } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.results?.some((x) => x.code === 'wire_endpoint_blocked')).toBe(true);
  });

  it('upright single-row modules only block their pin strip', () => {
    const d = build([...oneBoard, { op: 'add_component', component: { id: 'oled', model: 'oled_0_96_i2c@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j10', anchor_pin: 'GND', rotation_deg: 0 } } }]);
    const a = analyzeDesign(d);
    expect(a.model.holes.get('bb.j10')!.status).toBe('occupied');
    expect(a.model.holes.get('bb.j13')!.status).toBe('occupied');
    expect(a.model.holes.get('bb.i10')!.status).toBe('free');
    expect(a.model.holes.get('bb.j14')!.status).toBe('free');
    expect(a.model.components.get('oled')!.blockedHoles.length).toBe(0);
  });

  it('places the 25.4 mm N16R8 pin rows across b/j on a full-size breadboard', () => {
    const d = build([
      { op: 'add_board', board: { id: 'bb', model: 'breadboard_830@1', position_um: [0, 0], rotation_deg: 0 } },
      { op: 'add_component', component: { id: 'mcu', model: 'esp32s3_n16r8_dual_usb@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b30', anchor_pin: 'GND_3', rotation_deg: 90 } } }
    ]);
    const a = analyzeDesign(d);
    const pins = a.model.components.get('mcu')!.pins;
    expect(pins).toHaveLength(44);
    expect(pins.find((pin) => pin.name === 'GND_3')?.hole?.hole).toBe('b30');
    expect(pins.find((pin) => pin.name === '3V3_1')?.hole?.hole).toBe('j30');
    expect(a.hasBlocking).toBe(false);
  });

  it('places every N16R8 header across j/a on two vertically joined half-size boards', () => {
    const d = build([
      { op: 'add_board', board: { id: 'upper', model: 'breadboard_400@1', position_um: [0, 0], rotation_deg: 0 } },
      { op: 'add_board', board: { id: 'lower', model: 'breadboard_400@1', attach_to: { board_id: 'upper', side: 'bottom', grid_align: true } } },
      { op: 'add_component', component: { id: 'mcu', model: 'esp32s3_n16r8_dual_usb@1', placement: { kind: 'board', board_id: 'upper', anchor_hole: 'j9', anchor_pin: 'GND_3', rotation_deg: 90 } } }
    ]);
    const a = analyzeDesign(d);
    const pins = a.model.components.get('mcu')!.pins;
    const upperPins = pins.filter((pin) => pin.hole?.board_id === 'upper');
    const lowerPins = pins.filter((pin) => pin.hole?.board_id === 'lower');
    const upper = a.model.boards.get('upper')!;
    const lower = a.model.boards.get('lower')!;
    const upperJ = upper.resolved.holes.get('j9')!.local_um;
    const lowerA = lower.resolved.holes.get('a9')!.local_um;

    expect(d.boards.find((board) => board.id === 'lower')?.position_um).toEqual([0, 53340]);
    expect(upper.bounds.y + upper.bounds.h).toBe(lower.bounds.y);
    expect(lower.transform.position[1] + lowerA[1] - (upper.transform.position[1] + upperJ[1])).toBe(25400);
    expect(upperPins).toHaveLength(22);
    expect(lowerPins).toHaveLength(22);
    expect(upperPins.every((pin) => pin.hole?.hole.startsWith('j'))).toBe(true);
    expect(lowerPins.every((pin) => pin.hole?.hole.startsWith('a'))).toBe(true);
    expect(pins.find((pin) => pin.name === 'GND_3')?.hole).toEqual({ board_id: 'upper', hole: 'j9' });
    expect(pins.find((pin) => pin.name === '3V3_1')?.hole).toEqual({ board_id: 'lower', hole: 'a9' });
    expect(a.hasBlocking).toBe(false);
  });

  it('places every N16R8 header across h/b with one modular power strip between two terminal blocks', () => {
    const d = build([
      { op: 'add_board', board: { id: 'upper', model: 'breadboard_400_terminal@1', position_um: [0, 0] } },
      { op: 'add_board', board: { id: 'rail', model: 'breadboard_power_strip_25@1', attach_to: { board_id: 'upper', side: 'bottom', grid_align: true } } },
      { op: 'add_board', board: { id: 'lower', model: 'breadboard_400_terminal@1', attach_to: { board_id: 'rail', side: 'bottom', grid_align: true } } },
      { op: 'add_component', component: { id: 'mcu', model: 'esp32s3_n16r8_dual_usb@1', placement: { kind: 'board', board_id: 'upper', anchor_hole: 'h9', anchor_pin: 'GND_3', rotation_deg: 90 } } }
    ]);
    const a = analyzeDesign(d);
    const pins = a.model.components.get('mcu')!.pins;
    const upperPins = pins.filter((pin) => pin.hole?.board_id === 'upper');
    const lowerPins = pins.filter((pin) => pin.hole?.board_id === 'lower');

    expect(d.boards.find((board) => board.id === 'rail')?.position_um).toEqual([0, 35560]);
    expect(d.boards.find((board) => board.id === 'lower')?.position_um).toEqual([0, 48260]);
    expect(upperPins).toHaveLength(22);
    expect(lowerPins).toHaveLength(22);
    expect(upperPins.every((pin) => pin.hole?.hole.startsWith('h'))).toBe(true);
    expect(lowerPins.every((pin) => pin.hole?.hole.startsWith('b'))).toBe(true);
    expect(pins.find((pin) => pin.name === 'GND_3')?.hole).toEqual({ board_id: 'upper', hole: 'h9' });
    expect(pins.find((pin) => pin.name === '3V3_1')?.hole).toEqual({ board_id: 'lower', hole: 'b9' });
    expect(a.hasBlocking).toBe(false);
  });

  it('detects body collisions on the same height layer', () => {
    const base = build([...oneBoard, xiao('b3', 90)]);
    const r = applyOps(base, [xiao('b10', 90, 'mcu2')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.results?.some((x) => x.code === 'body_collision')).toBe(true);
    const ok = applyOps(base, [xiao('b12', 90, 'mcu2')]);
    expect(ok.ok).toBe(true);
  });

  it('cable-only parts cannot be inserted; they must be off-board', () => {
    const r = applyOps(build(oneBoard), [{ op: 'add_component', component: { id: 's', model: 'sen66@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'a1', anchor_pin: 'VDD', rotation_deg: 0 } } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.results?.some((x) => x.code === 'component_not_insertable')).toBe(true);
    const ok = applyOps(build(oneBoard), [{ op: 'add_component', component: { id: 's', model: 'sen66@1', placement: { kind: 'off_board', position_um: [100000, 0], rotation_deg: 0 } } }]);
    expect(ok.ok).toBe(true);
  });
});
