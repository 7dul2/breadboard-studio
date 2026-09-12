import { describe, it, expect } from 'vitest';
import { analyzeDesign, applyOps, autoRoute, segmentIntersectsRect } from '../src/index.js';
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

    // Moved away: the wire comes along and keeps its position relative to the pin —
    // the hole it moves to is the same row, one column over.
    const row = /^bb\.([a-e])5$/.exec(w.from.hole!)![1];
    const moved = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c20', anchor_pin: 'A', rotation_deg: 0 } }], d);
    expect(moved.wires[0]!.from).toEqual({ hole: `bb.${row}20` });
    const b = analyzeDesign(moved);
    expect(b.connectivity.full.connected('led.A', 'bb.top_inner_1')).toBe(true);
    expect(b.results.filter((r) => r.blocking)).toEqual([]);
  });

  it('carries a chain of wires whose target holes are each still holding the next wire', () => {
    // A and K sit in adjacent columns with their wires in the same columns, so moving one
    // column right asks every wire for the very hole its neighbour is still sitting in.
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }]);
    const d = build(
      [
        { op: 'add_wire', wire: { id: 'w1', from: { pin: 'led.A' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w2', from: { pin: 'led.K' }, to: { hole: 'bb.top_outer_1' }, color: 'blue' } }
      ],
      base
    );
    const rowA = /^bb\.([a-e])5$/.exec(d.wires[0]!.from.hole!)![1];
    const rowK = /^bb\.([a-e])6$/.exec(d.wires[1]!.from.hole!)![1];

    const moved = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c6', anchor_pin: 'A', rotation_deg: 0 } }], d);
    expect(moved.wires[0]!.from).toEqual({ hole: `bb.${rowA}6` });
    expect(moved.wires[1]!.from).toEqual({ hole: `bb.${rowK}7` });
    const a = analyzeDesign(moved);
    expect(a.results.filter((r) => r.blocking)).toEqual([]);
    expect(a.connectivity.full.connected('led.A', 'bb.top_inner_1')).toBe(true);
    expect(a.connectivity.full.connected('led.K', 'bb.top_outer_1')).toBe(true);
    // The two carried wires did not collapse onto one hole.
    expect(a.connectivity.full.connected('led.A', 'led.K')).toBe(false);
  });

  it('splits two wires that share one pin onto two different holes when the module changes board', () => {
    // Two wires on the same pin have no hole to translate *to* when the board changes
    // (different board definition = different local coordinates), so both fall back to
    // "nearest free hole in the new group" — they must not both pick the same one.
    const base = build([
      ...oneBoard,
      { op: 'add_board', board: { id: 'bb2', model: 'breadboard_830@1', position_um: [200000, 0], rotation_deg: 0 } },
      { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }
    ]);
    const d = build(
      [
        { op: 'add_wire', wire: { id: 'w1', from: { pin: 'led.A' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w2', from: { pin: 'led.A' }, to: { hole: 'bb.top_outer_1' }, color: 'blue' } }
      ],
      base
    );
    expect(d.wires[0]!.from.hole).not.toBe(d.wires[1]!.from.hole);

    const moved = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb2', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } }], d);
    const f1 = moved.wires[0]!.from.hole!;
    const f2 = moved.wires[1]!.from.hole!;
    expect(f1).toMatch(/^bb2\.[a-e]5$/);
    expect(f2).toMatch(/^bb2\.[a-e]5$/);
    expect(f1).not.toBe(f2);
    const a = analyzeDesign(moved);
    expect(a.results.filter((r) => r.blocking)).toEqual([]);
    expect(a.connectivity.full.connected('led.A', 'bb.top_inner_1')).toBe(true);
    expect(a.connectivity.full.connected('led.A', 'bb.top_outer_1')).toBe(true);
  });

  it('keeps the relative position of several wires on one pin when the module changes board', () => {
    // Same board definition on both sides, so the local coordinates are comparable: the
    // wires keep their exact offset (two and three rows above the pin) across the move.
    const base = build([
      ...oneBoard,
      { op: 'add_board', board: { id: 'bb2', model: 'breadboard_400@1', position_um: [100000, 0], rotation_deg: 0 } },
      { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }
    ]);
    const d = build(
      [
        { op: 'add_wire', wire: { id: 'w1', from: { pin: 'led.A' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w2', from: { pin: 'led.A' }, to: { hole: 'bb.top_outer_1' }, color: 'blue' } }
      ],
      base
    );
    const rows = d.wires.map((w) => /^bb\.([a-e])5$/.exec(w.from.hole!)![1]);
    expect(rows[0]).not.toBe(rows[1]);
    const moved = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb2', anchor_hole: 'c7', anchor_pin: 'A', rotation_deg: 0 } }], d);
    expect(moved.wires[0]!.from).toEqual({ hole: `bb2.${rows[0]}7` });
    expect(moved.wires[1]!.from).toEqual({ hole: `bb2.${rows[1]}7` });
  });

  it('carries a long chain even when the wires are listed in the order that blocks it', () => {
    // Three wires in three neighbouring columns, added in reverse so that walking the list
    // backwards hits the blocked ones first: every wire wants the hole its left neighbour
    // still sits in, and the last one only frees up a round later.
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'enc', model: 'encoder_ky040@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j10', anchor_pin: 'CLK', rotation_deg: 0 } } }]);
    const d = build(
      [
        { op: 'add_wire', wire: { id: 'w_sw', from: { pin: 'enc.SW' }, to: { hole: 'bb.top_inner_3' }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w_dt', from: { pin: 'enc.DT' }, to: { hole: 'bb.top_inner_2' }, color: 'blue' } },
        { op: 'add_wire', wire: { id: 'w_clk', from: { pin: 'enc.CLK' }, to: { hole: 'bb.top_inner_1' }, color: 'green' } }
      ],
      base
    );
    const before = d.wires.map((w) => w.from.hole!);
    expect(new Set(before).size).toBe(3); // one hole each, no sharing

    const moved = build([{ op: 'move_component', id: 'enc', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j11', anchor_pin: 'CLK', rotation_deg: 0 } }], d);
    const shift = (hole: string) => hole.replace(/^(bb\.[a-j])(\d+)$/, (_m, row: string, col: string) => `${row}${Number(col) + 1}`);
    expect(moved.wires.map((w) => w.from.hole)).toEqual(before.map(shift));
    const a = analyzeDesign(moved);
    expect(a.results.filter((r) => r.blocking)).toEqual([]);
  });

  it('leaves wires that are not attached to the moved component alone', () => {
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }]);
    const d = build(
      [
        { op: 'add_wire', wire: { id: 'w_led', from: { pin: 'led.A' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w_other', from: { hole: 'bb.a20' }, to: { hole: 'bb.j20' }, color: 'green' } }
      ],
      base
    );
    const moved = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c6', anchor_pin: 'A', rotation_deg: 0 } }], d);
    expect(moved.wires[1]!.from).toEqual({ hole: 'bb.a20' });
    expect(moved.wires[1]!.to).toEqual({ hole: 'bb.j20' });
  });

  it('does not rewrite a locked wire when its connected component moves', () => {
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }]);
    const wired = build([{ op: 'add_wire', wire: { id: 'w_locked', from: { pin: 'led.A' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } }], base);
    const locked = build([{ op: 'update_property', id: 'w_locked', path: 'locked', value: true }], wired);
    const originalFrom = locked.wires[0]!.from;

    const moved = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c20', anchor_pin: 'A', rotation_deg: 0 } }], locked);
    expect(moved.wires[0]!.from).toEqual(originalFrom);
    expect(moved.components[0]!.placement).toMatchObject({ anchor_hole: 'c20' });
  });

  it('does not guess wire ownership when another component shares the same conductive group', () => {
    const components = build(
      [
        ...oneBoard,
        { op: 'add_component', component: { id: 'moving', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } },
        { op: 'add_component', component: { id: 'fixed', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e5', anchor_pin: 'A', rotation_deg: 0 } } }
      ],
      undefined,
      true
    );
    const wired = build([{ op: 'add_wire', wire: { id: 'w_fixed', from: { pin: 'fixed.A' }, to: { hole: 'bb.top_inner_1' }, color: 'blue' } }], components, true);
    const originalFrom = wired.wires[0]!.from;

    const moved = build([{ op: 'move_component', id: 'moving', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c20', anchor_pin: 'A', rotation_deg: 0 } }], wired, true);
    expect(moved.wires[0]!.from).toEqual(originalFrom);
    expect(analyzeDesign(moved).connectivity.full.connected('fixed.A', 'bb.top_inner_1')).toBe(true);
  });

  it('lifts the wires with a component that is moved off the board, and picks them up again on the way back', () => {
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } } }]);
    const d = build([{ op: 'add_wire', wire: { id: 'w1', from: { pin: 'led.A' }, to: { hole: 'bb.top_inner_1' }, color: 'red' } }], base);
    const row = /^bb\.([a-e])5$/.exec(d.wires[0]!.from.hole!)![1];

    // Off the board there is no hole to sit in: the endpoint becomes a terminal on the pin,
    // so the wire is still connected instead of being left behind on the breadboard.
    const off = build([{ op: 'move_component', id: 'led', placement: { kind: 'off_board', position_um: [120000, 0], rotation_deg: 0 } }], d);
    expect(off.wires[0]!.from).toEqual({ terminal: 'led.A' });
    expect(analyzeDesign(off).connectivity.full.connected('led.A', 'bb.top_inner_1')).toBe(true);

    // Dropped back on the breadboard: it goes back into a hole in the new pin group.
    const back = build([{ op: 'move_component', id: 'led', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c5', anchor_pin: 'A', rotation_deg: 0 } }], off);
    expect(back.wires[0]!.from).toEqual({ hole: `bb.${row}5` });
    expect(analyzeDesign(back).connectivity.full.connected('led.A', 'bb.top_inner_1')).toBe(true);
  });

  it('auto paths are orthogonal and stored; manual waypoints are kept; length is reported', () => {
    const d = build([{ op: 'add_wire', wire: { id: 'w1', from: { hole: 'bb.a1' }, to: { hole: 'bb.j10' }, color: 'red' } }], build(oneBoard));
    const a = analyzeDesign(d);
    const rw = a.model.wires.get('w1')!;
    expect(rw.points.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < rw.points.length; i++) {
      const p = rw.points[i - 1]!;
      const q = rw.points[i]!;
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
    }
    expect(d.wires[0]!.waypoints_um.length).toBe(rw.points.length - 2);
    expect(rw.length_um).toBeGreaterThan(0);
    const manual = build([{ op: 'update_wire', id: 'w1', patch: { waypoints_um: [[50000, 50000]] } }], d);
    expect(manual.wires[0]!.path_mode).toBe('manual');
    expect(analyzeDesign(manual).model.wires.get('w1')!.points.length).toBe(3);
  });

  it('routes hard jumpers around component footprints while Dupont wires connect the two points directly', () => {
    const obstacle = { x: 4000, y: -1000, w: 2000, h: 2000 };
    const start: [number, number] = [0, 0];
    const end: [number, number] = [10000, 0];
    const waypoints = autoRoute(start, end, [obstacle]);
    const points = [start, ...waypoints, end];
    expect(waypoints.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      expect(segmentIntersectsRect(a, b, obstacle)).toBe(false);
    }

    const elevated = build([{ op: 'add_wire', wire: { id: 'dupont', from: { hole: 'bb.a1' }, to: { hole: 'bb.j10' }, color: 'blue', route: 'elevated' } }], build(oneBoard));
    const rw = analyzeDesign(elevated).model.wires.get('dupont')!;
    expect(rw.points).toHaveLength(2);
    expect(elevated.wires[0]!.waypoints_um).toEqual([]);
  });

  it('a wire with one end is a dangling draft that never conducts', () => {
    const d = build([{ op: 'add_wire', wire: { id: 'w1', from: { hole: 'bb.a1' }, color: 'red' } }], build(oneBoard));
    const a = analyzeDesign(d);
    expect(a.results.some((r) => r.code === 'wire_dangling')).toBe(true);
    expect(a.model.wires.get('w1')!.conducts).toBe(false);
  });
});
