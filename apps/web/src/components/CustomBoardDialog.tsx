import { useMemo, useState } from 'react';
import { CUSTOM_BOARD_DEFAULTS, CUSTOM_BOARD_LIMITS, buildCustomBoard, clampSpec, customBoardId, type CustomBoardSpec } from '../custom-board';

/**
 * 「自定义面包板」对话框：给尺寸，现算一份板定义并内嵌到设计里。
 *
 * "临时"体现在：定义是随设计走的（embedded_catalog），随时可以在「导出」里
 * 看到它、在元件库里再放一块同尺寸的；不想要了从设计里删掉即可，不动内置目录。
 */
export function CustomBoardDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (spec: CustomBoardSpec) => void }) {
  const [columns, setColumns] = useState(CUSTOM_BOARD_DEFAULTS.columns);
  const [rowsPerHalf, setRowsPerHalf] = useState(CUSTOM_BOARD_DEFAULTS.rowsPerHalf);
  const [rails, setRails] = useState(CUSTOM_BOARD_DEFAULTS.rails);
  const [splitRails, setSplitRails] = useState(CUSTOM_BOARD_DEFAULTS.splitRails);
  const spec: CustomBoardSpec = { columns, rowsPerHalf, rails, splitRails };
  const def = useMemo(() => buildCustomBoard(spec), [columns, rowsPerHalf, rails, splitRails]);
  // 输入框里的值可能越界或空，展示以夹过之后的为准（和真正生成的完全一致）。
  const shown = clampSpec(spec);
  const railHoles = def.rails[0]?.holes ?? 0;
  const terminalHoles = shown.columns * shown.rowsPerHalf * 2;
  const railTotal = def.rails.length ? railHoles * 4 : 0;

  const widthMm = (def.size_um[0] / 1000).toFixed(1);
  const heightMm = (def.size_um[1] / 1000).toFixed(1);

  return (
    <div className="model-detail-layer" onPointerDown={onClose} data-testid="custom-board-layer">
      <article className="model-detail-card" role="dialog" aria-modal="false" aria-labelledby="custom-board-title" onPointerDown={(e) => e.stopPropagation()} data-testid="custom-board-card">
        <button className="model-detail-close" onClick={onClose} aria-label="关闭" title="关闭">×</button>
        <div className="model-detail-body">
          <span className="model-kind">面包板</span>
          <h2 id="custom-board-title">自定义面包板</h2>
          <p className="muted">
            给个尺寸，现算一份板定义并内嵌到当前设计。孔距固定 2.54 mm，排版（电源轨分组、凹槽位置、左右留白）
            与内置 830 板一致，所以布线和规则都照常。
          </p>
          <div className="custom-board-form">
            <label className="field">
              <span>接线区列数</span>
              <input
                type="number"
                min={CUSTOM_BOARD_LIMITS.columns.min}
                max={CUSTOM_BOARD_LIMITS.columns.max}
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value))}
                data-testid="custom-board-columns"
              />
            </label>
            <label className="field">
              <span>上/下半区行数</span>
              <select value={rowsPerHalf} onChange={(e) => setRowsPerHalf(Number(e.target.value))} data-testid="custom-board-rows">
                {Array.from({ length: CUSTOM_BOARD_LIMITS.rowsPerHalf.max - CUSTOM_BOARD_LIMITS.rowsPerHalf.min + 1 }, (_, i) => CUSTOM_BOARD_LIMITS.rowsPerHalf.min + i).map((n) => (
                  <option key={n} value={n}>
                    {n} 行（共 {n * 2} 行）
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={rails} onChange={(e) => setRails(e.target.checked)} data-testid="custom-board-rails" />
              带 4 条电源轨
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={splitRails} disabled={!rails} onChange={(e) => setSplitRails(e.target.checked)} data-testid="custom-board-split" />
              电源轨中间断开（像 MB-102）
            </label>
          </div>
          <dl className="model-facts">
            <div><dt>尺寸</dt><dd>{widthMm} × {heightMm} mm</dd></div>
            <div><dt>孔数</dt><dd>{terminalHoles + railTotal}（接线区 {terminalHoles}{railTotal ? ` + 电源轨 ${railTotal}` : ''}）</dd></div>
            <div><dt>列 × 行</dt><dd>{shown.columns} × {shown.rowsPerHalf * 2}</dd></div>
            <div><dt>定义</dt><dd><code>{customBoardId(spec)}@1</code></dd></div>
          </dl>
          {rails && def.rails.length === 0 && <p className="error">这个宽度放不下一个电源轨孔，将按无电源轨生成。</p>}
        </div>
        <div className="model-detail-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onCreate(spec)} data-testid="custom-board-create">生成并添加</button>
        </div>
      </article>
    </div>
  );
}
