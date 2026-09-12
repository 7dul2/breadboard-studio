import { describe, it, expect } from 'vitest';
import { validateBoardDefinition } from '@breadboard-studio/schema';
import { resolveBoard } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { CUSTOM_BOARD_DEFAULTS, buildCustomBoard, clampSpec, customBoardId, maxRailHoles, PITCH_UM } from './custom-board';

const UPPER = ['a', 'b', 'c', 'd', 'e'];
const LOWER = ['f', 'g', 'h', 'i', 'j'];

describe('自定义面包板', () => {
  it('生成的是一份合法板定义（过 schema 校验）', () => {
    for (const spec of [
      CUSTOM_BOARD_DEFAULTS,
      { columns: 8, rowsPerHalf: 1, rails: false, splitRails: false },
      { columns: 120, rowsPerHalf: 5, rails: true, splitRails: true },
      { columns: 30, rowsPerHalf: 5, rails: true, splitRails: false }
    ]) {
      const def = buildCustomBoard(spec);
      const r = validateBoardDefinition(def);
      expect(r.ok, `${def.id}: ${JSON.stringify(r.issues)}`).toBe(true);
      expect(def.id).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('电源轨孔数公式复现内置 830 板：63 列 → 50 孔', () => {
    const builtin = builtinCatalog().getBoard('breadboard_830@1')!;
    expect(maxRailHoles(63)).toBe(builtin.rails[0]!.holes);
    // 每 5 孔一组、组间空 1 个孔距，所以孔数不是线性的
    expect(maxRailHoles(5)).toBe(1);
    expect(maxRailHoles(6)).toBe(2);
    expect(maxRailHoles(9)).toBe(5);
    expect(maxRailHoles(10)).toBe(5);
    // 窄到放不下一个孔时，"带电源轨"退化成不带，而不是生成 segments [[1,0]]
    expect(maxRailHoles(4)).toBe(0);
    expect(validateBoardDefinition(buildCustomBoard({ columns: 4, rowsPerHalf: 5, rails: true, splitRails: true })).ok).toBe(true);
    expect(buildCustomBoard({ columns: 4, rowsPerHalf: 5, rails: true, splitRails: true }).rails).toEqual([]);
  });

  it('几何：列距 2.54 mm，孔位和尺寸按 spec 走', () => {
    const def = buildCustomBoard({ columns: 30, rowsPerHalf: 5, rails: true, splitRails: true });
    const rb = resolveBoard(def);

    // 第 1 列第 1 行落在内置 830 板的同一位置：x = 3810，y = 13330
    expect(rb.holes.get('a1')!.local_um).toEqual([3810, 13330]);
    expect(rb.holes.get('b1')!.local_um[1] - rb.holes.get('a1')!.local_um[1]).toBe(PITCH_UM);
    expect(rb.holes.get('a2')!.local_um[0] - rb.holes.get('a1')!.local_um[0]).toBe(PITCH_UM);

    // 最后一列距右边和第一列距左边一样
    const sizeW = 2 * 3810 + 29 * PITCH_UM;
    expect(def.size_um[0]).toBe(sizeW);
    expect(rb.holes.get('a30')!.local_um[0] + 3810).toBe(sizeW);

    // 每列上下各 5 孔、各自成组（a–e 通、f–j 通）
    expect(rb.groups.get('ae1')).toEqual(['a1', 'b1', 'c1', 'd1', 'e1']);
    expect(rb.groups.get('fj1')).toEqual(['f1', 'g1', 'h1', 'i1', 'j1']);

    // 总孔数 = 接线区 + 4 条轨
    const railHoles = def.rails[0]!.holes;
    expect(rb.holes.size).toBe(30 * 10 + railHoles * 4);
  });

  it('电源轨断开/不断开只影响分段，孔位不变', () => {
    const split = resolveBoard(buildCustomBoard({ ...CUSTOM_BOARD_DEFAULTS, splitRails: true }));
    const whole = resolveBoard(buildCustomBoard({ ...CUSTOM_BOARD_DEFAULTS, splitRails: false }));
    const h = split.def.rails[0]!.holes;
    expect(split.def.rails[0]!.segments).toEqual([
      [1, Math.floor(h / 2)],
      [Math.floor(h / 2) + 1, h]
    ]);
    expect(whole.def.rails[0]!.segments).toEqual([[1, h]]);
    // 断开时两段不同组，不断开时同一组，但孔位完全一样
    expect(split.holes.get('top_outer_1')!.group).not.toBe(split.holes.get(`top_outer_${h}`)!.group);
    expect(whole.holes.get('top_outer_1')!.group).toBe(whole.holes.get(`top_outer_${h}`)!.group);
    expect(split.holes.get('top_outer_1')!.local_um).toEqual(whole.holes.get('top_outer_1')!.local_um);
  });

  it('行数变化时上下半区仍然对称，凹槽夹在中间', () => {
    for (const rowsPerHalf of [1, 2, 3, 4, 5]) {
      const def = buildCustomBoard({ columns: 20, rowsPerHalf, rails: true, splitRails: true });
      const rb = resolveBoard(def);
      const lastUpper = rb.holes.get(`${UPPER[rowsPerHalf - 1]}1`)!;
      const firstLower = rb.holes.get(`${LOWER[0]}1`)!;
      const ravine = def.ravines[0]!;
      expect(ravine.y_um).toBeGreaterThan(lastUpper.local_um[1]);
      expect(ravine.y_um + ravine.h_um).toBeLessThan(firstLower.local_um[1]);

      // 上/下半区到各自内侧电源轨的距离相同（上下对称）
      const topInner = def.rails.find((r) => r.id === 'top_inner')!;
      const bottomInner = def.rails.find((r) => r.id === 'bottom_inner')!;
      const above = rb.holes.get('a1')!.local_um[1] - topInner.origin_um[1];
      const below = bottomInner.origin_um[1] - rb.holes.get(`${LOWER[rowsPerHalf - 1]}1`)!.local_um[1];
      expect(above).toBe(below);
      expect(def.size_um[1]).toBeGreaterThan(bottomInner.origin_um[1]);
    }
  });

  it('同尺寸给同一个 id（重复创建不会堆定义），尺寸不同则不同', () => {
    expect(customBoardId({ columns: 30, rowsPerHalf: 5, rails: true, splitRails: true })).toBe(customBoardId(CUSTOM_BOARD_DEFAULTS));
    expect(customBoardId({ columns: 31, rowsPerHalf: 5, rails: true, splitRails: true })).not.toBe(customBoardId(CUSTOM_BOARD_DEFAULTS));
    expect(customBoardId({ columns: 30, rowsPerHalf: 5, rails: false, splitRails: true })).not.toBe(customBoardId(CUSTOM_BOARD_DEFAULTS));
  });

  it('越界输入被夹回合法区间，不会生成非法定义', () => {
    expect(clampSpec({ columns: 0, rowsPerHalf: 99, rails: true, splitRails: true })).toEqual({ columns: 4, rowsPerHalf: 5, rails: true, splitRails: true });
    expect(clampSpec({ columns: 9999, rowsPerHalf: -3, rails: true, splitRails: true })).toEqual({ columns: 120, rowsPerHalf: 1, rails: true, splitRails: true });
    expect(validateBoardDefinition(buildCustomBoard({ columns: 0, rowsPerHalf: 99, rails: false, splitRails: false })).ok).toBe(true);
  });
});
