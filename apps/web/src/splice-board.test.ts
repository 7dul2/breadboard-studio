import { describe, it, expect } from 'vitest';
import { applyOps, buildModel } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { createEmptyDesign } from '@breadboard-studio/core';
import { MODULE_COLUMNS, MODULE_ROWS, SPLICE_DEFAULTS, SPLICE_STRIP_ID, clampSpliceSpec, planSplice, spliceOps, spliceSummary } from './splice-board';

const catalog = builtinCatalog();

describe('拼装面包板', () => {
  it('默认规划：横着连一排，第一个是根件', () => {
    const plan = planSplice(SPLICE_DEFAULTS);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.attach).toBeUndefined();
    expect(plan[1]!.attach).toEqual({ to: plan[0]!.key, side: 'right' });
  });

  it('逐排往下接，每个 attach.to 都指向前面已经出现过的件', () => {
    for (const stripBetween of [false, true]) {
      for (const across of [1, 2, 5]) {
        for (const down of [1, 2, 3]) {
          const plan = planSplice({ across, down, stripBetween });
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

  it('纵向之间夹电源条：数量对得上，且接在上一排那一列的下方', () => {
    const plan = planSplice({ across: 2, down: 2, stripBetween: true });
    const strips = plan.filter((p) => p.model === SPLICE_STRIP_ID);
    expect(strips).toHaveLength(2);
    for (const s of strips) expect(s.attach!.side).toBe('bottom');
    // 每个电源条下面接一块板
    for (const s of strips) expect(plan.some((p) => p.attach?.to === s.key && p.attach.side === 'bottom')).toBe(true);
  });

  it('汇总：列/行/块数按模块尺寸算', () => {
    expect(spliceSummary({ across: 3, down: 2, stripBetween: true })).toEqual({
      columns: 3 * MODULE_COLUMNS,
      rows: 2 * MODULE_ROWS,
      modules: 6,
      strips: 3
    });
    expect(spliceSummary({ across: 1, down: 1, stripBetween: true }).strips).toBe(0);
  });

  it('越界输入夹回区间', () => {
    expect(clampSpliceSpec({ across: 0, down: 99, stripBetween: false })).toEqual({ across: 1, down: 4, stripBetween: false });
    expect(clampSpliceSpec({ across: 99, down: -1, stripBetween: false })).toEqual({ across: 6, down: 1, stripBetween: false });
  });

  it('落库后真的拼在一起：孔位落在同一套 2.54mm 网格上，且板与板不重叠', () => {
    let n = 0;
    const { ops, ids } = spliceOps({ across: 2, down: 2, stripBetween: true }, () => `bb_${++n}`, { position_um: [0, 0] });
    expect(ops).toHaveLength(6); // 4 块板 + 2 条电源条
    const r = applyOps(createEmptyDesign('拼装'), ops, { catalog });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const model = buildModel(r.design, catalog);
    expect(model.boards.size).toBe(6);

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
    expect(ids).toHaveLength(6);
  });

  it('横向拼起来是一整排：孔距仍是 2.54mm，中间只隔板边留白', () => {
    let n = 0;
    const { ops } = spliceOps({ across: 2, down: 1, stripBetween: false }, () => `bb_${++n}`, { position_um: [0, 0] });
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
