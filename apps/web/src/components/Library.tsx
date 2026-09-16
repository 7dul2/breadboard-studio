import { useEffect, useMemo, useRef, useState } from 'react';
import { builtinCatalog, type Catalog } from '@breadboard-studio/catalog';
import type { CatalogDefinition } from '@breadboard-studio/schema';
import { applyOps, boardShape, buildModel, canResizeBoard, catalogForDesign, clampResizePlan, createEmptyDesign, resizeBoardDefinition, resolveComponent, RESIZE_LIMITS, type Op } from '@breadboard-studio/core';
import { boardScene, componentScene, mm, modelStatusText, primitiveToNode, type SceneNode } from '@breadboard-studio/render';
import { useStore, analysisOf } from '../store';
import { buildLibraryGroups, CATEGORY_LABELS, foldedBuiltinCount, MORE_LABEL, modelRef } from '../library-groups';
import { spliceOps, spliceSummary, type SpliceSpec } from '../splice-board';
import { SpliceBoardDialog } from './SpliceBoardDialog';
import { SceneNodes } from './SceneView';

/** Plain-language meaning of the two evidence statuses, for the card tooltip. */
const STATUS_WORDS: Record<string, string> = {
  verified: '有证据且已复核',
  approximate: '来自资料，未实测',
  unknown: '未知占位，使用前必须核实'
};

export function Library() {
  const design = useStore((s) => s.design);
  const placing = useStore((s) => s.placing);
  const expandedGroups = useStore((s) => s.libraryExpandedGroups);
  const toggleLibraryGroup = useStore((s) => s.toggleLibraryGroup);
  const [filter, setFilter] = useState('');
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const [spliceOpen, setSpliceOpen] = useState(false);
  const st = useStore.getState();
  const catalog = useMemo(() => catalogForDesign(design, builtinCatalog()), [design]);
  const analysis = analysisOf(design);
  const fileRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | null>(null);
  const suppressHoverUntil = useRef(0);
  const embeddedRefs = useMemo(() => new Set([...(design.embedded_catalog?.boards ?? []), ...(design.embedded_catalog?.components ?? [])].map((d) => modelRef(d))), [design.embedded_catalog]);
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

  // Data-driven grouping (issue #32): `featured` decides the default view, the
  // rest is folded per category, and search always covers the whole catalog.
  const groups = useMemo(
    () => buildLibraryGroups(catalog.list(), { filter, embeddedRefs, expanded: new Set(expandedGroups) }),
    [catalog, embeddedRefs, expandedGroups, filter]
  );
  const searching = filter.trim().length > 0;
  // Search-scope numbers are about the catalog, not about the current hits, so
  // they stay steady while the user types.
  const builtinCount = useMemo(() => catalog.list().filter((d) => !embeddedRefs.has(modelRef(d))).length, [catalog, embeddedRefs]);
  const foldedCount = useMemo(() => foldedBuiltinCount(catalog.list(), embeddedRefs), [catalog, embeddedRefs]);
  const embeddedCount = catalog.list().length - builtinCount;

  const addBoard = (model: string, plan?: { columns: number; rows: number }) => {
    const id = nextId('bb_');
    const first = design.boards[0];
    const last = design.boards.at(-1);
    const isPerfboard = catalog.getBoard(model)?.render.style === 'perfboard';
    const canAttachToLast = Boolean(last && catalog.getBoard(last.model)?.render.style !== 'perfboard');
    const placement = last && canAttachToLast && !isPerfboard
      ? { attach_to: { board_id: last.id, side: 'right' as const, grid_align: true } }
      : first ? {} : { position_um: [0, 0] as [number, number] };
    // 自定义尺寸 = 添加原型号 + resize_board，一次 apply = 一次撤销。
    const ops: Op[] = plan
      ? [{ op: 'add_board', board: { id, model, ...placement } }, { op: 'resize_board', id, columns: plan.columns, rows: plan.rows }]
      : [{ op: 'add_board', board: { id, model, ...placement } }];
    const r = st.apply(ops, plan ? `添加面包板（自定义 ${plan.columns} 列 × ${plan.rows} 行）` : '添加面包板');
    if (r.ok) {
      st.select([id]);
      if (!first) st.requestFit();
    }
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
  const chooseModel = (def: CatalogDefinition, plan?: { columns: number; rows: number }) => {
    suppressHoverUntil.current = performance.now() + 300;
    const ref = `${def.id}@${def.version}`;
    if (def.kind === 'board') addBoard(ref, plan);
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

  /** One library card. Folded items reuse it verbatim, so adding one works the same. */
  const renderCard = (d: CatalogDefinition) => {
    const ref = modelRef(d);
    const embedded = embeddedRefs.has(ref);
    const users = [...design.boards, ...design.components].filter((o) => o.model === ref).map((o) => o.id);
    const status = modelStatusText(d.geometry_status, d.electrical_status);
    // The badge text is the short form the canvas uses; the tooltip spells out each
    // facet, so a `verified` geometry is never described as "未经实测".
    const statusTitle = `几何数据：${STATUS_WORDS[d.geometry_status]}；电气数据：${STATUS_WORDS[d.electrical_status]}`;
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
        {status && (
          <span className="lib-status" data-testid={`lib-status-${d.id}`} title={statusTitle}>
            {status}
          </span>
        )}
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
        {searching && (
          <div className="lib-search-note muted" data-testid="library-search-note">
            在全部 {builtinCount} 个内置型号里搜索{foldedCount ? `（含默认折叠的 ${foldedCount} 个）` : ''}{embeddedCount ? `，另加 ${embeddedCount} 份内嵌/覆盖定义` : ''}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key} className="lib-group">
            <div className="lib-cat">{CATEGORY_LABELS[group.key] ?? group.key}</div>
            {group.items.map(renderCard)}
            {group.foldedTotal > 0 && (
              <>
                <button
                  className="lib-more"
                  data-testid={`lib-more-${group.key}`}
                  aria-expanded={expandedGroups.includes(group.key)}
                  title={expandedGroups.includes(group.key) ? '收起这些内置型号' : '展开这个类目里默认折叠的内置型号'}
                  onClick={() => toggleLibraryGroup(group.key)}
                >
                  {expandedGroups.includes(group.key) ? '▾' : '▸'} {MORE_LABEL}（{group.foldedTotal}）
                </button>
                {group.folded.map(renderCard)}
              </>
            )}
          </div>
        ))}
        {groups.length === 0 && <div className="hint" data-testid="library-empty">没有匹配“{filter.trim()}”的型号</div>}
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
          onAdd={(plan) => chooseModel(detail, plan)}
          onMouseEnter={keepDetailOpen}
          onMouseLeave={closeDetailSoon}
        />
      )}
    </div>
  );
}

