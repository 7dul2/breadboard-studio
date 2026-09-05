import { useStore } from '../store';

export function DslPanel() {
  const dslText = useStore((s) => s.dslText);
  const dirty = useStore((s) => s.dslDirty);
  const errors = useStore((s) => s.dslErrors);
  const revision = useStore((s) => s.design.metadata.revision);
  const st = useStore.getState();
  return (
    <div className="dsl" data-testid="dsl-panel">
      <div className="panel-title">
        设计文档（DSL）
        <span className={`muted ${dirty ? 'dirty' : ''}`}> {dirty ? '草稿已修改，尚未应用' : `与画布同步 · revision ${revision}`}</span>
      </div>
      <p className="muted small">
        声明式 JSON（schema 1.0）。编辑草稿后点“校验”或“应用”。非法草稿不会改变画布；画布修改在草稿未改动时会同步到这里。
      </p>
      <textarea className="dsl-text" value={dslText} onChange={(e) => st.setDslText(e.target.value)} spellCheck={false} data-testid="dsl-text" />
      <div className="row">
        <button onClick={() => { const ok = st.validateDsl(); st.toast(ok ? 'success' : 'error', ok ? 'DSL 草稿通过 schema 与结构校验' : 'DSL 草稿存在问题，见下方'); }} data-testid="dsl-validate">校验</button>
        <button className="primary" onClick={st.applyDsl} disabled={!dirty} data-testid="dsl-apply">应用到画布</button>
        <button onClick={st.reloadDsl} disabled={!dirty} data-testid="dsl-reload">放弃草稿，重载画布</button>
        <button onClick={() => { void navigator.clipboard?.writeText(dslText); st.toast('info', '已复制到剪贴板'); }}>复制</button>
      </div>
      {errors.length > 0 && (
        <ul className="dsl-errors" data-testid="dsl-errors">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}
