import { useRef, useState } from 'react';
import { EXAMPLES, useStore } from '../store';
import { exportJsonFile, exportPngFile, exportSvgFile } from '../exporters';
import { WIRE_COLORS } from '@breadboard-studio/render';
import { SimulatorToolbar } from '../simulator/ui/SimulatorToolbar';

const COLOR_NAMES: Record<string, string> = { red: '红', black: '黑', blue: '蓝', yellow: '黄', green: '绿', white: '白', orange: '橙', purple: '紫', brown: '棕', gray: '灰' };

function canvasApi() {
  return (window as unknown as { __bbsCanvas?: { fit: () => void; zoomBy: (f: number) => void; zoomTo: (z: number) => void } }).__bbsCanvas;
}

export function Toolbar() {
  const design = useStore((s) => s.design);
  const tool = useStore((s) => s.tool);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const showHoleLabels = useStore((s) => s.showHoleLabels);
  const showPinLabels = useStore((s) => s.showPinLabels);
  const connectivityHighlight = useStore((s) => s.connectivityHighlight);
  const wireColor = useStore((s) => s.wireColor);
  const wireRoute = useStore((s) => s.wireRoute);
  const storage = useStore((s) => s.storage);
  const buildMode = useStore((s) => s.buildMode);
  const canRestore = useStore((s) => s.canRestorePrevious);
  const st = useStore.getState();
  const [menu, setMenu] = useState<null | 'project' | 'export'>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onImportFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    st.importJson(text);
  };

  const storageText = storage.state === 'saved' ? `已本地保存 ${new Date(storage.at).toLocaleTimeString()}` : storage.state === 'error' ? `⚠ ${storage.message}` : storage.state === 'unavailable' ? `⚠ ${storage.message}` : '未保存';

  return (
    <div className="toolbar" onMouseLeave={() => setMenu(null)}>
      <div className="brand">
        <strong>Breadboard Studio</strong>
        <span className="muted">v0.1</span>
      </div>
      <div className="menu-wrap">
        <button className={menu === 'project' ? 'active' : ''} onClick={() => setMenu(menu === 'project' ? null : 'project')} data-testid="menu-project">
          项目 ▾
        </button>
        {menu === 'project' && (
          <div className="menu" role="menu">
            <button onClick={() => { st.newProject(); setMenu(null); }} data-testid="menu-new">新建空项目</button>
            <div className="menu-label">示例</div>
            {EXAMPLES.map((e) => (
              <button key={e.key} onClick={() => { st.loadExample(e.key); setMenu(null); }} data-testid={`example-${e.key}`}>
                {e.name}
              </button>
            ))}
            <div className="menu-sep" />
            <button onClick={() => { fileRef.current?.click(); setMenu(null); }} data-testid="menu-import">导入 .breadboard.json…</button>
            <button onClick={() => { exportJsonFile(design); setMenu(null); }} data-testid="menu-export-json">导出 .breadboard.json</button>
            <button disabled={!canRestore} onClick={() => { st.restorePrevious(); setMenu(null); }} data-testid="menu-restore">恢复上一个项目</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden data-testid="import-input" onChange={(e) => { void onImportFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <div className="menu-wrap">
        <button className={menu === 'export' ? 'active' : ''} onClick={() => setMenu(menu === 'export' ? null : 'export')} data-testid="menu-export">
          导出 ▾
        </button>
        {menu === 'export' && (
          <div className="menu">
            <button onClick={() => { exportSvgFile(design, { showHoleLabels }); setMenu(null); }} data-testid="export-svg">SVG（含图例）</button>
            <button onClick={() => { void exportPngFile(design, { showHoleLabels }).catch((e) => st.toast('error', `PNG 导出失败：${(e as Error).message}`)); setMenu(null); }} data-testid="export-png">PNG（2×）</button>
            <button onClick={() => { exportJsonFile(design); setMenu(null); }}>.breadboard.json</button>
            <div className="menu-label">SVG/PNG 包含孔号开关、图例与未验证徽标</div>
          </div>
        )}
      </div>
      <span className="sep" />
      <div className="tool-group" role="group" aria-label="工具">
        <button className={tool === 'select' ? 'active' : ''} onClick={() => st.setTool('select')} title="选择/移动 (V)" data-testid="tool-select">选择</button>
        <button className={tool === 'wire' ? 'active' : ''} onClick={() => st.setTool('wire')} title="接线 (W)" data-testid="tool-wire">接线</button>
        <button className={tool === 'pan' ? 'active' : ''} onClick={() => st.setTool('pan')} title="平移 (H / 空格拖动)" data-testid="tool-pan">平移</button>
      </div>
      {tool === 'wire' && (
        <div className="tool-group wire-opts">
          <label>
            颜色
            <select value={wireColor} onChange={(e) => st.setWireColor(e.target.value)} data-testid="wire-color">
              {Object.keys(WIRE_COLORS).filter((c) => c !== 'grey' && c !== 'cyan' && c !== 'pink').map((c) => (
                <option key={c} value={c}>{COLOR_NAMES[c] ?? c}（{c}）</option>
              ))}
            </select>
          </label>
          <span className="swatch" style={{ background: WIRE_COLORS[wireColor] }} />
          <label>
            走线
            <select value={wireRoute} onChange={(e) => st.setWireRoute(e.target.value as 'flat' | 'elevated')} data-testid="wire-route">
              <option value="flat">硬质跳线（路径不重叠）</option>
              <option value="elevated">杜邦线（允许重叠/跨越）</option>
            </select>
          </label>
        </div>
      )}
      <span className="sep" />
      <button onClick={st.undo} disabled={!past} title="撤销 (⌘Z)" data-testid="undo">撤销</button>
      <button onClick={st.redo} disabled={!future} title="重做 (⇧⌘Z)" data-testid="redo">重做</button>
      <span className="sep" />
      <button onClick={() => canvasApi()?.zoomBy(1.25)} title="放大">＋</button>
      <button onClick={() => canvasApi()?.zoomBy(0.8)} title="缩小">－</button>
      <button onClick={() => canvasApi()?.fit()} title="适应全部 (F)" data-testid="fit">适应全部</button>
      <span className="sep" />
      <label className="toggle"><input type="checkbox" checked={showHoleLabels} onChange={st.toggleHoleLabels} data-testid="toggle-hole-labels" />孔号</label>
      <label className="toggle"><input type="checkbox" checked={showPinLabels} onChange={st.togglePinLabels} />针脚名</label>
      <label className="toggle"><input type="checkbox" checked={connectivityHighlight} onChange={st.toggleConnectivityHighlight} data-testid="toggle-connectivity" />导通高亮</label>
      <span className="sep" />
      <SimulatorToolbar />
      <span className="sep" />
      <button className={buildMode ? 'active' : ''} onClick={() => st.setBuildMode(!buildMode)} data-testid="build-mode">搭建模式</button>
      <span className="spacer" />
      <span className={`storage ${storage.state}`} data-testid="storage-status">{storageText}</span>
    </div>
  );
}