function ModelDetailCard({ def, catalog, onClose, onAdd, onMouseEnter, onMouseLeave }: { def: CatalogDefinition; catalog: Catalog; onClose: () => void; onAdd: (plan?: { columns: number; rows: number }) => void; onMouseEnter: () => void; onMouseLeave: () => void }) {
  const preview = useMemo(() => modelPreview(def, catalog), [def, catalog]);
  const ref = `${def.id}@${def.version}`;
  const size = def.kind === 'board' ? def.size_um : resolveComponent(def).body.size_um;
  const count = def.kind === 'board'
    ? def.terminal_blocks.reduce((sum, block) => sum + block.rows.length * block.columns, 0) + def.rails.reduce((sum, rail) => sum + rail.holes, 0)
    : resolveComponent(def).pins.length;
  const voltage = def.kind === 'component' ? def.electrical.supply_voltage_v : null;
  const category = def.kind === 'board' ? (def.render.style === 'perfboard' ? '洞洞板' : '面包板') : CATEGORY_LABELS[def.category] ?? def.category;
  const hasBack = Boolean(preview?.back);
  // 尺寸自定义（issue #22）：创建前先按行列数缩放。默认就是原型号的形状，
  // 数值没动过 = 按原尺寸添加。
  const shape = def.kind === 'board' ? boardShape(def) : null;
  const resizable = def.kind === 'board' && canResizeBoard(def) && shape !== null;
  const [columns, setColumns] = useState(shape?.columns ?? 0);
  const [rows, setRows] = useState(shape?.rows ?? 0);
  useEffect(() => {
    setColumns(shape?.columns ?? 0);
    setRows(shape?.rows ?? 0);
  }, [ref]); // eslint-disable-line react-hooks/exhaustive-deps
  const planChanged = resizable && shape !== null && (columns !== shape.columns || rows !== shape.rows);
  const plan = planChanged ? clampResizePlan({ columns, rows }, shape!) : undefined;
  const planDef = useMemo(() => {
    if (!plan || def.kind !== 'board') return null;
    try {
      return resizeBoardDefinition(def, plan, `${def.id}_custom`);
    } catch {
      return null;
    }
  }, [def, plan?.columns, plan?.rows]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="model-detail-layer" onPointerDown={onClose} data-testid="model-detail-layer">
      <article className={`model-detail-card${hasBack ? ' has-back' : ''}`} role="dialog" aria-modal="false" aria-labelledby="model-detail-title" onPointerDown={(event) => event.stopPropagation()} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} data-testid="model-detail-card">
        <button className="model-detail-close" onClick={onClose} aria-label="关闭模型详情" title="关闭">×</button>
        <div className={`model-preview${hasBack ? ' two-sided' : ''}`} aria-label={`${def.name} 模型预览`}>
          {preview ? (
            <>
              <div className="model-preview-face" data-testid="model-preview-front">
                {hasBack && <span className="model-preview-label">正面</span>}
                <svg viewBox={preview.front.viewBox} role="img" aria-label={`${def.name} 正面矢量模型`} preserveAspectRatio="xMidYMid meet">
                  <SceneNodes nodes={preview.front.nodes} />
                </svg>
              </div>
              {preview.back && (
                <div className="model-preview-face" data-testid="model-preview-back">
                  <span className="model-preview-label">反面</span>
                  <svg viewBox={preview.back.viewBox} role="img" aria-label={`${def.name} 反面矢量模型`} preserveAspectRatio="xMidYMid meet">
                    <SceneNodes nodes={preview.back.nodes} />
                  </svg>
                </div>
              )}
            </>
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
        {resizable && (
          <details className="board-size-editor" data-testid="model-size-editor" open>
            <summary>自定义尺寸（列 × 行）</summary>
            <div className="board-form">
              <label className="field">
                <span>列数（{RESIZE_LIMITS.columns.min}–{RESIZE_LIMITS.columns.max}）</span>
                <input type="number" min={RESIZE_LIMITS.columns.min} max={RESIZE_LIMITS.columns.max} value={columns} data-testid="model-size-columns" onChange={(e) => setColumns(Number(e.target.value) || RESIZE_LIMITS.columns.min)} />
              </label>
              <label className="field">
                <span>行数（{def.kind === 'board' && def.render.style === 'perfboard' ? '整板' : '每块'}，1–{shape!.rows}）</span>
                <input type="number" min={1} max={shape!.rows} value={rows} data-testid="model-size-rows" onChange={(e) => setRows(Number(e.target.value) || 1)} />
              </label>
            </div>
            <p className="muted" style={{ fontSize: 11 }}>
              {planDef
                ? <>按孔距缩放：外形 {mm(planDef.size_um[0])} × {mm(planDef.size_um[1])} mm，电源轨 {planDef.rails[0]?.holes ?? 0} 孔，孔距保持 2.54 mm。行数是<b>{def.render.style === 'perfboard' ? '整板物理行' : '每块接线块'}</b>的行数。</>
                : <>尺寸无效：列数 {RESIZE_LIMITS.columns.min}–{RESIZE_LIMITS.columns.max}，行数 1–{shape!.rows}。</>}
            </p>
          </details>
        )}
        <div className="model-detail-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onAdd(plan)} data-testid="model-detail-add" disabled={resizable && !planDef}>
            {planChanged ? `添加面包板（${plan!.columns} 列 × ${plan!.rows} 行）` : def.kind === 'board' ? '添加面包板' : '添加到画布'}
          </button>
        </div>
      </article>
    </div>
  );
}

interface PreviewFace {
  nodes: SceneNode[];
  viewBox: string;
}

function modelPreview(def: CatalogDefinition, catalog: Catalog): { front: PreviewFace; back?: PreviewFace } | null {
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
  const front = {
    nodes: [node],
    viewBox: `${mm(bounds.x) - padding} ${mm(bounds.y) - padding} ${mm(bounds.w) + padding * 2} ${mm(bounds.h) + padding * 2}`
  };
  if (def.kind !== 'component' || !def.back_render?.length) return { front };
  const body = resolveComponent(def).body.size_um;
  return {
    front,
    back: {
      nodes: [{ t: 'group', id: `component:${id}:back`, cls: 'component component-back', children: def.back_render.map(primitiveToNode) }],
      viewBox: `${-padding} ${-padding} ${mm(body[0]) + padding * 2} ${mm(body[1]) + padding * 2}`
    }
  };
}
