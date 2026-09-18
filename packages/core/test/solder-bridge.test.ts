import { describe, expect, it } from 'vitest';
import { analyzeDesign, applyOps, createEmptyDesign, type Op } from '../src/index.js';

/**
 * 焊锡桥（R1.3，schema 1.2）：与导线等价地并入导通组（`connectivity.full`），但
 * **不是导线**——不占线号、不进线长统计；校验只禁止"同一对孔重复桥接"，
 * 非相邻给 warning（实物上做不出来）。
 */

const perfboard: Op = { op: 'add_board', board: { id: 'pb', model: 'perfboard_5x7@1', position_um: [0, 0], rotation_deg: 0 } };
const breadboard: Op = { op: 'add_board', board: { id: 'bb', model: 'breadboard_400@1', position_um: [120000, 0], rotation_deg: 0 } };
const bridge = (a: string, b: string, id?: string): Op => ({ op: 'add_solder_bridge', bridge: { ...(id ? { id } : {}), a, b } });

function build(ops: Op[]) {
  const r = applyOps(createEmptyDesign('t'), ops);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.design;
}
const tryBuild = (ops: Op[]) => applyOps(createEmptyDesign('t'), ops);
const failure = (ops: Op[]): string => {
  const r = tryBuild(ops);
  if (r.ok) throw new Error('期望失败但成功了');
  return r.error.message;
};
const codes = (ops: Op[]) => analyzeDesign(build(ops)).results.map((r) => r.code);

describe('焊锡桥接', () => {
  it('相邻两盘可以桥接：并入同一导通组，并记在孔的 bridges 上', () => {
    const design = build([perfboard, bridge('pb.A1', 'pb.A2', 'sb1')]);
    expect(design.solder_bridges).toEqual([{ id: 'sb1', a: 'pb.A1', b: 'pb.A2' }]);
    const a = analyzeDesign(design);
    expect(a.connectivity.full.connected('pb.A1', 'pb.A2')).toBe(true);
    expect(a.connectivity.boardOnly.connected('pb.A1', 'pb.A2')).toBe(true);
    expect(a.model.holes.get('pb.A1')!.bridges).toEqual(['sb1']);
    expect(a.results.filter((r) => r.severity === 'error')).toEqual([]);
    expect(codes([perfboard, bridge('pb.A1', 'pb.A2', 'sb1')])).not.toContain('bridge_non_adjacent');
  });

  it('跨非相邻焊盘：允许但报 warning（实物上做不出来）', () => {
    const a = analyzeDesign(build([perfboard, bridge('pb.A1', 'pb.X18')]));
    const warn = a.results.filter((r) => r.code === 'bridge_non_adjacent');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.severity).toBe('warning');
    // 非相邻照样导通（只是 warning，不是禁止）
    expect(a.connectivity.full.connected('pb.A1', 'pb.X18')).toBe(true);
  });

  it('同一对孔不许重复桥接（顺序无关），但可以串成一排', () => {
    expect(failure([perfboard, bridge('pb.A1', 'pb.A2'), bridge('pb.A1', 'pb.A2')])).toContain('这一对孔已经被桥接过了');
    expect(failure([perfboard, bridge('pb.A1', 'pb.A2'), bridge('pb.A2', 'pb.A1')])).toContain('这一对孔已经被桥接过了');
    // A1–A2 + A2–A3：一个焊盘属于两座桥，实物上的正常做法（规格只禁止重复对）
    const chained = analyzeDesign(build([perfboard, bridge('pb.A1', 'pb.A2'), bridge('pb.A2', 'pb.A3')]));
    expect(chained.results.filter((r) => r.severity === 'error')).toEqual([]);
    expect(chained.connectivity.full.connected('pb.A1', 'pb.A3')).toBe(true);
    expect(chained.model.holes.get('pb.A2')!.bridges).toHaveLength(2);
  });

  it('端点必须是同一块洞洞板上的焊盘', () => {
    const badAddress = tryBuild([perfboard, bridge('pb.A1', 'nope')]);
    expect(badAddress.ok).toBe(false);
    if (!badAddress.ok) expect(badAddress.error.message).toContain('端点须为');
    expect(failure([perfboard, breadboard, bridge('bb.a1', 'bb.a2')])).toContain('只能焊在洞洞板上');
    expect(failure([perfboard, breadboard, bridge('pb.A1', 'bb.a1')])).toContain('只能焊在洞洞板上');
    expect(failure([perfboard, { op: 'add_board', board: { id: 'pb2', model: 'perfboard_5x7@1', position_um: [90000, 0], rotation_deg: 0 } }, bridge('pb.A1', 'pb2.A1')])).toContain('必须在同一块板上');
  });

  it('手改文件里的坏桥：规则报 bridge_bad_endpoint，且不进导通图', () => {
    const base = build([perfboard, breadboard]);
    const broken = { ...base, solder_bridges: [{ id: 'sb1', a: 'bb.a1', b: 'bb.a2' }] };
    const a = analyzeDesign(broken);
    expect(a.results.some((r) => r.code === 'bridge_bad_endpoint' && r.severity === 'error')).toBe(true);
    expect(a.connectivity.full.connected('bb.a1', 'bb.a2')).toBe(false);
    // 孔号形状合法但不存在也一样拦（不允许静默写坏数据）
    const missingHole = analyzeDesign(build([perfboard, bridge('pb.A1', 'pb.zz9')]));
    expect(missingHole.results.some((r) => r.code === 'bridge_bad_endpoint')).toBe(true);
    expect(missingHole.connectivity.full.connected('pb.A1', 'pb.zz9')).toBe(false);
  });

  it('拆掉桥后导通图恢复', () => {
    const withBridge = build([perfboard, bridge('pb.A1', 'pb.A2', 'sb1')]);
    const r = applyOps(withBridge, [{ op: 'remove_solder_bridge', id: 'sb1' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.design.solder_bridges).toEqual([]);
    expect(analyzeDesign(r.design).connectivity.full.connected('pb.A1', 'pb.A2')).toBe(false);
  });

  it('桥不是导线：不占线号、不进线数统计', () => {
    const design = build([
      perfboard,
      { op: 'add_wire', wire: { id: 'w1', from: { hole: 'pb.A1' }, to: { hole: 'pb.X18' }, color: 'red' } },
      bridge('pb.A2', 'pb.A3')
    ]);
    expect(design.solder_bridges![0]!.id).toBe('sb1');
    expect(design.wires.map((w) => w.id)).toEqual(['w1']);
    expect(analyzeDesign(design).model.wires.size).toBe(1);
  });
});
