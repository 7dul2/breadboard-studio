import { buildSteps } from '@breadboard-studio/core';
import { WIRE_COLORS } from '@breadboard-studio/render';
import { analysisOf, useStore } from '../store';

export function BuildMode() {
  const design = useStore((s) => s.design);
  const step = useStore((s) => s.buildStep);
  const st = useStore.getState();
  const a = analysisOf(design);
  const done = design.view?.build_done ?? [];
  const steps = buildSteps(a.model, a.connectivity, done);
  const cur = steps[step];
  const doneCount = steps.filter((s) => s.complete).length;
  return (
    <div className="build" data-testid="build-panel">
      <div className="panel-title">搭建模式 <span className="muted">{doneCount}/{steps.length} 已完成</span></div>
      <p className="muted small">按线号逐根接线。这只是指导：勾选“完成”不代表实物已经导通，请用万用表确认。长度不含插入深度与弯折余量。</p>
      {cur ? (
        <div className={`step-card ${cur.complete ? 'done' : ''}`} data-testid="build-current">
          <div className="step-head">
            <span className="wire-no" style={{ borderColor: WIRE_COLORS[cur.color] ?? cur.color }}>{cur.index}</span>
            <b>{cur.name}</b>
            <span className="muted">{cur.color}{cur.route === 'elevated' ? ' · 杜邦线' : ' · 硬质跳线'}{cur.length_mm !== null ? ` · ~${cur.length_mm} mm` : ''}</span>
          </div>
          <div className="step-body">
            <div><span className="muted">从</span> <b>{cur.from}</b> <span className="muted">{cur.from_label}</span></div>
            <div><span className="muted">到</span> <b>{cur.to ?? '（草稿，无终点）'}</b> <span className="muted">{cur.to_label}</span></div>
            {cur.net && <div><span className="muted">网络</span> {cur.net}</div>}
          </div>
          <div className="row">
            <button onClick={() => st.setBuildStep(Math.max(0, step - 1))} disabled={step === 0} data-testid="build-prev">上一根</button>
            <button className="primary" onClick={() => { st.toggleBuildDone(cur.wire_id); if (step < steps.length - 1) st.setBuildStep(step + 1); }} data-testid="build-done">{cur.complete ? '取消完成' : '标记完成，下一根'}</button>
            <button onClick={() => st.setBuildStep(Math.min(steps.length - 1, step + 1))} disabled={step >= steps.length - 1} data-testid="build-next">下一根</button>
          </div>
        </div>
      ) : (
        <p className="muted">还没有导线。</p>
      )}
      <ol className="step-list">
        {steps.map((s, i) => (
          <li key={s.wire_id} className={`${i === step ? 'current' : ''} ${s.complete ? 'done' : ''}`} onClick={() => st.setBuildStep(i)}>
            <input type="checkbox" checked={s.complete} onChange={() => st.toggleBuildDone(s.wire_id)} onClick={(e) => e.stopPropagation()} />
            <span className="wire-no small" style={{ borderColor: WIRE_COLORS[s.color] ?? s.color }}>{s.index}</span>
            <span>{s.from} → {s.to ?? '?'}</span>
            <span className="muted">{s.color}</span>
          </li>
        ))}
      </ol>
      <button onClick={() => st.setBuildMode(false)}>退出搭建模式</button>
    </div>
  );
}
