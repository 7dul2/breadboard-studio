import { useEffect, useMemo, useRef, useState } from 'react';
import { builtinCatalog, type Catalog } from '@breadboard-studio/catalog';
import type { CatalogDefinition } from '@breadboard-studio/schema';
import { applyOps, buildModel, catalogForDesign, createEmptyDesign, resolveComponent } from '@breadboard-studio/core';
import { boardScene, componentScene, mm, type SceneNode } from '@breadboard-studio/render';
import { useStore, analysisOf } from '../store';
import { spliceOps, spliceSummary, type SpliceSpec } from '../splice-board';
import { SpliceBoardDialog } from './SpliceBoardDialog';
import { SceneNodes } from './SceneView';

const CATEGORY_NAMES: Record<string, string> = { board_integrated: '面包板 · 一体式', board_modular: '面包板 · 可拆拼装式', mcu: '主控', display: '显示', sensor: '传感器', input: '输入', power: '电源', passive: '基础元件', connector: '连接器', other: '其他' };
const VISIBLE_BUILTIN_IDS = new Set([
  'breadboard_400',
  'breadboard_400_terminal',
  'breadboard_power_strip_25',
  'breadboard_830',
  'esp32s3_n16r8_dual_usb',
  'oled_0_96_ssd1315_i2c',
  'tft_1_77_st7735_spi',
  'encoder_ky040',
  'tactile_6x6'
]);

export function Library() {
  const design = useStore((s) => s.design);
  const placing = useStore((s) => s.placing);
  const [filter, setFilter] = useState('');
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const [spliceOpen, setSpliceOpen] = useState(false);
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
  /**
   * 删掉设计里的内嵌定义。核心的 `remove_definition` 会拒绝删仍在用的，
   * 所以按钮本身也按"有没有人在用"禁用，并把原因写在 title 里。
   */
  const removeDefinition = (ref: string, users: string[]) => {
    if (users.length) {
      st.toast('error', `${ref} 仍被 ${users.join('、')} 用着，先删掉它们`);
      return;
    }
    const r = st.apply([{ op: 'remove_definition', ref }], '删除内嵌定义');
    if (r.ok) {
      setDetailRef(null);
      st.toast('success', `已从设计中删除 ${ref}`);
    }
  };
  const openDetail = (ref: string) => {    if (performance.now() < suppressHoverUntil.current) return;
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
  /**
   * 拼装面包板：全是目录里的标准件，只是按 attach_to 连起来。
   * 同一批里要自己发号，nextId 只看设计、批内会重号。
   */
  const createSpliceBoard = (spec: SpliceSpec) => {
    const used = new Set([...design.boards, ...design.components, ...design.wires].map((o) => o.id));
    const allocId = () => {
      let n = 1;
      while (used.has(`bb_${n}`)) n++;
      const id = `bb_${n}`;
      used.add(id);
      return id;
    };
    const last = design.boards[design.boards.length - 1];
    const { ops, ids } = spliceOps(spec, allocId, last ? { attach_to: { board_id: last.id, side: 'right' } } : { position_um: [0, 0] });
    const r = st.apply(ops, '拼装面包板');
    setSpliceOpen(false);
    if (r.ok) {
      st.select(ids, true);
      st.requestFit();
      const sum = spliceSummary(spec);
      st.toast('success', `已拼出 ${sum.modules} 块中间接线板${sum.strips ? ` + ${sum.strips} 条电源条` : ''}（横向 ${spec.across} × 纵向 ${spec.down}）`);
    }
  };

  return (
    <div className="library">
      <div className="panel-title">元件库</div>
      <div className="row lib-actions">
        <input className="search" placeholder="搜索型号…" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="library-search" />
        <button title="导入自定义元件/面包板定义 JSON（内嵌到当前设计）" onClick={() => fileRef.current?.click()} data-testid="import-definition">导入定义</button>
        <button title="用可拼接的中间接线板 + 电源条自动拼出一块大板" onClick={() => setSpliceOpen(true)} data-testid="splice-board-open">拼装面包板…</button>
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
              const embedded = embeddedRefs.has(ref);
              const users = [...design.boards, ...design.components].filter((o) => o.model === ref).map((o) => o.id);
              return (
                <div key={ref} className={`lib-item ${placing?.model === ref || detailRef === ref ? 'active' : ''}`}>
                  <button
                    className="lib-pick"
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
                      {ref}{embedded ? ' · 内嵌' : ''}
                      {d.kind === 'component' && d.mount === 'off_board' ? ' · 板外/线缆' : ''}
                      {users.length ? ` · 用中 ${users.length}` : ''}
                    </span>
                  </button>
                  {embedded && (
                    <button
                      className="lib-del"
                      data-testid={`lib-del-${d.id}`}
                      disabled={users.length > 0}
                      title={users.length ? `仍被 ${users.join('、')} 用着，先把它们删掉` : `从设计里删掉这份内嵌定义（不影响内置元件库）`}
                      onClick={() => removeDefinition(ref, users)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="panel-footer muted">
        已放置：面包板 {analysis.model.boards.size}，元件 {analysis.model.components.size}，导线 {analysis.model.wires.size}
      </div>
      {spliceOpen && <SpliceBoardDialog onClose={() => setSpliceOpen(false)} onCreate={createSpliceBoard} />}
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
