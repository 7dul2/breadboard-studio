/**
 * 自定义面包板：按用户给的尺寸现算一份板定义，再作为 embedded_catalog 内嵌进设计。
 *
 * 为什么是"现算一份定义"而不是给内置板加参数：`resolveBoard(def)` 完全从
 * `terminal_blocks` / `rails` 的静态数字展开（packages/core/src/board.ts），
 * 板卡这一路根本没有 params 的概念（只有元件有 params_schema），而且
 * ResolvedBoard 是按 def 对象缓存的，加参数要一起改缓存键、模型和 schema。
 * 生成一份定义则原样走既有管线：布线、规则、导出、CLI、仿真都照常。
 *
 * 数字全部沿用内置 830 板（MB-102 类）的排版常量，所以列距、行距、
 * 电源轨分组（5 孔一组、组间空 1 个孔距）、凹槽位置都和实物一致。
 */
import type { BoardDefinition } from '@breadboard-studio/schema';

/** 面包板孔距（0.1 in）。 */
export const PITCH_UM = 2540;
/** 板左边缘到第 1 列的距离。 */
const MARGIN_X_UM = 3810;
/** 上半区第 1 行到板顶的距离（顶轨 5710 + 轨间距 2540 + 2 行 5080）。 */
const BLOCK_TOP_UM = 13330;
/** 顶部外侧电源轨的 y。 */
const TOP_RAIL_Y_UM = 5710;
/** 凹槽：上半区最后一行往下 2200 起，高 3200。 */
const RAVINE_ABOVE_UM = 2200;
const RAVINE_H_UM = 3200;
/** 凹槽底到下半区第 1 行。 */
const RAVINE_BELOW_UM = 2210;
/** 接线区最后一行到内侧电源轨 / 内侧轨到外侧轨的距离。 */
const RAIL_INSET_UM = 5080;
/** 电源轨第 1 孔相对第 1 列偏移的列数（830 板是第 3 列）。 */
const RAIL_FIRST_COLUMN_OFFSET = 2;

const ROW_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;

export interface CustomBoardSpec {
  /** 接线区列数。 */
  columns: number;
  /** 上/下半区各有几行（1..5）。 */
  rowsPerHalf: number;
  /** 是否带 4 条电源轨。 */
  rails: boolean;
  /** 电源轨是否在中间断开成两段。 */
  splitRails: boolean;
}

export const CUSTOM_BOARD_LIMITS = {
  columns: { min: 4, max: 120 },
  rowsPerHalf: { min: 1, max: 5 }
} as const;

export const CUSTOM_BOARD_DEFAULTS: CustomBoardSpec = { columns: 30, rowsPerHalf: 5, rails: true, splitRails: true };

export function clampSpec(spec: CustomBoardSpec): CustomBoardSpec {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v) || min));
  return {
    columns: clamp(spec.columns, CUSTOM_BOARD_LIMITS.columns.min, CUSTOM_BOARD_LIMITS.columns.max),
    rowsPerHalf: clamp(spec.rowsPerHalf, CUSTOM_BOARD_LIMITS.rowsPerHalf.min, CUSTOM_BOARD_LIMITS.rowsPerHalf.max),
    rails: Boolean(spec.rails),
    splitRails: Boolean(spec.splitRails)
  };
}

/**
 * 电源轨孔位是"5 孔一组、组间空 1 个孔距"（见 board.ts 的 group_size / gap_pitches），
 * 所以能塞进多少孔要反解：第 i 孔落在第 p+1 列，p = ⌊(i-1)/5⌋·6 + (i-1)%5。
 * 左右各留 2 列不布轨 —— 内置 830 板正是这样：63 列配 50 孔（第 3–61 列）。
 */
export function maxRailHoles(columns: number): number {
  const maxP = columns - 1 - 2 * RAIL_FIRST_COLUMN_OFFSET;
  if (maxP < 0) return 0;
  const g = Math.floor(maxP / 6);
  const k = Math.min(4, maxP - g * 6);
  return g * 5 + k + 1;
}

/** 同一份 spec 永远给出同一个 id，所以重复创建不会堆出多份同尺寸定义。 */
export function customBoardId(spec: CustomBoardSpec): string {
  const s = clampSpec(spec);
  const rails = s.rails ? (s.splitRails ? '_rail_split' : '_rail') : '_norail';
  return `breadboard_custom_${s.columns}x${s.rowsPerHalf * 2}${rails}`;
}

export function customBoardName(spec: CustomBoardSpec): string {
  const s = clampSpec(spec);
  const rail = s.rails ? `，电源轨 4×${maxRailHoles(s.columns)} 孔${s.splitRails ? '（中间断开）' : ''}` : '，无电源轨';
  return `自定义面包板 ${s.columns} 列 × ${s.rowsPerHalf * 2} 行${rail}`;
}

