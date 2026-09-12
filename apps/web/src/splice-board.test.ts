import { describe, it, expect } from 'vitest';
import { applyOps, buildModel } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { createEmptyDesign } from '@breadboard-studio/core';
import { MODULE_COLUMNS, MODULE_ROWS, SPLICE_DEFAULTS, SPLICE_MODULE_ID, SPLICE_STRIP_ID, clampSpliceSpec, planSplice, spliceOps, spliceSummary } from './splice-board';

const catalog = builtinCatalog();

describe('拼装面包板', () => {
  it('默认规划：横着连一排，第一个是根件，两侧各一条电源条', () => {
    const plan = planSplice(SPLICE_DEFAULTS);
    expect(plan.map((p) => p.model)).toEqual([SPLICE_MODULE_ID, SPLICE_MODULE_ID, SPLICE_STRIP_ID, SPLICE_STRIP_ID, SPLICE_STRIP_ID, SPLICE_STRIP_ID]);
    expect(plan[0]!.attach).toBeUndefined();
    expect(plan[1]!.attach).toEqual({ to: plan[0]!.key, side: 'right' });
  });

  it('逐排往下接，每个 attach.to 都指向前面已经出现过的件', () => {
    for (const sideStrips of [false, true]) {
      for (const across of [1, 2, 5]) {
        for (const down of [1, 2, 3]) {
          const plan = planSplice({ across, down, sideStrips });
          const seen = new Set<string>();
          for (const p of plan) {
            if (p.attach) expect(seen.has(p.attach.to), `${p.key} -> ${p.attach.to}`).toBe(true);
            seen.add(p.key);
          }
          expect(plan.filter((p) => !p.attach)).toHaveLength(1);
        }
      }
    }
  });

  it('中间用的是不带电源轨的中间接线板，纵向之间不夹电源条', () => {
    const plan = planSplice({ across: 2, down: 2, sideStrips: true });
    const modules = plan.filter((p) => p.model === SPLICE_MODULE_ID);
    expect(modules).toHaveLength(4);
    // 定义里确实没有电源轨
    expect(catalog.getBoard(`${SPLICE_MODULE_ID}@1`)!.rails).toEqual([]);
    // 第二排是直接接在第一排下面，中间没有别的东西
    for (let c = 0; c < 2; c++) {
      const lower = plan.find((p) => p.key === `m1c${c}`)!;
      expect(lower.attach).toEqual({ to: `m0c${c}`, side: 'bottom' });
    }
    // 除了最上和最下，没有别的电源条
    const strips = plan.filter((p) => p.model === SPLICE_STRIP_ID);
    expect(strips).toHaveLength(4);
    expect(strips.map((s) => s.attach!.side).sort()).toEqual(['bottom', 'bottom', 'top', 'top']);
    for (const s of strips) expect(s.attach!.to).toMatch(/^m[01]c[01]$/);
  });

  it('电源条接在最上一排的上边和最下一排的下边，每列一条', () => {
    const plan = planSplice({ across: 3, down: 2, sideStrips: true });
    const top = plan.filter((p) => p.model === SPLICE_STRIP_ID && p.attach!.side === 'top');
    const bottom = plan.filter((p) => p.model === SPLICE_STRIP_ID && p.attach!.side === 'bottom');
    expect(top).toHaveLength(3);
    expect(bottom).toHaveLength(3);
    expect(top.map((p) => p.attach!.to)).toEqual(['m0c0', 'm0c1', 'm0c2']);
    expect(bottom.map((p) => p.attach!.to)).toEqual(['m1c0', 'm1c1', 'm1c2']);
  });

  it('汇总：列/行/块数按模块尺寸算，电源条数 = 列数 × 2', () => {
    expect(spliceSummary({ across: 3, down: 2, sideStrips: true })).toEqual({
      columns: 3 * MODULE_COLUMNS,
      rows: 2 * MODULE_ROWS,
      modules: 6,
      strips: 6
    });
    expect(spliceSummary({ across: 1, down: 1, sideStrips: true }).strips).toBe(2);
    expect(spliceSummary({ across: 4, down: 3, sideStrips: false }).strips).toBe(0);
  });

  it('越界输入夹回区间', () => {
    expect(clampSpliceSpec({ across: 0, down: 99, sideStrips: false })).toEqual({ across: 1, down: 4, sideStrips: false });
    expect(clampSpliceSpec({ across: 99, down: -1, sideStrips: false })).toEqual({ across: 6, down: 1, sideStrips: false });
  });

  it('落库后真的拼在一起：孔位落在同一套 2.54mm 网格上，且板与板不重叠', () => {
    let n = 0;
    const { ops, ids } = spliceOps({ across: 2, down: 2, sideStrips: true }, () => `bb_${++n}`, { position_um: [0, 0] });
    expect(ops).toHaveLength(8); // 4 块中间接线板 + 4 条电源条
    const r = applyOps(createEmptyDesign('拼装'), ops, { catalog });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const model = buildModel(r.design, catalog);
    expect(model.boards.size).toBe(8);

    // 所有孔必须在同一套全局网格上：x 对 2.54mm 取模的余数处处相同
    const residues = new Set<number>();
    for (const pb of model.boards.values()) {
      for (const hole of pb.resolved.holes.values()) {
        if (hole.kind !== 'terminal') continue;
        const gx = pb.transform.position[0] + hole.local_um[0];
        residues.add(((gx % 2540) + 2540) % 2540);
      }
    }
    expect([...residues]).toHaveLength(1);

    // 没有两块板的包围盒重叠
    const boxes = [...model.boards.values()].map((b) => b.bounds);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `board ${i} 与 ${j} 重叠`).toBe(false);
      }
    }
    expect(ids).toHaveLength(8);
  });

  it('电源条落在整块的最上和最下：上条在下条之上，且中间四块都不带电源轨', () => {
    let n = 0;
    const { ops } = spliceOps({ across: 2, down: 2, sideStrips: true }, () => `bb_${++n}`, { position_um: [0, 0] });
    const r = applyOps(createEmptyDesign('拼装'), ops, { catalog });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const model = buildModel(r.design, catalog);
    const byModel = (id: string) => [...model.boards.values()].filter((b) => b.instance.model.startsWith(id));
    const modules = byModel(SPLICE_MODULE_ID);
    const strips = byModel(SPLICE_STRIP_ID);
    const top = Math.min(...modules.map((b) => b.bounds.y));
    const bottom = Math.max(...modules.map((b) => b.bounds.y + b.bounds.h));
    // 每条电源条都完全在中间四块的上下之外
    for (const s of strips) {
      const above = s.bounds.y + s.bounds.h <= top + 1;
      const below = s.bounds.y >= bottom - 1;
      expect(above || below, `电源条 y=${s.bounds.y} 落在中间段里了`).toBe(true);
    }
    expect(strips.filter((s) => s.bounds.y + s.bounds.h <= top + 1)).toHaveLength(2);
    expect(strips.filter((s) => s.bounds.y >= bottom - 1)).toHaveLength(2);
    // 中间四块一条轨都没有：它们的孔全是接线孔
    for (const m of modules) {
      const rails = [...m.resolved.holes.values()].filter((h) => h.kind === 'rail');
      expect(rails).toHaveLength(0);
      expect([...m.resolved.holes.values()].filter((h) => h.kind === 'terminal')).toHaveLength(MODULE_COLUMNS * MODULE_ROWS);
    }
  });

  it('横向拼起来是一整排：孔距仍是 2.54mm，中间只隔板边留白', () => {
    let n = 0;
    const { ops } = spliceOps({ across: 2, down: 1, sideStrips: false }, () => `bb_${++n}`, { position_um: [0, 0] });
    const r = applyOps(createEmptyDesign('拼装'), ops, { catalog });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const model = buildModel(r.design, catalog);
    expect(model.boards.size).toBe(2);
    const positions = [...model.boards.values()].map((b) => b.bounds.x).sort((a, b) => a - b);
    const gapPitches = (positions[1]! - positions[0]!) / 2540;
    // 是整数个孔距（对齐到网格），且只隔了板子两边的留白（不超过 6 个孔距）
    expect(Number.isInteger(gapPitches)).toBe(true);
    expect(gapPitches).toBeGreaterThan(MODULE_COLUMNS - 1);
    expect(gapPitches).toBeLessThan(MODULE_COLUMNS + 6);
    // 两块板各自都是 1..30 列
    for (const pb of model.boards.values()) {
      const cols = new Set<number>();
      for (const hole of pb.resolved.holes.values()) if (hole.kind === 'terminal' && hole.column !== undefined) cols.add(hole.column);
      expect(Math.min(...cols)).toBe(1);
      expect(Math.max(...cols)).toBe(MODULE_COLUMNS);
    }
  });
});
