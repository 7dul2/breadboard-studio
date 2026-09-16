import type { BoardDefinition, PointUm } from '@breadboard-studio/schema';

/**
 * 面包板尺寸编辑（issue #22）：把一块已有型号按孔距缩放出一份自定义定义。
 *
 * 不是去改目录里的内置型号 —— 内置定义是共享的、可能被多块板引用，而且带着
 * 证据链和来源，直接改会把"这个型号是什么"的事实破坏掉。这里做的是**派生**：
 * 以原定义为模板，按新行列数重建 terminal_blocks / rails / ravines / size_um，
 * 版本号 +1，id 加 `_custom` 后缀（schema 的 id pattern 是 `^[a-z0-9_]+$`），
 * 交给 `add_definition` 内嵌进当前设计。同一块板的多次调整都是**从原型号重新
 * 派生**（挂到最新的自定义定义），所以一次尺寸编辑 = 一次 apply = 一次撤销。
 *
 * 几何规则（以下标 0 的接线块为基准，上下两块对称的板一起缩）：
 * - 孔距 pitch 恒定（真实尺寸由 2.54 mm 网格决定）；
 * - 「行数」指**每块接线块的行数**（400 板 a–e / f–j 各 5 行 → rows ∈ [1..5]）：
 *   各块保留自己行字母的前缀（上块 a–e 截前 n 行、下块 f–j 截前 n 行），孔号稳定；
 * - 上块 origin 不动、下块跟着新行数往上挪，块间距（中央沟槽宽）保持不变；
 * - 列号是数字，增减都支持，列名天然稳定；
 * - 电源轨在上下塑料边里，塑料边宽度不变，所以轨的 origin 不动，孔数按列数
 *   等比缩放，分段形态（如 MB-102 的中间断开）按比例保留；
 * - 板宽/板高 = 孔区新尺寸 + 原塑料边。
 */

export const CUSTOM_SUFFIX = '_custom';

export interface BoardResizePlan {
  columns: number;
  rows: number;
}

/** 原型号的形状（行数上限来自它自己）。 */
export interface BoardShape {
  columns: number;
  rows: number;
}

/** 列数的硬边界；行数上限取决于原型号（每块的行数）。 */
export const RESIZE_LIMITS = { columns: { min: 5, max: 120 } } as const;

export function clampResizePlan(plan: BoardResizePlan, shape: BoardShape): BoardResizePlan {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v) || min));
  return {
    columns: clamp(plan.columns, RESIZE_LIMITS.columns.min, RESIZE_LIMITS.columns.max),
    rows: clamp(plan.rows, 1, shape.rows)
  };
}

/** 检查一块板能不能按行列数派生：只有「行 × 列接线块」形态（面包板）可以。 */
export function canResizeBoard(def: BoardDefinition): boolean {
  const first = def.terminal_blocks[0];
  if (!first) return false;
  return def.terminal_blocks.every((b) => b.columns === first.columns && b.rows.length === first.rows.length);
}

/** 从型号定义推断它当前的 (columns, rows) —— 以第一个接线块为准。 */
export function boardShape(def: BoardDefinition): BoardShape | null {
  const block = def.terminal_blocks[0];
  if (!block) return null;
  return { columns: block.columns, rows: block.rows.length };
}

/** 为派生定义生成一个不与 `taken` 冲突的 id。 */
export function customDefId(sourceId: string, taken: Set<string>): string {
  const base = `${sourceId}${CUSTOM_SUFFIX}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/**
 * 缩放。`source` 是原型号定义；返回一份新的定义（深拷贝修改），调用方负责
 * 用 `add_definition` 内嵌进设计。行列数会先 clamp（列 5–120，行 1–原行数）。
 */
export function resizeBoardDefinition(source: BoardDefinition, rawPlan: BoardResizePlan, newId: string): BoardDefinition {
  const shape = boardShape(source);
  if (!shape) throw new Error(`${source.name} 没有「行 × 列」形态的接线块，不能按行列数缩放`);
  const plan = clampResizePlan(rawPlan, shape);

  const def: BoardDefinition = structuredClone(source);
  def.id = newId;
  def.version = source.version + 1;
  def.variant = '自定义尺寸';
  def.description = `由 ${source.name}（${source.id}@${source.version}）自定义尺寸派生：${plan.columns} 列 × ${plan.rows} 行（每块）。孔距、导通规则与原型号一致。`;

  const pitch = def.pitch_um;
  const oldColumns = shape.columns;
  const oldRows = shape.rows;

  // --- 接线块：第一块 origin 不动；后续块按「固定块间距 + 新行数」重排，行字母取前缀 ---
  const blockGap = def.terminal_blocks.length > 1
    ? def.terminal_blocks[1]!.origin_um[1] - def.terminal_blocks[0]!.origin_um[1] - (oldRows - 1) * pitch
    : 0;
  def.terminal_blocks = def.terminal_blocks.map((block, i) => ({
    ...block,
    first_column: 1,
    columns: plan.columns,
    rows: block.rows.slice(0, plan.rows),
    origin_um: [block.origin_um[0], def.terminal_blocks[0]!.origin_um[1] + i * ((plan.rows - 1) * pitch + blockGap)] as PointUm
  }));

  // --- 电源轨：孔数按列数等比缩（保持"轨长/板长"的观感），分段形态按比例保留 ---
  def.rails = def.rails.map((rail) => {
    if (oldColumns <= 1 || rail.holes <= 1 || oldColumns === plan.columns) return rail;
    const holes = Math.max(1, Math.round(((rail.holes - 1) * (plan.columns - 1)) / (oldColumns - 1)) + 1);
    if (holes === rail.holes) return { ...rail, holes };
    const scale = (holes - 1) / (rail.holes - 1);
    const segments = rail.segments.map(([s, e], i): [number, number] => {
      const start = Math.max(1, Math.round((s - 1) * scale) + 1);
      const end = i === rail.segments.length - 1 ? holes : Math.max(start, Math.min(holes - 1, Math.round((e - 1) * scale) + 1));
      return [start, end];
    });
    return { ...rail, holes, segments };
  });

  // --- 外形：孔区缩放，塑料边宽度保持 ---
  const [oldW, oldH] = def.size_um;
  const gridOldX = (oldColumns - 1) * pitch;
  const gridOldY = (oldRows - 1) * pitch;
  const gridNewX = (plan.columns - 1) * pitch;
  const gridNewY = (plan.rows - 1) * pitch;
  def.size_um = [Math.round(oldW - gridOldX + gridNewX), Math.round(oldH - 2 * gridOldY + 2 * gridNewY)];

  // --- 中央沟槽：y 不动（对称缩放），长度铺满新的板宽 ---
  def.ravines = def.ravines.map((rv) => ({ ...rv, x_um: 0, w_um: def.size_um[0] }));

  def.geometry_status = 'approximate';
  def.sources = [{ title: `Derived from ${source.id}@${source.version} by the in-canvas size editor (issue #22)` }];
  return def;
}
