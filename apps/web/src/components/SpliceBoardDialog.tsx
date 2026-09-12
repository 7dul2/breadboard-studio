import { useMemo, useState } from 'react';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { MODULE_COLUMNS, MODULE_ROWS, SPLICE_DEFAULTS, SPLICE_LIMITS, SPLICE_MODULE_ID, SPLICE_STRIP_ID, clampSpliceSpec, planSplice, spliceSummary, type SpliceSpec } from '../splice-board';

/**
 * 「拼装面包板」：不新造定义，直接用目录里可拼接的 300 孔中间接线板 + 电源条
 * 按 attach_to 拼出来 —— 拼出来的每一块都是标准件，之后照样能单独选中、移动、删掉。
 * 中间接线板本身不带电源轨，电源是拼在整块上下两侧的独立电源条。
 */
export function SpliceBoardDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (spec: SpliceSpec) => void }) {
  const [across, setAcross] = useState(SPLICE_DEFAULTS.across);
  const [down, setDown] = useState(SPLICE_DEFAULTS.down);
  const [sideStrips, setSideStrips] = useState(SPLICE_DEFAULTS.sideStrips);
  const spec: SpliceSpec = { across, down, sideStrips };
  const shown = clampSpliceSpec(spec);
  const summary = spliceSummary(spec);
  const plan = useMemo(() => planSplice(spec), [across, down, sideStrips]);

  const holes = useMemo(() => {
    const catalog = builtinCatalog();
    const moduleHoles = countHoles(catalog.getBoard(`${SPLICE_MODULE_ID}@1`));
    const stripHoles = countHoles(catalog.getBoard(`${SPLICE_STRIP_ID}@1`));
    return summary.modules * moduleHoles + summary.strips * stripHoles;
  }, [summary.modules, summary.strips]);

  return (
    <div className="model-detail-layer" onPointerDown={onClose} data-testid="splice-board-layer">
      <article className="model-detail-card" role="dialog" aria-modal="false" aria-labelledby="splice-board-title" onPointerDown={(e) => e.stopPropagation()} data-testid="splice-board-card">
        <button className="model-detail-close" onClick={onClose} aria-label="关闭" title="关闭">×</button>
        <div className="model-detail-body">
          <span className="model-kind">面包板</span>
          <h2 id="splice-board-title">拼装面包板</h2>
          <p className="muted">
            用元件库里<b>可拼接</b>的标准件拼：每块 <code>breadboard_400_terminal</code> 是 {MODULE_COLUMNS} 列 × {MODULE_ROWS} 行、
            本身<b>不带电源轨</b>；电源用独立的 <code>breadboard_power_strip_25</code>（+/−，各 25 孔）
            拼在整块的上下两侧。横向按 <code>right</code>、纵向按 <code>bottom</code> 自动对齐孔距吸附。
            拼出来的每一块都是独立的标准件，可以单独选中、挪走或删掉。
          </p>
          <div className="board-form">
            <label className="field">
              <span>横向几块（每块 {MODULE_COLUMNS} 列）</span>
              <select value={across} onChange={(e) => setAcross(Number(e.target.value))} data-testid="splice-across">
                {range(SPLICE_LIMITS.across.min, SPLICE_LIMITS.across.max).map((n) => (
                  <option key={n} value={n}>{n} 块 · {n * MODULE_COLUMNS} 列</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>纵向几块（每块 {MODULE_ROWS} 行）</span>
              <select value={down} onChange={(e) => setDown(Number(e.target.value))} data-testid="splice-down">
                {range(SPLICE_LIMITS.down.min, SPLICE_LIMITS.down.max).map((n) => (
                  <option key={n} value={n}>{n} 块 · {n * MODULE_ROWS} 行</option>
                ))}
              </select>
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={sideStrips} onChange={(e) => setSideStrips(e.target.checked)} data-testid="splice-side-strips" />
              上下两侧各拼一条电源条（每列 {SPLICE_STRIP_ID.replace('breadboard_', '')}，+/− 各 25 孔）
            </label>
          </div>
          <dl className="model-facts">
            <div><dt>成品接线区</dt><dd>{summary.columns} 列 × {summary.rows} 行</dd></div>
            <div><dt>用件</dt><dd>{summary.modules} 块中间接线板{summary.strips ? ` + ${summary.strips} 条电源条` : '（不含电源）'}</dd></div>
            <div><dt>总孔数</dt><dd>{holes}</dd></div>
            <div><dt>落库操作</dt><dd>{plan.length} × add_board（自动吸附）</dd></div>
          </dl>
          <p className="muted" style={{ fontSize: 11 }}>
            横向两块之间会隔出板子本身的塑料边（约 3 个孔距），不会真的连成 60 个连续孔号 —— 那是两块板。
            {shown.sideStrips && ' 电源条只拼在最上和最下，中间不夹电源。'}
          </p>
        </div>
        <div className="model-detail-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onCreate(spec)} data-testid="splice-create">拼出来</button>
        </div>
      </article>
    </div>
  );
}

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

function countHoles(def: { terminal_blocks: { columns: number; rows: string[] }[]; rails: { holes: number }[] } | undefined): number {
  if (!def) return 0;
  return def.terminal_blocks.reduce((n, b) => n + b.columns * b.rows.length, 0) + def.rails.reduce((n, r) => n + r.holes, 0);
}
