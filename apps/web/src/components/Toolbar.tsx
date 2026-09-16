import { useEffect, useRef, useState } from 'react';
import { EXAMPLES, useStore, type AppMode } from '../store';
import { useSimulatorStore } from '../simulator/simulatorStore';
import { exportJsonFile, exportPngFile, exportSvgFile } from '../exporters';
import { SimulatorToolbar } from '../simulator/ui/SimulatorToolbar';
import { WireColorPicker } from './WireColorPicker';
import { WIRE_COLORS } from '@breadboard-studio/render';
import { CopyIcon, FitIcon, PasteIcon, RedoIcon, RotateIcon, UndoIcon } from './icons';
import { useTheme, type ThemePreference } from '../theme';

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
      onPointerDown={(e) => { if (e.button === 0) start(); }}
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
    </div>
  );
}

interface CanvasApi {
  fit: () => void;
  zoomBy: (f: number) => void;
  zoomTo: (z: number) => void;
  rotateBy: (deltaDeg: number) => void;
  rotateTo: (deg: number) => void;
  toggleSolderSide: () => void;
}

/** 主题三档：浅色 / 深色 / 跟随系统（issue #23）。偏好持久保存在 localStorage。 */
const THEME_OPTIONS: { value: ThemePreference; label: string; title: string }[] = [
  { value: 'light', label: '浅色', title: '浅色主题' },
  { value: 'dark', label: '深色', title: '深色主题' },
  { value: 'system', label: '系统', title: '跟随系统主题，系统切换时自动跟随' }
];

