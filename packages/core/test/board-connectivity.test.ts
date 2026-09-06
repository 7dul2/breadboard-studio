import { describe, it, expect } from 'vitest';
import { analyzeDesign, conductiveSet, resolveBoard, holeAtLocal } from '../src/index.js';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { build, oneBoard, twoBoards } from './helpers.js';

describe('breadboard internal conductivity', () => {
  const design = build(oneBoard);
  const a = analyzeDesign(design);
  const conn = (x: string, y: string) => a.connectivity.full.connected(x, y);

  it('a7–e7 are one group, f7–j7 another, column 8 is separate', () => {
    expect(conn('bb.a7', 'bb.e7')).toBe(true);
    expect(conn('bb.b7', 'bb.c7')).toBe(true);
    expect(conn('bb.f7', 'bb.j7')).toBe(true);
    expect(conn('bb.e7', 'bb.f7')).toBe(false); // ravine
    expect(conn('bb.a7', 'bb.a8')).toBe(false);
    expect(conn('bb.j7', 'bb.j8')).toBe(false);
    expect(conductiveSet(a.model, a.connectivity, 'bb.c7').holes).toEqual(['bb.a7', 'bb.b7', 'bb.c7', 'bb.d7', 'bb.e7']);
  });

  it('continuous rails conduct end to end, different rails do not', () => {
    expect(conn('bb.top_outer_1', 'bb.top_outer_25')).toBe(true);
    expect(conn('bb.top_outer_1', 'bb.top_inner_1')).toBe(false);
    expect(conn('bb.top_inner_1', 'bb.bottom_inner_1')).toBe(false);
    expect(conn('bb.bottom_outer_3', 'bb.a3')).toBe(false);
  });

  it('a declared rail break really breaks the rail (830 board)', () => {
    const d = build([{ op: 'add_board', board: { id: 'big', model: 'breadboard_830@1', position_um: [0, 0], rotation_deg: 0 } }]);
    const b = analyzeDesign(d);
    expect(b.connectivity.full.connected('big.top_inner_1', 'big.top_inner_25')).toBe(true);
    expect(b.connectivity.full.connected('big.top_inner_25', 'big.top_inner_26')).toBe(false);
    expect(b.connectivity.full.connected('big.top_inner_26', 'big.top_inner_50')).toBe(true);
    expect(b.connectivity.full.connected('big.a1', 'big.e1')).toBe(true);
    expect(b.connectivity.full.connected('big.a63', 'big.e63')).toBe(true);
  });

  it('generates 400 holes with the documented names', () => {
    const rb = resolveBoard(builtinCatalog().getBoard('breadboard_400@1')!);
    expect(rb.holes.size).toBe(400);
    expect(rb.holes.has('a1')).toBe(true);
    expect(rb.holes.has('j30')).toBe(true);
    expect(rb.holes.has('k1')).toBe(false);
    expect(rb.holes.has('a31')).toBe(false);
    expect(rb.holes.has('top_outer_25')).toBe(true);
    expect(rb.holes.has('top_outer_26')).toBe(false);
    expect(holeAtLocal(rb, rb.holes.get('c5')!.local_um)!.name).toBe('c5');
    expect(holeAtLocal(rb, [rb.holes.get('c5')!.local_um[0] + 1000, rb.holes.get('c5')!.local_um[1]])).toBeNull();
  });
});

describe('two boards', () => {
  it('joining boards creates no electrical edge; a jumper does; removing it breaks it again', () => {
    const d0 = build(twoBoards);
    const a0 = analyzeDesign(d0);
    expect(a0.model.boards.size).toBe(2);
    expect(a0.connectivity.full.connected('bb_a.a30', 'bb_b.a1')).toBe(false);
    expect(a0.connectivity.full.connected('bb_a.top_outer_25', 'bb_b.top_outer_1')).toBe(false);
    expect(a0.connectivity.full.connected('bb_a.bottom_inner_25', 'bb_b.bottom_inner_1')).toBe(false);

    const d1 = build([{ op: 'add_wire', wire: { id: 'j1', from: { hole: 'bb_a.a30' }, to: { hole: 'bb_b.a1' }, color: 'red' } }], d0);
    const a1 = analyzeDesign(d1);
    expect(a1.connectivity.full.connected('bb_a.e30', 'bb_b.e1')).toBe(true);
    expect(a1.connectivity.full.connected('bb_a.a29', 'bb_b.a1')).toBe(false);

    const d2 = build([{ op: 'remove_wire', id: 'j1' }], d1);
    expect(analyzeDesign(d2).connectivity.full.connected('bb_a.a30', 'bb_b.a1')).toBe(false);
  });

  it('grid-aligned attachment keeps hole grids on one 2.54 mm lattice', () => {
    const d = build(twoBoards);
    const a = analyzeDesign(d);
    const pa = a.model.boards.get('bb_a')!;
    const pb = a.model.boards.get('bb_b')!;
    const ha = pa.resolved.holes.get('a30')!.local_um;
    const hb = pb.resolved.holes.get('a1')!.local_um;
    const dx = pb.transform.position[0] + hb[0] - (pa.transform.position[0] + ha[0]);
    const dy = pb.transform.position[1] + hb[1] - (pa.transform.position[1] + ha[1]);
    expect(dx % 2540).toBe(0);
    expect(dy).toBe(0);
    expect(pb.bounds.x).toBeGreaterThanOrEqual(pa.bounds.x + pa.bounds.w);
    expect(pb.bounds.x - (pa.bounds.x + pa.bounds.w)).toBeLessThan(2540);
  });

  it('models the modular terminal block and +/- strip as independent physical boards', () => {
    const terminal = resolveBoard(builtinCatalog().getBoard('breadboard_400_terminal@1')!);
    const power = resolveBoard(builtinCatalog().getBoard('breadboard_power_strip_25@1')!);
    expect(terminal.holes.size).toBe(300);
    expect(terminal.holes.has('a1')).toBe(true);
    expect(terminal.holes.has('j30')).toBe(true);
    expect(terminal.holes.has('positive_1')).toBe(false);
    expect(terminal.bounds.h).toBe(35560);
    expect(power.holes.size).toBe(50);
    expect(power.holes.has('negative_1')).toBe(true);
    expect(power.holes.has('positive_25')).toBe(true);
    expect(power.holes.has('a1')).toBe(false);
    expect(power.bounds.h).toBe(12700);
  });
});
