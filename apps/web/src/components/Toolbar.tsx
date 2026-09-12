import { useEffect, useRef, useState } from 'react';
import { EXAMPLES, useStore, type AppMode } from '../store';
import { useSimulatorStore } from '../simulator/simulatorStore';
import { exportJsonFile, exportPngFile, exportSvgFile } from '../exporters';
import { SimulatorToolbar } from '../simulator/ui/SimulatorToolbar';
import { WireColorPicker } from './WireColorPicker';

/** 每次点击的缩放倍率。够小才不"跳"，长按可以连续缩放。 */
const ZOOM_STEP_IN = 1.15;
const ZOOM_STEP_OUT = 1 / ZOOM_STEP_IN;
/** 长按多久开始连续缩放，以及连发间隔（ms）。 */
const ZOOM_HOLD_DELAY = 260;
const ZOOM_HOLD_INTERVAL = 55;

/**
 * 缩放按钮：点一下走一步，按住不放则无极连续缩放。
 * 单击仍走 `onClick`，所以键盘（Enter/空格）和读屏器不受影响。
 */
function ZoomButton({
  label,
  factor,
  title,
  testId
}: {
  label: string;
  factor: number;
  title: string;
  testId: string;
}) {
  const delay = useRef<number | null>(null);
  const repeat = useRef<number | null>(null);

  const stop = () => {
    if (delay.current !== null) window.clearTimeout(delay.current);
    if (repeat.current !== null) window.clearInterval(repeat.current);
    delay.current = null;
    repeat.current = null;
  };

  const start = () => {
    stop();
    delay.current = window.setTimeout(() => {
      repeat.current = window.setInterval(() => canvasApi()?.zoomBy(factor), ZOOM_HOLD_INTERVAL);
    }, ZOOM_HOLD_DELAY);
  };

  useEffect(() => stop, []);

  return (
    <button
      onClick={() => canvasApi()?.zoomBy(factor)}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      title={title}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/**
 * The one control that says which half of the app you are in. Switching back to
 * 搭建 ends a live session (the simulator store watches `mode`), so the label is
 * a promise: in 搭建 the design is always editable, in 仿真 it is always frozen.
 */
function ModeSwitch({ mode }: { mode: AppMode }) {
  // Only 仿真 can hold a session, so the switch never has to show one running on the
  // 搭建 side; `live` is here to tell the user that leaving will end it.
  const live = useSimulatorStore((s) => s.status) !== 'idle';
  const set = (m: AppMode) => useStore.getState().setMode(m);
  return (
    <div className="mode-switch" role="group" aria-label="模式" data-testid="mode-switch">
      <button
        className={mode === 'build' ? 'active' : ''}
        aria-pressed={mode === 'build'}
        onClick={() => set('build')}
        title={live ? '搭建：结束当前仿真会话，解冻设计' : '搭建：放置元件、接线、修改设计'}
        data-testid="mode-build"
      >
        搭建
      </button>
      <button
        className={mode === 'sim' ? 'active' : ''}
        aria-pressed={mode === 'sim'}
        onClick={() => set('sim')}
        title="仿真：运行程序、按控件、观察串口与引脚（设计冻结）"
        data-testid="mode-sim"
      >
        仿真
      </button>
      <button
        className={mode === 'hardware' ? 'active' : ''}
        aria-pressed={mode === 'hardware'}
        onClick={() => set('hardware')}
        title="实机：用串口连接一块真板，看它的输出。不是仿真——真板的引脚接的是桌上的真元件"
        data-testid="mode-hardware"
      >
        实机
      </button>
      <button
        className={mode === 'preview3d' ? 'active' : ''}
        aria-pressed={mode === 'preview3d'}
        onClick={() => set('preview3d')}
        title="3D 预览：把同一份设计渲染成实体，看高度和走线（只读，不改设计）"
        data-testid="mode-preview3d"
      >
        3D 预览
      </button>
    </div>
  );
}

interface CanvasApi {
  fit: () => void;
  zoomBy: (f: number) => void;
  zoomTo: (z: number) => void;
  rotateBy: (deltaDeg: number) => void;
  rotateTo: (deg: number) => void;
}

function canvasApi(): CanvasApi | undefined {
  return (window as unknown as { __bbsCanvas?: CanvasApi }).__bbsCanvas;
}

export function Toolbar() {
  const design = useStore((s) => s.design);
  const tool = useStore((s) => s.tool);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const showHoleLabels = useStore((s) => s.showHoleLabels);
  const showPinLabels = useStore((s) => s.showPinLabels);
  const connectivityHighlight = useStore((s) => s.connectivityHighlight);
  const dimUnhighlighted = useStore((s) => s.dimUnhighlighted);
  const wireColor = useStore((s) => s.wireColor);
  const wireRoute = useStore((s) => s.wireRoute);
  const storage = useStore((s) => s.storage);
  const mode = useStore((s) => s.mode);
  const selectedCount = useStore((s) => s.selectedIds.length);
  const hasClipboard = useStore((s) => !!s.clipboard);
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
      {/* Mode decides what the toolbar offers: 搭建 edits the document, 仿真 drives a session.
          Nothing that writes the design is rendered in 仿真, so nothing has to be refused later. */}
      {mode === 'build' ? (
        <>
        <div className="tool-group" role="group" aria-label="工具">
          <button className={tool === 'select' ? 'active' : ''} onClick={() => st.setTool('select')} title="选择/移动 (V)" data-testid="tool-select">选择</button>
          <button className={tool === 'wire' ? 'active' : ''} onClick={() => st.setTool('wire')} title="接线 (W)" data-testid="tool-wire">接线</button>
          <button className={tool === 'pan' ? 'active' : ''} onClick={() => st.setTool('pan')} title="平移 (H / 空格拖动)" data-testid="tool-pan">平移</button>
        </div>
        {tool === 'wire' && (
          <div className="tool-group wire-opts">
            <span className="wire-color-label">颜色</span>
            <WireColorPicker value={wireColor} onChange={st.setWireColor} testId="wire-color" />
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
        <button onClick={st.copySelection} disabled={!selectedCount} title="复制选中的元件/面包板 (⌘C)" data-testid="copy">复制</button>
        <button onClick={() => st.pasteClipboard(null)} disabled={!hasClipboard} title="粘贴 (⌘V 粘到指针所在的孔位；按钮粘到原位右下方)" data-testid="paste">粘贴</button>
        </>
      ) : mode === 'sim' ? (
        <SimulatorToolbar />
      ) : mode === 'preview3d' ? (
        <span className="muted small" data-testid="preview3d-hint">3D 预览：只读视角，编辑请切回「搭建」</span>
      ) : (
        <span className="muted small" data-testid="hardware-hint">实机：连接一块真板看它的输出，画布只读</span>
      )}
      {mode !== 'preview3d' && (
        <>
          <span className="sep" />
          <ZoomButton label="＋" factor={ZOOM_STEP_IN} title="放大（按住连续缩放）" testId="zoom-in" />
          <ZoomButton label="－" factor={ZOOM_STEP_OUT} title="缩小（按住连续缩放）" testId="zoom-out" />
          <button
            onClick={() => canvasApi()?.rotateBy(90)}
            onContextMenu={(e) => { e.preventDefault(); canvasApi()?.rotateBy(-90); }}
            title="视图旋转 90°（右键反向转；只影响显示，不改设计数据）"
            data-testid="rotate-view"
          >
            ⟳ 旋转
          </button>
          <button onClick={() => canvasApi()?.fit()} title="适应全部 (F)" data-testid="fit">适应全部</button>
        </>
      )}
      <span className="sep" />
      <label className="toggle"><input type="checkbox" checked={showHoleLabels} onChange={st.toggleHoleLabels} data-testid="toggle-hole-labels" />孔号</label>
      <label className="toggle"><input type="checkbox" checked={showPinLabels} onChange={st.togglePinLabels} />针脚名</label>
      <label className="toggle"><input type="checkbox" checked={connectivityHighlight} onChange={st.toggleConnectivityHighlight} data-testid="toggle-connectivity" />导通高亮</label>
      <label className="toggle" title="选中元件或孔时，把无关的导线压暗，只留下直连的那几根"><input type="checkbox" checked={dimUnhighlighted} onChange={st.toggleDimUnhighlighted} data-testid="toggle-dim" />聚焦选中</label>
      <span className="spacer" />
      <ModeSwitch mode={mode} />
      <span className={`storage ${storage.state}`} data-testid="storage-status">{storageText}</span>
    </div>
  );
}
