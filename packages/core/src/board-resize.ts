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
 * 几何规则（以下标 0 的接线块为基准）：
 * - 孔距 pitch 恒定（真实尺寸由 2.54 mm 网格决定）；
 * - 面包板的「行数」指**每块接线块的行数**（400 板 a–e / f–j 各 5 行 → rows ∈ [1..5]）；
 *   洞洞板则把每个物理行建模成一个单行接线块，因此 rows 是整块板的物理行数：
 *   各块保留自己行字母的前缀（上块 a–e 截前 n 行、下块 f–j 截前 n 行），孔号稳定；
 * - 列号是数字，增减都支持，列名天然稳定；
 * - 电源轨孔数按列数等比缩放，分段形态（如 MB-102 的中间断开）按比例保留；
 * - 板宽 = 孔区新宽度 + 原塑料边。
 *
 * 纵向是「从每块接线块的**尾部**各去掉 k 行，所有固定边距与块间距都不变」：
 * 上块 origin 不动；每跨过一块接线块的**尾行**，它下面的东西就整体上移 k 个孔距。
 * 所以一个 y 坐标的位移 = −k × pitch ×（它上方压着几块接线块的尾行）。中央沟槽在
 * 两块之间、下块和下方电源轨都在尾行之下，各自跟着上移 —— 只挪接线块会把这些
 * 留在原地（沟槽压到下块孔上、电源轨掉到板外）。板高 = 原高 − 块数 × k × pitch。
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

/**
 * 校验（不是 clamp）：op / CLI 这条路上越界必须报错。静默把 `columns=999` 改成
 * 120、把 `rows=0` 改成 1，会让调用方以为写进去的是自己要的尺寸 —— CLI 与 agent
 * 接口（`bb apply` / patch）是公开契约，宁可拒绝。
 */
export function resizePlanError(plan: BoardResizePlan, shape: BoardShape): string | null {
  const { min, max } = RESIZE_LIMITS.columns;
  if (!Number.isInteger(plan.columns) || plan.columns < min || plan.columns > max) {
    return `列数必须是 ${min}–${max} 之间的整数（收到 ${JSON.stringify(plan.columns)}）`;
  }
  if (!Number.isInteger(plan.rows) || plan.rows < 1 || plan.rows > shape.rows) {
    return `行数必须是 1–${shape.rows} 之间的整数（收到 ${JSON.stringify(plan.rows)}）`;
  }
  return null;
}

/** 检查一块板能不能按行列数派生：只有「行 × 列接线块」形态（面包板）可以。 */
export function canResizeBoard(def: BoardDefinition): boolean {
  const first = def.terminal_blocks[0];
  if (!first) return false;
  if (def.render.style === 'perfboard') return def.terminal_blocks.every((b) => b.columns === first.columns && b.rows.length === 1);
  return def.terminal_blocks.every((b) => b.columns === first.columns && b.rows.length === first.rows.length);
}