export function buildCustomBoard(input: CustomBoardSpec): BoardDefinition {
  const spec = clampSpec(input);
  const { columns, rowsPerHalf } = spec;

  const upperRows = ROW_LETTERS.slice(0, rowsPerHalf);
  const lowerRows = ROW_LETTERS.slice(5, 5 + rowsPerHalf);
  const upperLastY = BLOCK_TOP_UM + (rowsPerHalf - 1) * PITCH_UM;
  const ravineY = upperLastY + RAVINE_ABOVE_UM;
  const lowerOriginY = ravineY + RAVINE_H_UM + RAVINE_BELOW_UM;
  const lowerLastY = lowerOriginY + (rowsPerHalf - 1) * PITCH_UM;
  const bottomInnerY = lowerLastY + RAIL_INSET_UM;
  const bottomOuterY = bottomInnerY + PITCH_UM;

  const widthUm = 2 * MARGIN_X_UM + (columns - 1) * PITCH_UM;
  // 上下留白对称：外侧轨距板边 5710，即顶部那条轨的 y。
  const heightUm = bottomOuterY + TOP_RAIL_Y_UM;

  const railHoles = maxRailHoles(columns);
  // 板太窄时一条轨连一个孔都放不下，这时干脆不带轨（segments 不能出现 [1,0]）。
  const withRails = spec.rails && railHoles >= 1;
  const half = Math.floor(railHoles / 2);
  const segments: [number, number][] = spec.splitRails && railHoles >= 2 ? [[1, half], [half + 1, railHoles]] : [[1, railHoles]];
  const railX = MARGIN_X_UM + RAIL_FIRST_COLUMN_OFFSET * PITCH_UM;
  const rail = (id: string, y: number, marking: '+' | '-', side: 'above' | 'below') => ({
    id,
    holes: railHoles,
    origin_um: [railX, y] as [number, number],
    group_size: 5,
    gap_pitches: 1,
    segments,
    marking,
    marking_color: marking === '+' ? '#dc2626' : '#2563eb',
    marking_side: side
  });

  const id = customBoardId(spec);
  const holes = columns * rowsPerHalf * 2 + (withRails ? railHoles * 4 : 0);

  return {
    kind: 'board',
    id,
    version: 1,
    name: customBoardName(spec),
    manufacturer: 'custom',
    model: `${columns} × ${rowsPerHalf * 2} solderless breadboard (user-defined size)`,
    description: `${columns} 列 × ${rowsPerHalf * 2} 行接线区（上 ${upperRows.join('–')} / 下 ${lowerRows.join('–')}，每列 ${rowsPerHalf} 孔一组导通）${
      withRails ? `，上下各 2 条 ${railHoles} 孔电源轨${spec.splitRails ? '，每条第 ' + half + '/' + (half + 1) + ' 孔之间断开' : ''}` : '，不带电源轨'
    }；共 ${holes} 孔。尺寸按用户输入生成，排版常量取自内置 830 板。`,
    size_um: [widthUm, heightUm],
    pitch_um: PITCH_UM,
    terminal_blocks: [
      { id: 'ae', rows: [...upperRows], first_column: 1, columns, origin_um: [MARGIN_X_UM, BLOCK_TOP_UM] },
      { id: 'fj', rows: [...lowerRows], first_column: 1, columns, origin_um: [MARGIN_X_UM, lowerOriginY] }
    ],
    rails: withRails
      ? [rail('top_outer', TOP_RAIL_Y_UM, '-', 'above'), rail('top_inner', TOP_RAIL_Y_UM + PITCH_UM, '+', 'below'), rail('bottom_inner', bottomInnerY, '+', 'above'), rail('bottom_outer', bottomOuterY, '-', 'below')]
      : [],
    ravines: [{ x_um: 0, y_um: ravineY, w_um: widthUm, h_um: RAVINE_H_UM }],
    render: { body_color: '#f3f1e9', edge_color: '#c9c5b6', hole_color: '#3b3b3b', label_color: '#6b6b6b', corner_radius_um: 1500 },
    geometry_status: 'approximate',
    electrical_status: 'approximate',
    status_notes: '尺寸由用户在 Breadboard Studio 里给定，不是厂商实测型号；孔距按 2.54 mm，电源轨在中间断开时使用前请用万用表确认断点。',
    sources: [
      {
        title: '用户自定义尺寸（生成自内置 830 板 MB-102 排版常量）',
        accessed: new Date().toISOString().slice(0, 10),
        note: '孔距 2.54 mm、电源轨 5 孔一组组间空 1 孔距、凹槽居中，均与内置 breadboard_830 一致。'
      }
    ],
    license: { spdx: 'MIT', attribution: 'Generated by Breadboard Studio' }
  } as BoardDefinition;
}
