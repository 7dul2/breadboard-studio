import { useMemo, useState } from 'react';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { useStore, analysisOf } from '../store';

const CATEGORY_NAMES: Record<string, string> = { board: '面包板', mcu: '主控', display: '显示', sensor: '传感器', input: '输入', power: '电源', passive: '基础元件', connector: '连接器', other: '其他' };

export function Library() {
  const design = useStore((s) => s.design);
  const placing = useStore((s) => s.placing);
  const [filter, setFilter] = useState('');
  const st = useStore.getState();
  const catalog = builtinCatalog();
  const analysis = analysisOf(design);

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
      <input className="search" placeholder="搜索型号…" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="library-search" />
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
                    {ref}
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
