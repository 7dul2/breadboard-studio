import { describe, it, expect } from 'vitest';
import { analyzeDesign, applyOps } from '../src/index.js';
import { build, oneBoard } from './helpers.js';

describe('wires', () => {
  it('crossing wires do not connect; only explicit endpoints do', () => {
    // w1: a1 -> j10 and w2: a10 -> j1 cross visually in the middle.
    const d = build(
      [
        { op: 'add_wire', wire: { id: 'w1', from: { hole: 'bb.a1' }, to: { hole: 'bb.j10' }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w2', from: { hole: 'bb.a10' }, to: { hole: 'bb.j1' }, color: 'blue' } }
      ],
      build(oneBoard)
    );
    const a = analyzeDesign(d);
    expect(a.connectivity.full.connected('bb.a1', 'bb.j10')).toBe(true);
    expect(a.connectivity.full.connected('bb.a10', 'bb.j1')).toBe(true);
    expect(a.connectivity.full.connected('bb.a1', 'bb.a10')).toBe(false);
    expect(a.connectivity.full.connected('bb.j10', 'bb.j1')).toBe(false);
    // Same explicit endpoint group does connect.
    const d2 = build([{ op: 'add_wire', wire: { id: 'w3', from: { hole: 'bb.b1' }, to: { hole: 'bb.b10' }, color: 'green' } }], d);
    expect(analyzeDesign(d2).connectivity.full.connected('bb.j10', 'bb.j1')).toBe(true);
  });

  it('rejects endpoints that are occupied, blocked, unknown or already used', () => {
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }]);
    const occupied = applyOps(base, [{ op: 'add_wire', wire: { id: 'w', from: { hole: 'bb.c5' }, to: { hole: 'bb.a1' }, color: 'red' } }]);
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) expect(occupied.error.results?.some((r) => r.code === 'wire_endpoint_occupied')).toBe(true);

    const unknown = applyOps(base, [{ op: 'add_wire', wire: { id: 'w', from: { hole: 'bb.z9' }, to: { hole: 'bb.a1' }, color: 'red' } }]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.results?.some((r) => r.code === 'invalid_hole')).toBe(true);

    const first = build([{ op: 'add_wire', wire: { id: 'w1', from: { hole: 'bb.a5' }, to: { hole: 'bb.a1' }, color: 'red' } }], base);
    const dup = applyOps(first, [{ op: 'add_wire', wire: { id: 'w2', from: { hole: 'bb.a5' }, to: { hole: 'bb.a2' }, color: 'red' } }]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.results?.some((r) => r.code === 'wire_hole_conflict')).toBe(true);
  });

  it('pin endpoints resolve to a free hole in the pin group and follow the component when it moves', () => {
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }]);
    const d = build([{ op: 'add_wire', wire: { id: 'w1', from: { pin: 'led.A' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } }], base);
    const w = d.wires[0]!;
    expect(w.from.hole).toMatch(/^bb\.[abde]5$/);
    const a = analyzeDesign(d);
    expect(a.connectivity.full.connected('led.A', 'bb.top_inner_1')).toBe(true);
    // Move the LED away: the wire stays on its hole, so the old connection disappears (no phantom link).
    const moved = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c20', anchor_pin: 'A', rotation_deg: 0 } }], d);
    const b = analyzeDesign(moved);
    expect(b.connectivity.full.connected('led.A', 'bb.top_inner_1')).toBe(false);
    expect(b.results.some((r) => r.code === 'net_intent_open')).toBe(false);
  });

  it('auto paths are orthogonal and stored; manual waypoints are kept; length is reported', () => {
    const d = build([{ op: 'add_wire', wire: { id: 'w1', from: { hole: 'bb.a1' }, to: { hole: 'bb.j10' }, color: 'red' } }], build(oneBoard));
    const a = analyzeDesign(d);
    const rw = a.model.wires.get('w1')!;
    expect(rw.points.length).toBe(4);
    for (let i = 1; i < rw.points.length; i++) {
      const p = rw.points[i - 1]!;
      const q = rw.points[i]!;
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
    }
    expect(d.wires[0]!.waypoints_um.length).toBe(2);
    expect(rw.length_um).toBeGreaterThan(0);
    const manual = build([{ op: 'update_wire', id: 'w1', patch: { waypoints_um: [[50000, 50000]] } }], d);
    expect(manual.wires[0]!.path_mode).toBe('manual');
    expect(analyzeDesign(manual).model.wires.get('w1')!.points.length).toBe(3);
  });

  it('a wire with one end is a dangling draft that never conducts', () => {
    const d = build([{ op: 'add_wire', wire: { id: 'w1', from: { hole: 'bb.a1' }, color: 'red' } }], build(oneBoard));
    const a = analyzeDesign(d);
    expect(a.results.some((r) => r.code === 'wire_dangling')).toBe(true);
    expect(a.model.wires.get('w1')!.conducts).toBe(false);
  });
});
