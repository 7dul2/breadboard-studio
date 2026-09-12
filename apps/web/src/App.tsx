import { useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { Library } from './components/Library';
import { PlacedComponents } from './components/PlacedComponents';
import { Canvas } from './components/Canvas';
import { Properties } from './components/Properties';
import { Validation } from './components/Validation';
import { DslPanel } from './components/DslPanel';
import { WiringGuide } from './components/WiringGuide';
import { SimulatorPanel } from './simulator/ui/SimulatorPanel';
import { HardwarePanel } from './hardware/HardwarePanel';
import { CodeEditor } from './simulator/code/CodeEditor';
import { useStore } from './store';

/** Pointer position on the canvas in µm, so a paste lands where the user is looking. */
function canvasCursorUm(): [number, number] | null {
  return (window as unknown as { __bbsCanvas?: { cursorUm?: () => [number, number] | null } }).__bbsCanvas?.cursorUm?.() ?? null;
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} data-testid={`toast-${t.kind}`}>
          <div>{t.text}</div>
          {t.details?.length ? <ul>{t.details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const rightTab = useStore((s) => s.rightTab);
  const leftTab = useStore((s) => s.leftTab);
  const mode = useStore((s) => s.mode);
  const st = useStore.getState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = useStore.getState();
      // 仿真 offers no editing affordance, so the editing shortcuts do not fire there
      // either. Staying silent is the point: nothing was on screen to press, so a
      // refusal toast would be reporting a rule the user never bumped into.
      // Neither 仿真 nor 实机 offers an editing affordance, so the editing shortcuts
      // stay silent there too — nothing was on screen to press.
      if (s.mode !== 'build') {
        if (e.key === 'Escape') s.select([]);
        else if (!mod && (e.key === 'f' || e.key === 'F')) (window as unknown as { __bbsCanvas?: { fit: () => void } }).__bbsCanvas?.fit();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        s.duplicateSelection();
        return;
      }
      // Copying selected *text* is the browser's job — only take ⌘C/⌘X when the
      // page has no text selection, so log and diagnostic text stays copyable.
      const hasTextSelection = !!window.getSelection()?.toString();
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'c' && !hasTextSelection) {
        e.preventDefault();
        s.copySelection();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'x' && !hasTextSelection) {
        e.preventDefault();
        s.cutSelection();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        s.pasteClipboard(canvasCursorUm());
        return;
      }
      if (mod) return;
      switch (e.key) {
        case 'Escape':
          s.cancelInteraction();
          s.select([]);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          s.deleteSelection();
          break;
        case 'r':
        case 'R':
          if (s.placing) s.rotatePlacing();
          else s.rotateSelection();
          break;
        case 'v':
        case 'V':
          s.setTool('select');
          break;
        case 'w':
        case 'W':
          s.setTool('wire');
          break;
        case 'h':
        case 'H':
          s.setTool('pan');
          break;
        case 'l':
        case 'L':
          s.toggleLockSelection();
          break;
        case 'f':
        case 'F':
          (window as unknown as { __bbsCanvas?: { fit: () => void } }).__bbsCanvas?.fit();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        {/* Nothing can be placed while a design is frozen, so 仿真 gives the canvas the room instead. */}
        {mode === 'build' && (
          <aside className="left">
            <div className="tabs">
              <button className={leftTab === 'library' ? 'active' : ''} onClick={() => st.setLeftTab('library')} data-testid="tab-library">元件库</button>
              <button className={leftTab === 'selected' ? 'active' : ''} onClick={() => st.setLeftTab('selected')} data-testid="tab-selected">已选元件</button>
            </div>
            <div className="tab-body">
              {leftTab === 'library' && <Library />}
              {leftTab === 'selected' && <PlacedComponents />}
            </div>
          </aside>
        )}
        <section className="center">
          <Canvas />
          <CodeEditor />
          <Validation />
        </section>
        <aside className="right">
          {/* 属性 edits the document, so it is a 搭建 panel: 仿真 has one panel and needs no tabs. */}
          {mode === 'build' && (
            <div className="tabs">
              <button className={rightTab === 'properties' ? 'active' : ''} onClick={() => st.setRightTab('properties')} data-testid="tab-properties">属性</button>
              <button className={rightTab === 'dsl' ? 'active' : ''} onClick={() => st.setRightTab('dsl')} data-testid="tab-dsl">DSL</button>
              <button className={rightTab === 'wiring' ? 'active' : ''} onClick={() => st.setRightTab('wiring')} data-testid="tab-wiring">接线向导</button>
            </div>
          )}
          <div className="tab-body">
            {mode === 'sim' && <SimulatorPanel />}
            {mode === 'hardware' && <HardwarePanel />}
            {mode === 'build' && (
              <>
                {rightTab === 'properties' && <Properties />}
                {rightTab === 'dsl' && <DslPanel />}
                {rightTab === 'wiring' && <WiringGuide />}
              </>
            )}
          </div>
        </aside>
      </div>
      <Toasts />
    </div>
  );
}
