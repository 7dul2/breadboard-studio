import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from '../../store';
import { EDITOR_MIN_HEIGHT, isDraftDirty, useSimulatorStore } from '../simulatorStore';

/** Mirrors `.code-editor { max-height: calc(66% - 130px) }`: the validation panel keeps 34%, the canvas 120px + border. */
function maxDrawerHeight(columnHeight: number): number {
  return Math.max(EDITOR_MIN_HEIGHT, Math.floor(columnHeight * 0.66 - 130));
}

/**
 * Bottom drawer of the centre column (docs §11.2): a lightweight line-numbered
 * editor for Studio TypeScript. Saving goes through `update_program` so it is
 * undoable and exported with the project; drafts live in the simulator store.
 */
export function CodeEditor() {
  const editorOpen = useSimulatorStore((s) => s.editorOpen);
  const programId = useSimulatorStore((s) => s.editorProgramId);
  const draft = useSimulatorStore((s) => (s.editorProgramId ? s.drafts[s.editorProgramId] : undefined));
  const height = useSimulatorStore((s) => s.editorHeight);
  const design = useStore((s) => s.design);
  const program = programId ? design.programs?.find((p) => p.id === programId) : undefined;

  const textRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [dragging, setDragging] = useState<{ startY: number; startHeight: number } | null>(null);

  // Restore the caret after a programmatic edit (Tab) once React has re-rendered the textarea.
  useLayoutEffect(() => {
    if (pendingCaret === null || !textRef.current) return;
    textRef.current.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret]);

  useEffect(() => {
    if (editorOpen) textRef.current?.focus();
  }, [editorOpen, programId]);

  if (!editorOpen || !program || !programId) return null;

  const id = programId;
  const text = draft ?? program.source;
  const dirty = isDraftDirty(id);
  const sim = useSimulatorStore.getState();
  const lineCount = text.split('\n').length;

  const save = (): boolean => {
    if (!dirty) return true;
    const r = useStore.getState().apply([{ op: 'update_program', id, patch: { source: text } }], '保存程序');
    if (r.ok) sim.clearDraft(id);
    return r.ok;
  };
  const saveAndRun = () => {
    // Running is a 仿真 activity, so the drawer takes the app there with it: the
    // transport, the canvas overlay and the frozen design all arrive together
    // instead of a session starting behind the 搭建 toolbar.
    if (!save()) return;
    useStore.getState().setMode('sim');
    void useSimulatorStore.getState().run();
  };
  const close = () => sim.closeEditor();

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart, selectionEnd } = ta;
      sim.setDraft(id, text.slice(0, selectionStart) + '  ' + text.slice(selectionEnd));
      setPendingCaret(selectionStart + 2);
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      save();
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      saveAndRun();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging({ startY: e.clientY, startHeight: height });
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    // Never eat the whole centre column: leave room for the canvas and the validation panel.
    const column = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    sim.setEditorHeight(Math.min(maxDrawerHeight(column), dragging.startHeight + (dragging.startY - e.clientY)));
  };
  const onHandleUp = () => setDragging(null);

  return (
    <div className="code-editor" style={{ height }} data-testid="code-editor">
      <div className={`code-handle ${dragging ? 'dragging' : ''}`} onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} title="拖动调整高度" data-testid="code-handle" />
      <div className="code-head">
        <strong>{program.name}</strong>
        <span className="muted">目标 <code>{program.target_component_id}</code> · Studio TypeScript · <code>{program.entry ?? 'main.ts'}</code></span>
        <span className={`code-dirty ${dirty ? 'dirty' : ''}`} data-testid="code-dirty">{dirty ? '未保存' : '已保存'}</span>
        <span className="spacer" />
        <button className="small" onClick={save} disabled={!dirty} title="保存 (⌘/Ctrl+S)" data-testid="code-save">保存</button>
        <button className="small primary" onClick={saveAndRun} title="保存并运行 (⌘/Ctrl+Enter)" data-testid="code-run">保存并运行</button>
        <button className="small" onClick={close} title="关闭 (Esc)，草稿会保留" data-testid="code-close">关闭</button>
      </div>
      <div className="code-body">
        <pre className="code-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
        </pre>
        <textarea
          ref={textRef}
          className="code-text"
          value={text}
          onChange={(e) => sim.setDraft(id, e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          data-testid="code-text"
        />
      </div>
    </div>
  );
}
