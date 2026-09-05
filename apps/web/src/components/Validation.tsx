import { useState } from 'react';
import type { RuleResult } from '@breadboard-studio/core';
import { analysisOf, useStore } from '../store';

const SEV_LABEL: Record<RuleResult['severity'], string> = { error: '错误', warning: '警告', needs_review: '待审核', info: '信息' };

export function Validation() {
  const design = useStore((s) => s.design);
  const st = useStore.getState();
  const a = analysisOf(design);
  const [filter, setFilter] = useState<Record<RuleResult['severity'], boolean>>({ error: true, warning: true, needs_review: true, info: true });
  const [collapsed, setCollapsed] = useState(false);
  const s = a.summary;
  const list = a.results.filter((r) => filter[r.severity]);

  return (
    <div className={`validation ${collapsed ? 'collapsed' : ''}`} data-testid="validation">
      <div className="validation-head" onClick={() => setCollapsed(!collapsed)}>
        <span className="panel-title">校验</span>
        <span className="counts">
          <button className={`chip error ${filter.error ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setFilter({ ...filter, error: !filter.error }); }} data-testid="count-error">错误 {s.error}</button>
          <button className={`chip warning ${filter.warning ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setFilter({ ...filter, warning: !filter.warning }); }} data-testid="count-warning">警告 {s.warning}</button>
          <button className={`chip needs_review ${filter.needs_review ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setFilter({ ...filter, needs_review: !filter.needs_review }); }} data-testid="count-review">待审核 {s.needs_review}</button>
          <button className={`chip info ${filter.info ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setFilter({ ...filter, info: !filter.info }); }}>信息 {s.info}</button>
        </span>
        <span className="muted note">{s.error === 0 ? '没有错误。没有错误不等于已验证可安全上电：待审核项需人工核对。' : '存在错误：修复后警告会自动消失。'}</span>
        <span className="muted">{collapsed ? '展开 ▴' : '收起 ▾'}</span>
      </div>
      {!collapsed && (
        <ul className="results" data-testid="results">
          {list.length === 0 && <li className="muted">当前筛选下没有结果。</li>}
          {list.map((r, i) => (
            <li key={`${r.code}-${i}`} className={`result ${r.severity}`} onClick={() => st.setHighlight(r.endpoints ?? [], r.objects)} data-testid={`result-${r.code}`} title={r.suggestion}>
              <span className={`tag ${r.severity}`}>{SEV_LABEL[r.severity]}{r.blocking ? '·阻断' : ''}</span>
              <code className="code">{r.code}</code>
              <span className="msg">{r.message}</span>
              {r.endpoints?.length ? <span className="eps">{r.endpoints.join(' ')}</span> : null}
              {r.suggestion && <span className="sug">→ {r.suggestion}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