/** 从型号定义推断它当前的 (columns, rows) —— 以第一个接线块为准。 */
export function boardShape(def: BoardDefinition): BoardShape | null {
  const block = def.terminal_blocks[0];
  if (!block) return null;
  if (def.render.style === 'perfboard') return { columns: block.columns, rows: def.terminal_blocks.length };
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
 * 用 `add_definition` 内嵌进设计。这里仍然 clamp（列 5–120，行 1–原行数）只是
 * 兜底：op / CLI 那条路会先用 `resizePlanError` 拒绝越界，不靠 clamp 静默改数。
 */
export function resizeBoardDefinition(source: BoardDefinition, rawPlan: BoardResizePlan, newId: string): BoardDefinition {
  const shape = boardShape(source);
  if (!shape) throw new Error(`${source.name} 没有「行 × 列」形态的接线块，不能按行列数缩放`);
  const plan = clampResizePlan(rawPlan, shape);

  const def: BoardDefinition = structuredClone(source);
  def.id = newId;
  def.version = source.version + 1;
  def.variant = '自定义尺寸';
  def.description = `由 ${source.name}（${source.id}@${source.version}）自定义尺寸派生：${plan.columns} 列 × ${plan.rows} 行${source.render.style === 'perfboard' ? '（整板）' : '（每块）'}。孔距、导通规则与原型号一致。`;

  const pitch = def.pitch_um;
  const oldColumns = shape.columns;
  const oldRows = shape.rows;

  if (source.render.style === 'perfboard') {
    const rows = source.terminal_blocks.slice(0, plan.rows).map((block) => ({
      ...block,
      first_column: 1,
      columns: plan.columns,
      rows: [...block.rows]
    }));
    def.terminal_blocks = rows;
    def.rails = [];
    def.ravines = [];
    const [oldW, oldH] = source.size_um;
    def.size_um = [Math.round(oldW - (oldColumns - 1) * pitch + (plan.columns - 1) * pitch), Math.round(oldH - (oldRows - plan.rows) * pitch)];
    def.geometry_status = 'approximate';
    def.sources = [{ title: `Derived from ${source.id}@${source.version} by the in-canvas size editor (issue #22)` }];
    return def;
  }

  const blockCount = def.terminal_blocks.length;
  /** 每块接线块被去掉的行数（行数只能减不能加，所以 ≥ 0）。 */
  const droppedRows = oldRows - plan.rows;
  /** 跨过一块接线块尾行后的纵向位移量（缩小为正 = 上移）。 */
  const rowStep = droppedRows * pitch;
  /** 原定义里每块接线块的尾行 y；某个 y 上方压着几块尾行，就上移几个 rowStep。 */
  const blockTails = def.terminal_blocks.map((b) => b.origin_um[1] + (oldRows - 1) * pitch);
  const shiftFor = (y: number) => -rowStep * blockTails.filter((tail) => y > tail).length;

  // --- 接线块：上块 origin 不动；第 i 块在它上方压了 i 块尾行，整体上移 i × rowStep ---
  def.terminal_blocks = def.terminal_blocks.map((block, i) => ({
    ...block,
    first_column: 1,
    columns: plan.columns,
    rows: block.rows.slice(0, plan.rows),
    origin_um: [block.origin_um[0], block.origin_um[1] - i * rowStep] as PointUm
  }));

  // --- 电源轨：孔数按列数等比缩（保持"轨长/板长"的观感），分段形态按比例保留；
  //     y 跟着它上方压着的尾行一起上移（下方两条轨属于下块以下，会移得更多） ---
  def.rails = def.rails.map((rail) => {
    const origin_um: PointUm = [rail.origin_um[0], rail.origin_um[1] + shiftFor(rail.origin_um[1])];
    if (oldColumns <= 1 || rail.holes <= 1 || oldColumns === plan.columns) return { ...rail, origin_um };
    const holes = Math.max(1, Math.round(((rail.holes - 1) * (plan.columns - 1)) / (oldColumns - 1)) + 1);
    if (holes === rail.holes) return { ...rail, origin_um, holes };
    const scale = (holes - 1) / (rail.holes - 1);
    const segments = rail.segments.map(([s, e], i): [number, number] => {
      const start = Math.max(1, Math.round((s - 1) * scale) + 1);
      const end = i === rail.segments.length - 1 ? holes : Math.max(start, Math.min(holes - 1, Math.round((e - 1) * scale) + 1));
      return [start, end];
    });
    return { ...rail, origin_um, holes, segments };
  });

  // --- 外形：孔区缩放，塑料边宽度保持。高度 = 原高 − 每块各去掉的 k 行（每块一块算一次） ---
  const [oldW, oldH] = def.size_um;
  def.size_um = [
    Math.round(oldW - (oldColumns - 1) * pitch + (plan.columns - 1) * pitch),
    Math.round(oldH - blockCount * rowStep)
  ];

  // --- 中央沟槽：跟着它所在的块间空隙上移，长度铺满新的板宽 ---
  def.ravines = def.ravines.map((rv) => ({
    ...rv,
    y_um: rv.y_um + shiftFor(rv.y_um + rv.h_um / 2),
    x_um: 0,
    w_um: def.size_um[0]
  }));

  def.geometry_status = 'approximate';
  def.sources = [{ title: `Derived from ${source.id}@${source.version} by the in-canvas size editor (issue #22)` }];
  return def;
}
