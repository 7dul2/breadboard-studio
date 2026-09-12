import type { Op } from '@breadboard-studio/core';

/**
 * 拼装面包板：不新造定义，直接用目录里**可拼接**的那几件拼出来。
 *
 * 内置的拼装件（packages/catalog/src/definitions/）：
 *   breadboard_400             30 列 × 10 行，带 4 条电源轨
 *   breadboard_power_strip_25  2 × 25 孔电源条，用来在两排之间分电
 *
 * 横向拼靠 `attach_to.side = right`，纵向靠 `bottom`（core 的 attachBoardPosition
 * 会把位置对齐到孔距网格）。所以这里是纯规划：给出"哪一块接在哪一块的哪一边"，
 * 由调用方去分配 id 并落成 add_board。
 */
export type AttachSideName = 'left' | 'right' | 'top' | 'bottom';

export const SPLICE_MODULE_ID = 'breadboard_400';
export const SPLICE_STRIP_ID = 'breadboard_power_strip_25';
/** 一块 400 孔模块的列数 / 行数。 */
export const MODULE_COLUMNS = 30;
export const MODULE_ROWS = 10;

export interface SpliceSpec {
  /** 横向几块。 */
  across: number;
  /** 纵向几块。 */
  down: number;
  /** 纵向两块之间是否夹一条电源条（分电用）。 */
  stripBetween: boolean;
}

export const SPLICE_LIMITS = { across: { min: 1, max: 6 }, down: { min: 1, max: 4 } } as const;
export const SPLICE_DEFAULTS: SpliceSpec = { across: 2, down: 1, stripBetween: false };

export function clampSpliceSpec(spec: SpliceSpec): SpliceSpec {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v) || min));
  return {
    across: clamp(spec.across, SPLICE_LIMITS.across.min, SPLICE_LIMITS.across.max),
    down: clamp(spec.down, SPLICE_LIMITS.down.min, SPLICE_LIMITS.down.max),
    stripBetween: Boolean(spec.stripBetween)
  };
}

export interface SplicePiece {
  /** 规划内的临时名，仅用于互相引用。 */
  key: string;
  model: string;
  /** 接在哪一块的哪一边；根件没有。 */
  attach?: { to: string; side: AttachSideName };
}

/**
 * 排布顺序即落库顺序：先横着铺满第一排，再逐排往下接，
 * 这样每个 attach.to 引用的件一定已经在前面出现过。
 */
export function planSplice(input: SpliceSpec): SplicePiece[] {
  const spec = clampSpliceSpec(input);
  const pieces: SplicePiece[] = [];
  let above = new Map<number, string>();
  for (let r = 0; r < spec.down; r++) {
    const current = new Map<number, string>();
    for (let c = 0; c < spec.across; c++) {
      // 每列的"上一件"：第一排的左边那一块，或者上一排这一列的末件
      const prev = r === 0 ? (c > 0 ? current.get(c - 1) : undefined) : above.get(c);
      const side: AttachSideName = r === 0 ? 'right' : 'bottom';
      let anchor = prev;
      if (r > 0 && spec.stripBetween) {
        const stripKey = `s${r}c${c}`;
        pieces.push({ key: stripKey, model: SPLICE_STRIP_ID, attach: { to: anchor!, side: 'bottom' } });
        anchor = stripKey;
      }
      const key = `m${r}c${c}`;
      pieces.push({ key, model: SPLICE_MODULE_ID, ...(anchor ? { attach: { to: anchor, side } } : {}) });
      current.set(c, key);
    }
    above = current;
  }
  return pieces;
}

export interface SpliceSummary {
  columns: number;
  rows: number;
  modules: number;
  strips: number;
}

export function spliceSummary(input: SpliceSpec): SpliceSummary {
  const spec = clampSpliceSpec(input);
  return {
    columns: spec.across * MODULE_COLUMNS,
    rows: spec.down * MODULE_ROWS,
    modules: spec.across * spec.down,
    strips: spec.down > 1 && spec.stripBetween ? spec.across * (spec.down - 1) : 0
  };
}

/**
 * 把规划翻成 add_board 操作序列。
 * `allocId` 每次调用要给出一个没用过的 id（批内也不能重复）；`root` 是根件的落点。
 */
export function spliceOps(
  input: SpliceSpec,
  allocId: () => string,
  root: { attach_to?: { board_id: string; side: AttachSideName } } | { position_um: [number, number] }
): { ops: Op[]; ids: string[] } {
  const plan = planSplice(input);
  const ids = new Map<string, string>();
  const ops: Op[] = [];
  plan.forEach((piece, i) => {
    const id = allocId();
    ids.set(piece.key, id);
    const target = piece.attach ? ids.get(piece.attach.to) : undefined;
    ops.push({
      op: 'add_board',
      board: {
        id,
        model: `${piece.model}@1`,
        ...(target ? { attach_to: { board_id: target, side: piece.attach!.side, grid_align: true } } : i === 0 ? root : {})
      }
    } as Op);
  });
  return { ops, ids: [...ids.values()] };
}
