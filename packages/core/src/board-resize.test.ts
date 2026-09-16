import { describe, expect, it } from 'vitest';
import { builtinCatalog, parseModelRef } from '@breadboard-studio/catalog';
import { applyOps, createEmptyDesign } from './index.js';
import { boardShape, canResizeBoard, clampResizePlan, customDefId, resizeBoardDefinition, RESIZE_LIMITS } from './board-resize.js';
import { buildModel, catalogForDesign } from './model.js';
import type { BoardDefinition } from '@breadboard-studio/schema';

const bb400 = builtinCatalog().getBoard('breadboard_400@1')! as BoardDefinition;
const bb830 = builtinCatalog().getBoard('breadboard_830@1')! as BoardDefinition;
const terminal = builtinCatalog().getBoard('breadboard_400_terminal@1')! as BoardDefinition;

describe('board-resize: 派生规则', () => {
  it('面包板可缩放；行数=每块的行数，上限是原型号自己的行数', () => {
    expect(canResizeBoard(bb400)).toBe(true);
    expect(canResizeBoard(terminal)).toBe(true);
    expect(boardShape(bb400)).toEqual({ columns: 30, rows: 5 });
    expect(clampResizePlan({ columns: 3, rows: 99 }, { columns: 30, rows: 5 })).toEqual({ columns: RESIZE_LIMITS.columns.min, rows: 5 });
  });

  it('孔距不变、孔号编址稳定：40 列的 400 板首孔仍是 a1，最后一列是 a40', () => {
    const def = resizeBoardDefinition(bb400, { columns: 40, rows: 5 }, 'breadboard_400_custom');
    expect(def.pitch_um).toBe(bb400.pitch_um);
    expect(def.terminal_blocks.map((b) => b.columns)).toEqual([40, 40]);
    expect(def.terminal_blocks.map((b) => b.rows)).toEqual([['a', 'b', 'c', 'd', 'e'], ['f', 'g', 'h', 'i', 'j']]);
  });

  it('外形按孔区缩放、塑料边保留：30→40 列宽度多 10 个孔距', () => {
    const def = resizeBoardDefinition(bb400, { columns: 40, rows: 10 }, 'breadboard_400_custom');
    expect(def.size_um[0]).toBe(bb400.size_um[0] + 10 * bb400.pitch_um);
    expect(def.size_um[1]).toBe(bb400.size_um[1]); // 行数没变
  });

  it('行裁剪保持各块自己的行字母前缀（a–e / f–j 截前 3 行），板高相应缩小', () => {
    const def = resizeBoardDefinition(bb400, { columns: 30, rows: 3 }, 'breadboard_400_custom');
    expect(def.terminal_blocks[0]!.rows).toEqual(['a', 'b', 'c']);
    expect(def.terminal_blocks[1]!.rows).toEqual(['f', 'g', 'h']);
    // 上下两块各少两行，块间距不变 → 板高少 4 个孔距
    expect(def.size_um[1]).toBe(bb400.size_um[1] - 4 * bb400.pitch_um);
    // 下块上移，中央沟槽保持居中
    const gapOld = bb400.terminal_blocks[1]!.origin_um[1] - bb400.terminal_blocks[0]!.origin_um[1] - 4 * bb400.pitch_um;
    const gapNew = def.terminal_blocks[1]!.origin_um[1] - def.terminal_blocks[0]!.origin_um[1] - 2 * def.pitch_um;
    expect(gapNew).toBe(gapOld);
  });

  it('电源轨孔数随列数等比缩放，分段形态保留（MB-102 中间断开）', () => {
    const def = resizeBoardDefinition(bb830, { columns: 33, rows: 10 }, 'breadboard_830_custom');
    // 50 孔轨：50*(33-1)/62+1 ≈ 26
    expect(def.rails[0]!.holes).toBe(26);
    expect(def.rails[0]!.segments).toHaveLength(2);
    expect(def.rails[0]!.segments.at(-1)![1]).toBe(26);
    // 断点大致还在中间
    expect(def.rails[0]!.segments[0]![1]).toBeGreaterThanOrEqual(12);
  });

  it('可拆拼装的中间接线板也能缩放（本身没有电源轨/沟槽只有一条）', () => {
    const def = resizeBoardDefinition(terminal, { columns: 15, rows: 10 }, 'breadboard_400_terminal_custom');
    expect(def.rails).toHaveLength(0);
    expect(def.terminal_blocks[0]!.columns).toBe(15);
    expect(def.ravines[0]!.w_um).toBe(def.size_um[0]);
  });

  it('id 命名：不冲突用后缀，冲突自动编号', () => {
    expect(customDefId('breadboard_400', new Set())).toBe('breadboard_400_custom');
    expect(customDefId('breadboard_400', new Set(['breadboard_400_custom']))).toBe('breadboard_400_custom2');
  });
});