function ThemeSwitch() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div className="mode-switch theme-switch" role="group" aria-label="主题" data-testid="theme-switch" title={`当前主题：${resolved === 'dark' ? '深色' : '浅色'}`}>
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.value}
          className={preference === o.value ? 'active' : ''}
          aria-pressed={preference === o.value}
          onClick={() => setPreference(o.value)}
          title={o.title}
          data-testid={`theme-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function canvasApi(): CanvasApi | undefined {
  return (window as unknown as { __bbsCanvas?: CanvasApi }).__bbsCanvas;
}

/**
 * Outside-click + Esc dismissal for a toolbar popover. The Esc handler runs in
 * the capture phase so closing a popover does not also clear the canvas selection
 * (App's window-level handler never sees the event).
 */
function useDismissablePopover(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose]);
  return ref;
}

/**
 * 「视图」popover (issue #37). Everything that changes what the canvas *shows* —
 * and nothing that changes the design — lives here instead of sitting in the main
 * bar next to the editing actions. Stays open while you flip several switches.
 */
function ViewMenu({ open, onToggle, onClose }: { open: boolean; onToggle: () => void; onClose: () => void }) {
  const showHoleLabels = useStore((s) => s.showHoleLabels);
  const showPinLabels = useStore((s) => s.showPinLabels);
  const connectivityHighlight = useStore((s) => s.connectivityHighlight);
  const dimUnhighlighted = useStore((s) => s.dimUnhighlighted);
  const st = useStore.getState();
  const ref = useDismissablePopover(open, onClose);

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className={open ? 'active' : ''}
        onClick={onToggle}
        aria-haspopup="true"
        aria-expanded={open}
        title="视图：画布上显示哪些辅助信息（不改设计数据）"
        data-testid="view-menu"
      >
        视图 ▾
      </button>
      {open && (
        <div className="menu view-popover" role="group" aria-label="视图">
          <div className="menu-label">显示</div>
          <label className="view-row" title="在每个孔旁边标出孔号">
            <input type="checkbox" checked={showHoleLabels} onChange={st.toggleHoleLabels} data-testid="toggle-hole-labels" />孔号
          </label>
          <label className="view-row" title="在元件引脚旁标出引脚名">
            <input type="checkbox" checked={showPinLabels} onChange={st.togglePinLabels} data-testid="toggle-pin-labels" />针脚名
          </label>
          <label className="view-row" title="选中孔/元件时高亮同一导通组里的孔">
            <input type="checkbox" checked={connectivityHighlight} onChange={st.toggleConnectivityHighlight} data-testid="toggle-connectivity" />导通高亮
          </label>
          <label className="view-row" title="选中元件或孔时，把无关的导线压暗，只留下直连的那几根">
            <input type="checkbox" checked={dimUnhighlighted} onChange={st.toggleDimUnhighlighted} data-testid="toggle-dim" />聚焦选中
          </label>
          <div className="menu-sep" />
          <button className="view-row view-action" onClick={() => canvasApi()?.toggleSolderSide()} title="洞洞板翻到焊接面（只影响显示与命中，不写入设计数据）" data-testid="toggle-solder-side">
            翻转元件面 / 焊接面
          </button>
          <div className="menu-label">当前面显示在画布左下角</div>
        </div>
      )}
    </div>
  );
}

/**
 * 接线选项 popover. The 12-colour palette plus the routing select used to sit
 * inline and pushed the bar ~480px past a 1280 viewport in wire mode, so they
 * moved into a contextual popover: the option that belongs to the active tool,
 * one click away, with the current colour shown on the button itself.
 */
function WireOptionsMenu({ open, onToggle, onClose }: { open: boolean; onToggle: () => void; onClose: () => void }) {
  const wireColor = useStore((s) => s.wireColor);
  const wireRoute = useStore((s) => s.wireRoute);
  const st = useStore.getState();
  const ref = useDismissablePopover(open, onClose);
  const hex = wireColor.startsWith('#') ? wireColor : (WIRE_COLORS[wireColor] ?? '#2563eb');
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className={open ? 'active' : ''}
        onClick={onToggle}
        aria-haspopup="true"
        aria-expanded={open}
        title="接线选项：导线颜色与走线方式"
        data-testid="wire-options"
      >
        <span className="swatch" style={{ background: hex }} data-testid="wire-options-swatch" />
        接线选项 ▾
      </button>
      {open && (
        <div className="menu wire-options-popover" role="group" aria-label="接线选项">
          <div className="menu-label">导线颜色</div>
          <WireColorPicker value={wireColor} onChange={st.setWireColor} testId="wire-color" />
          <div className="menu-sep" />
          <div className="menu-label">走线方式</div>
          <select value={wireRoute} onChange={(e) => st.setWireRoute(e.target.value as 'flat' | 'elevated')} data-testid="wire-route">
            <option value="flat">硬质跳线（路径不重叠）</option>
            <option value="elevated">杜邦线（允许重叠/跨越）</option>
          </select>
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const design = useStore((s) => s.design);
  const tool = useStore((s) => s.tool);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const showHoleLabels = useStore((s) => s.showHoleLabels);
  // 针脚名 / 导通高亮 / 聚焦选中 由 ViewMenu 订阅，线色与走线方式由 WireOptionsMenu 订阅：
  // 它们都只在那一个 popover 里用到，工具栏本体不必跟着重渲染。
  const storage = useStore((s) => s.storage);
  const mode = useStore((s) => s.mode);
  const selectedCount = useStore((s) => s.selectedIds.length);
  const hasClipboard = useStore((s) => !!s.clipboard);
  const canRestore = useStore((s) => s.canRestorePrevious);
  const st = useStore.getState();
  const [menu, setMenu] = useState<null | 'project' | 'export' | 'view' | 'wire'>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onImportFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    st.importJson(text);
  };

  // Short label, full story in the tooltip: the bar is for glancing at, and the
  // old full timestamp ate ~120px of it (issue #37).
  const storageShort = storage.state === 'saved' ? '已本地保存' : storage.state === 'idle' ? '未保存' : '⚠ 未保存';
  const storageTitle =
    storage.state === 'saved'
      ? `已本地保存于 ${new Date(storage.at).toLocaleTimeString()}`
      : storage.state === 'idle'
        ? '尚未写入本地存储'
        : storage.message;

  return (
    <div className="toolbar" onMouseLeave={() => setMenu(null)}>
      {/* 左区 · 应用级：项目与导出。跟具体工具、模式无关。 */}
      <div className="zone zone-app">
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
      </div>
      <span className="sep" />
      {/* 中区 · 编辑上下文：唯一随模式变化的一段，位置不变，工具栏因此不跳动。
          仿真不渲染任何写设计的动作，所以这里没有需要事后拒绝的按钮。 */}
      <div className="zone zone-tools">
        {mode === 'build' ? (
          <>
            <div className="tool-group" role="group" aria-label="工具">
              <button className={tool === 'select' ? 'active' : ''} onClick={() => st.setTool('select')} title="选择/移动 (V)" data-testid="tool-select">选择</button>
              <button className={tool === 'wire' ? 'active' : ''} onClick={() => st.setTool('wire')} title="接线 (W)" data-testid="tool-wire">接线</button>
              <button className={tool === 'pan' ? 'active' : ''} onClick={() => st.setTool('pan')} title="平移 (H / 空格拖动)" data-testid="tool-pan">平移</button>
            </div>
            {tool === 'wire' && <WireOptionsMenu open={menu === 'wire'} onToggle={() => setMenu(menu === 'wire' ? null : 'wire')} onClose={() => setMenu((m) => (m === 'wire' ? null : m))} />}
            <span className="sep" />
            <button className="icon-btn" onClick={st.undo} disabled={!past} title="撤销 (⌘Z)" aria-label="撤销" data-testid="undo"><UndoIcon /></button>
            <button className="icon-btn" onClick={st.redo} disabled={!future} title="重做 (⇧⌘Z)" aria-label="重做" data-testid="redo"><RedoIcon /></button>
            <span className="sep" />
            <button className="icon-btn" onClick={st.copySelection} disabled={!selectedCount} title="复制选中的元件/面包板 (⌘C)" aria-label="复制" data-testid="copy"><CopyIcon /></button>
            <button className="icon-btn" onClick={() => st.pasteClipboard(null)} disabled={!hasClipboard} title="粘贴 (⌘V 粘到指针所在的孔位；按钮粘到原位右下方)" aria-label="粘贴" data-testid="paste"><PasteIcon /></button>
          </>
        ) : mode === 'sim' ? (
          <SimulatorToolbar />
        ) : (
          <span className="muted small" data-testid="hardware-hint">实机：连接一块真板看它的输出，画布只读</span>
        )}
      </div>
      <span className="spacer" />
      {/* 右区 · 视图与状态：模式无关，所以它在三种模式下都在同一个位置。 */}
      <div className="zone zone-view">
        <ViewMenu open={menu === 'view'} onToggle={() => setMenu(menu === 'view' ? null : 'view')} onClose={() => setMenu((m) => (m === 'view' ? null : m))} />
        <div className="zoom-cluster" role="group" aria-label="缩放">
          <ZoomButton label="－" factor={ZOOM_STEP_OUT} title="缩小（按住连续缩放）" testId="zoom-out" />
          <ZoomButton label="＋" factor={ZOOM_STEP_IN} title="放大（按住连续缩放）" testId="zoom-in" />
        </div>
        <button
          className="icon-btn"
          onClick={() => canvasApi()?.rotateBy(90)}
          onContextMenu={(e) => { e.preventDefault(); canvasApi()?.rotateBy(-90); }}
          title="视图旋转 90°（右键反向转；只影响显示，不改设计数据）"
          aria-label="旋转视图"
          data-testid="rotate-view"
        >
          <RotateIcon />
        </button>
        <button className="icon-btn" onClick={() => canvasApi()?.fit()} title="适应全部 (F)" aria-label="适应全部" data-testid="fit"><FitIcon /></button>
        <ModeSwitch mode={mode} />
        <ThemeSwitch />
        <span className={`storage ${storage.state}`} title={storageTitle} data-testid="storage-status">{storageShort}</span>
      </div>
    </div>
  );
}
