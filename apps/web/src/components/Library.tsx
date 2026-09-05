import { useMemo, useRef, useState } from 'react';
import { useMemo as _useMemo } from 'react';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { catalogForDesign } from '@breadboard-studio/core';
import { useStore, analysisOf } from '../store';

const CATEGORY_NAMES: Record<string, string> = { board: '面包板', mcu: '主控', display: '显示', sensor: '传感器', input: '输入', power: '电源', passive: '基础元件', connector: '连接器', other: '其他' };

export function Library() {
  const design = useStore((s) => s.design);
  const placing = useStore((s) => s.placing);
  const [filter, setFilter] = useState('');
  const st = useStore.getState();
  const catalog = _useMemo(() => catalogForDesign(design, builtinCatalog()), [design]);
  const analysis = analysisOf(design);
  const fileRef = useRef<HTMLInputElement>(null);
  const embeddedRefs = new Set([...(design.embedded_catalog?.boards ?? []), ...(design.embedded_catalog?.components ?? [])].map((d) => `${d.id}@${d.version}`));
  const importDefinition = async (f: File | undefined) => {
    if (!f) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await f.text());
    } catch (e) {
      st.toast('error', `定义文件不是有效 JSON：${(e as Error).message}`);
      return;
    }
    const r = st.apply([{ op: 'add_definition', definition: raw }], '导入元件定义');
    if (r.ok) st.toast('success', `已导入定义并内嵌到当前设计：${(raw as { id?: string }).id ?? '?'}`);
  };

  const groups = useMemo(() => {
    const items = catalog.list().filter((d) => !filter || `${d.id} ${d.name} ${d.model ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
    const g = new Map<string, typeof items>();
    for (const d of items) {
      const cat = d.kind === 'board' ? 'board' : d.category;
      g.set(cat, [...(g.get(cat) ?? []), d]);
    }
    return [...g.entries()];
  }, [catalog, filter]);

  const addBoard = (model: string) => {
    const id = nextId('bb_');
    const first = design.boards[0];
    st.apply([{ op: 'add_board', board: { id, model, ...(first ? { attach_to: { board_id: design.boards[design.boards.length - 1]!.id, side: 'right', grid_align: true } } : { position_um: [0, 0] }) } }], '添加面包板');
    st.select([id]);
    if (!first) st.requestFit();
  };
  const nextId = (prefix: string) => {
    const used = new Set([...design.boards, ...design.components, ...design.wires].map((o) => o.id));
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };

  return (
    <div className="library">
      <div className="panel-title">元件库</div>
      <div className="row lib-actions">
        <input className="search" placeholder="搜索型号…" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="library-search" />
        <button title="导入自定义元件/面包板定义 JSON（内嵌到当前设计）" onClick={() => fileRef.current?.click()} data-testid="import-definition">导入定义</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden data-testid="definition-input" onChange={(e) => { void importDefinition(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {placing && (
        <div className="hint" data-testid="placing-hint">
          正在放置 <b>{catalog.getComponent(placing.model)?.name}</b>：在画布上点击落点（R 旋转，Esc 取消，Shift+点击连续放置）。
        </div>
      )}
      <div className="library-list">
        {groups.map(([cat, items]) => (
          <div key={cat} className="lib-group">
            <div className="lib-cat">{CATEGORY_NAMES[cat] ?? cat}</div>
            {items.map((d) => {
              const ref = `${d.id}@${d.version}`;
              const unverified = d.geometry_status !== 'verified' || d.electrical_status !== 'verified';
              return (
                <button
                  key={ref}
                  className={`lib-item ${placing?.model === ref ? 'active' : ''}`}
                  data-testid={`lib-${d.id}`}
                  title={d.description ?? d.name}
                  onClick={() => (d.kind === 'board' ? addBoard(ref) : st.startPlacing(ref))}
                >
                  <span className="lib-name">{d.name}</span>
                  <span className="lib-meta">
                    {ref}{embeddedRefs.has(ref) ? ' · 内嵌' : ''}
                    {d.kind === 'component' && d.mount === 'off_board' ? ' · 板外/线缆' : ''}
                    {unverified ? ` · ⚠ 几何${status(d.geometry_status)}/电气${status(d.electrical_status)}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="panel-footer muted">
        已放置：面包板 {analysis.model.boards.size}，元件 {analysis.model.components.size}，导线 {analysis.model.wires.size}
      </div>
    </div>
  );
}

function status(s: string): string {
  return s === 'verified' ? '已核' : s === 'approximate' ? '近似' : '未知';
}
