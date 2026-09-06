import { useEffect, useMemo, useRef, useState } from 'react';
import { builtinCatalog, type Catalog } from '@breadboard-studio/catalog';
import type { CatalogDefinition } from '@breadboard-studio/schema';
import { applyOps, buildModel, catalogForDesign, createEmptyDesign, resolveComponent } from '@breadboard-studio/core';
import { boardScene, componentScene, mm, type SceneNode } from '@breadboard-studio/render';
import { useStore, analysisOf } from '../store';
import { SceneNodes } from './SceneView';

const CATEGORY_NAMES: Record<string, string> = { board_integrated: '面包板 · 一体式', board_modular: '面包板 · 可拆拼装式', mcu: '主控', display: '显示', sensor: '传感器', input: '输入', power: '电源', passive: '基础元件', connector: '连接器', other: '其他' };
const VISIBLE_BUILTIN_IDS = new Set(['breadboard_400', 'breadboard_400_terminal', 'breadboard_power_strip_25', 'breadboard_830', 'esp32s3_n16r8_dual_usb', 'oled_0_96_ssd1315_i2c']);

export function Library() {
  const design = useStore((s) => s.design);
  const placing = useStore((s) => s.placing);
  const [filter, setFilter] = useState('');
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const st = useStore.getState();
  const catalog = useMemo(() => catalogForDesign(design, builtinCatalog()), [design]);
  const analysis = analysisOf(design);
  const fileRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | null>(null);
  const suppressHoverUntil = useRef(0);
  const embeddedRefs = useMemo(() => new Set([...(design.embedded_catalog?.boards ?? []), ...(design.embedded_catalog?.components ?? [])].map((d) => `${d.id}@${d.version}`)), [design.embedded_catalog]);
  const detail = detailRef ? catalog.get(detailRef) : undefined;
  useEffect(() => {
    if (!detailRef) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailRef(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [detailRef]);
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
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
    const items = catalog.list().filter((d) => {
      const ref = `${d.id}@${d.version}`;
      const isVisible = VISIBLE_BUILTIN_IDS.has(d.id) || embeddedRefs.has(ref);
      return isVisible && (!filter || `${d.id} ${d.name} ${d.model ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
    });
    const g = new Map<string, typeof items>();
    for (const d of items) {
      const cat = d.kind === 'board'
        ? (d.id === 'breadboard_400_terminal' || d.id === 'breadboard_power_strip_25' ? 'board_modular' : 'board_integrated')
        : d.category;
      g.set(cat, [...(g.get(cat) ?? []), d]);
    }
    return [...g.entries()];
  }, [catalog, embeddedRefs, filter]);

  const addBoard = (model: string) => {
    const id = nextId('bb_');
    const first = design.boards[0];
    st.apply([{ op: 'add_board', board: { id, model, ...(first ? { attach_to: { board_id: design.boards[design.boards.length - 1]!.id, side: 'right', grid_align: true } } : { position_um: [0, 0] }) } }], '添加面包板');
    st.select([id]);
    if (!first) st.requestFit();
  };
  const openDetail = (ref: string) => {
    if (performance.now() < suppressHoverUntil.current) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setDetailRef(ref);
  };
  const keepDetailOpen = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  };
  const closeDetailSoon = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setDetailRef(null), 180);
  };
  const chooseModel = (def: CatalogDefinition) => {
    suppressHoverUntil.current = performance.now() + 300;
    const ref = `${def.id}@${def.version}`;
    if (def.kind === 'board') addBoard(ref);
    else st.startPlacing(ref);
    setDetailRef(null);
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
              return (
                <button
                  key={ref}
                  className={`lib-item ${placing?.model === ref || detailRef === ref ? 'active' : ''}`}
                  data-testid={`lib-${d.id}`}
                  title={d.description ?? d.name}
                  onMouseEnter={() => openDetail(ref)}
                  onMouseLeave={closeDetailSoon}
                  onFocus={() => openDetail(ref)}
                  onBlur={closeDetailSoon}
                  onClick={() => chooseModel(d)}
                >
                  <span className="lib-name">{d.name}</span>
                  <span className="lib-meta">
                    {ref}{embeddedRefs.has(ref) ? ' · 内嵌' : ''}
                    {d.kind === 'component' && d.mount === 'off_board' ? ' · 板外/线缆' : ''}
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
      {detail && (
        <ModelDetailCard
          def={detail}
          catalog={catalog}
          onClose={() => setDetailRef(null)}
          onAdd={() => chooseModel(detail)}
          onMouseEnter={keepDetailOpen}
          onMouseLeave={closeDetailSoon}
        />
      )}
    </div>
  );
}

function ModelDetailCard({ def, catalog, onClose, onAdd, onMouseEnter, onMouseLeave }: { def: CatalogDefinition; catalog: Catalog; onClose: () => void; onAdd: () => void; onMouseEnter: () => void; onMouseLeave: () => void }) {
  const preview = useMemo(() => modelPreview(def, catalog), [def, catalog]);
  const ref = `${def.id}@${def.version}`;
  const size = def.kind === 'board' ? def.size_um : resolveComponent(def).body.size_um;
  const count = def.kind === 'board'
    ? def.terminal_blocks.reduce((sum, block) => sum + block.rows.length * block.columns, 0) + def.rails.reduce((sum, rail) => sum + rail.holes, 0)
    : resolveComponent(def).pins.length;
  const voltage = def.kind === 'component' ? def.electrical.supply_voltage_v : null;
  const category = def.kind === 'board' ? '面包板' : CATEGORY_NAMES[def.category] ?? def.category;

  return (
    <div className="model-detail-layer" onPointerDown={onClose} data-testid="model-detail-layer">
      <article className="model-detail-card" role="dialog" aria-modal="false" aria-labelledby="model-detail-title" onPointerDown={(event) => event.stopPropagation()} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} data-testid="model-detail-card">
        <button className="model-detail-close" onClick={onClose} aria-label="关闭模型详情" title="关闭">×</button>
        <div className="model-preview" aria-label={`${def.name} 模型预览`}>
          {preview ? (
            <svg viewBox={preview.viewBox} role="img" aria-label={`${def.name} 矢量模型`} preserveAspectRatio="xMidYMid meet">
              <SceneNodes nodes={preview.nodes} />
            </svg>
          ) : <span className="muted">暂时无法生成预览</span>}
        </div>
        <div className="model-detail-body">
          <span className="model-kind">{category}</span>
          <h2 id="model-detail-title">{def.name}</h2>
          <code>{ref}</code>
          {def.description && <p>{def.description}</p>}
          <dl className="model-facts">
            <div><dt>模型</dt><dd>{def.model ?? def.id}</dd></div>
            <div><dt>尺寸</dt><dd>{mm(size[0])} × {mm(size[1])} mm</dd></div>
            <div><dt>{def.kind === 'board' ? '孔位' : '引脚'}</dt><dd>{count}</dd></div>
            {def.kind === 'component' && <div><dt>安装</dt><dd>{def.mount === 'breadboard' ? '面包板插装' : '板外接线'}</dd></div>}
            {voltage && <div><dt>工作电压</dt><dd>{voltage.min === voltage.max ? `${voltage.min} V` : `${voltage.min}–${voltage.max} V`}</dd></div>}
            {def.variant && <div><dt>版本</dt><dd>{def.variant}</dd></div>}
          </dl>
        </div>
        <div className="model-detail-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={onAdd} data-testid="model-detail-add">{def.kind === 'board' ? '添加面包板' : '添加到画布'}</button>
        </div>
      </article>
    </div>
  );
}

function modelPreview(def: CatalogDefinition, catalog: Catalog): { nodes: SceneNode[]; viewBox: string } | null {
  const ref = `${def.id}@${def.version}`;
  const id = '__preview__';
  const empty = createEmptyDesign('模型预览');
  const op = def.kind === 'board'
    ? { op: 'add_board' as const, board: { id, model: ref, position_um: [0, 0] as [number, number], rotation_deg: 0 as const } }
    : { op: 'add_component' as const, component: { id, model: ref, name: def.name, placement: { kind: 'off_board' as const, position_um: [0, 0] as [number, number], rotation_deg: def.preferred_rotation_deg ?? 0 } } };
  const result = applyOps(empty, [op], { catalog, allow_blocking: true });
  if (!result.ok) return null;
  const model = buildModel(result.design, catalog);
  const placed = def.kind === 'board' ? model.boards.get(id) : model.components.get(id);
  if (!placed) return null;
  const bounds = placed.bounds;
  const padding = def.kind === 'board' ? 3 : 7;
  const node = def.kind === 'board'
    ? boardScene(placed as NonNullable<ReturnType<typeof model.boards.get>>, model, { showHoleLabels: false, showUnverifiedBadges: false })
    : componentScene(placed as NonNullable<ReturnType<typeof model.components.get>>, { showPinLabels: false, showUnverifiedBadges: false });
  return {
    nodes: [node],
    viewBox: `${mm(bounds.x) - padding} ${mm(bounds.y) - padding} ${mm(bounds.w) + padding * 2} ${mm(bounds.h) + padding * 2}`
  };
}
