import { useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { Library } from './components/Library';
import { Canvas } from './components/Canvas';
import { Properties } from './components/Properties';
import { Validation } from './components/Validation';
import { DslPanel } from './components/DslPanel';
import { BuildMode } from './components/BuildMode';
import { useStore } from './store';

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
  const buildMode = useStore((s) => s.buildMode);
  const st = useStore.getState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = useStore.getState();
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
        <aside className="left">
          <Library />
        </aside>
        <section className="center">
          <Canvas />
          <Validation />
        </section>
        <aside className="right">
          <div className="tabs">
            <button className={rightTab === 'properties' ? 'active' : ''} onClick={() => st.setRightTab('properties')} data-testid="tab-properties">属性</button>
            <button className={rightTab === 'dsl' ? 'active' : ''} onClick={() => st.setRightTab('dsl')} data-testid="tab-dsl">DSL</button>
            <button className={rightTab === 'build' ? 'active' : ''} onClick={() => { st.setRightTab('build'); if (!buildMode) st.setBuildMode(true); }} data-testid="tab-build">搭建</button>
          </div>
          <div className="tab-body">
            {rightTab === 'properties' && <Properties />}
            {rightTab === 'dsl' && <DslPanel />}
            {rightTab === 'build' && <BuildMode />}
          </div>
        </aside>
      </div>
      <Toasts />
    </div>
  );
}