describe('resize_board op', () => {
  const base = () => {
    const r = applyOps(createEmptyDesign('t'), [{ op: 'add_board', board: { id: 'bb1', model: 'breadboard_400@1', position_um: [0, 0] } }], { allow_blocking: true });
    if (!r.ok) throw new Error(r.error.message);
    return r.design;
  };

  it('一次 op 完成派生+内嵌+挂载：板渲染为新尺寸，孔号一致', () => {
    const r = applyOps(base(), [{ op: 'resize_board', id: 'bb1', columns: 40, rows: 5 }], { allow_blocking: true });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.changed).toContain('bb1');
    const ref = r.design.boards[0]!.model;
    expect(parseModelRef(ref)?.id).toBe('breadboard_400_custom');
    const cat = catalogForDesign(r.design, builtinCatalog());
    const def = cat.getBoard(ref)!;
    expect(def.terminal_blocks[0]!.columns).toBe(40);
    const model = buildModel(r.design, builtinCatalog());
    expect(model.boards.get('bb1')!.bounds.w).toBeGreaterThan(82550);
    // 孔 a1 与 a40 都解析得到
    expect(model.boards.get('bb1')!.resolved.holes.has('a40')).toBe(true);
  });

  it('再次编辑从原型号重新派生，旧自定义定义被清掉', () => {
    const once = applyOps(base(), [{ op: 'resize_board', id: 'bb1', columns: 40, rows: 5 }], { allow_blocking: true });
    if (!once.ok) throw new Error(once.error.message);
    const twice = applyOps(once.design, [{ op: 'resize_board', id: 'bb1', columns: 20, rows: 4 }], { allow_blocking: true });
    if (!twice.ok) throw new Error(twice.error.message);
    const d = twice.design;
    expect(d.boards[0]!.model).toBe('breadboard_400_custom@2'); // 版本仍是 2：总是从原型号派生
    const customIds = (d.embedded_catalog?.boards ?? []).map((b) => b.id);
    expect(customIds).toEqual(['breadboard_400_custom']);
    const cat = catalogForDesign(d, builtinCatalog());
    expect(cat.getBoard(d.boards[0]!.model)!.terminal_blocks[0]!.columns).toBe(20);
    expect(cat.getBoard(d.boards[0]!.model)!.terminal_blocks[0]!.rows).toEqual(['a', 'b', 'c', 'd']);
  });

  it('两块板都能独立缩放：互不干扰，且自定义 id 不冲突', () => {
    const r0 = applyOps(base(), [{ op: 'add_board', board: { id: 'bb2', model: 'breadboard_830@1', attach_to: { board_id: 'bb1', side: 'right' } } }], { allow_blocking: true });
    if (!r0.ok) throw new Error(r0.error.message);
    const r = applyOps(r0.design, [
      { op: 'resize_board', id: 'bb1', columns: 20, rows: 5 },
      { op: 'resize_board', id: 'bb2', columns: 80, rows: 5 }
    ], { allow_blocking: true });
    if (!r.ok) throw new Error(r.error.message);
    const ids = r.design.boards.map((b) => parseModelRef(b.model)!.id);
    expect(ids).toEqual(['breadboard_400_custom', 'breadboard_830_custom']);
  });

  it('裁剪保护：缩小到组件锚点之外时 op 失败并给出孔号', () => {
    const r0 = applyOps(base(), [{ op: 'add_component', component: { id: 'led1', model: 'led_5mm@1', name: 'LED', placement: { kind: 'board', board_id: 'bb1', anchor_hole: 'a25', anchor_pin: '1', rotation_deg: 0 } } }], { allow_blocking: true });
    if (!r0.ok) throw new Error(r0.error.message);
    const r = applyOps(r0.design, [{ op: 'resize_board', id: 'bb1', columns: 20, rows: 5 }], { allow_blocking: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('a25');
    // 同样的缩小在空板上没问题
    const r2 = applyOps(base(), [{ op: 'resize_board', id: 'bb1', columns: 20, rows: 5 }], { allow_blocking: true });
    expect(r2.ok).toBe(true);
  });

  it('裁剪保护也覆盖电源轨孔：轨孔随列数缩短后，接在上面的导线会拦住裁剪', () => {
    const r0 = applyOps(base(), [{ op: 'add_wire', wire: { from: { hole: 'bb1.top_outer_25' }, to: { hole: 'bb1.top_outer_24' } } }], { allow_blocking: true });
    if (!r0.ok) throw new Error(r0.error.message);
    // 20 列时 top_outer 只剩 17 孔（25→17），25 号孔不存在了
    const r = applyOps(r0.design, [{ op: 'resize_board', id: 'bb1', columns: 20, rows: 5 }], { allow_blocking: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('top_outer_25');
  });

  it('锁定的板不能缩放', () => {
    const r0 = applyOps(base(), [{ op: 'update_property', id: 'bb1', path: 'locked', value: true }], { allow_blocking: true });
    if (!r0.ok) throw new Error(r0.error.message);
    const r = applyOps(r0.design, [{ op: 'resize_board', id: 'bb1', columns: 40, rows: 10 }], { allow_blocking: true });
    expect(r.ok).toBe(false);
  });
});
