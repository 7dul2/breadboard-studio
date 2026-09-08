import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentDefinition, RenderPrimitiveDef } from '@breadboard-studio/schema';
import { catalogForDesign, resolveComponent } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { validateComponentDefinition } from '@breadboard-studio/schema';
import { duplicateGroup, groupPrimitives, movePrimitive, nextTag, primitiveToNode, rotatePrimitive, tagGroups, type ArtBounds } from '@breadboard-studio/render';
import { flushSave, useStore } from '../store';
import { renderNode } from './SceneView';

/**
 * Write-back to the catalog source file, served by the dev plugin in
 * `apps/web/vite.config.ts`. It only exists while `vite serve` runs — the built
 * site has no filesystem behind it, so the button is not rendered there.
 */
const CAN_WRITE_LIBRARY = import.meta.env.DEV;
const WRITEBACK_URL = `${import.meta.env.BASE_URL}__bbs/definition`;

/**
 * Artwork editor: move / copy / delete / rotate the parts of a component's
 * drawing on top of its own SVG, optionally over a photo of the real board.
 * Saving embeds the edited definition in the current design (same id@version,
 * so every instance in this project uses it); "导出定义 JSON" gives the file to
 * copy back into the catalog.
 */

interface Photo {
  src: string;
  /** Natural image size in px. */
  w: number;
  h: number;
  /** Image width on the board, µm. */
  width_um: number;
  x_um: number;
  y_um: number;
  opacity: number;
  /** Quarter turns applied to the photo (a landscape photo of a board drawn portrait needs 90°). */
  rot: 0 | 90 | 180 | 270;
}

type Drag =
  | { kind: 'move'; start: [number, number]; offset: [number, number] }
  | { kind: 'marquee'; start: [number, number]; current: [number, number]; additive: boolean }
  | { kind: 'pan'; start: [number, number]; origin: [number, number] }
  | { kind: 'photo'; start: [number, number]; origin: [number, number] };

const SNAP_UM = 100;
const mm = (um: number) => Math.round(um / 10) / 100;

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ArtworkEditor({ modelRef, onClose }: { modelRef: string; onClose: () => void }) {
  const design = useStore((s) => s.design);
  const st = useStore.getState();
  const def = useMemo(() => catalogForDesign(design, builtinCatalog()).getComponent(modelRef) ?? null, [design, modelRef]);
  const builtin = useMemo(() => builtinCatalog().getComponent(modelRef) ?? null, [modelRef]);

  const [render, setRender] = useState<RenderPrimitiveDef[]>(() => (def ? def.render.map((p) => ({ ...p })) : []));
  const [past, setPast] = useState<RenderPrimitiveDef[][]>([]);
  const [future, setFuture] = useState<RenderPrimitiveDef[][]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [showPins, setShowPins] = useState(true);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoMode, setPhotoMode] = useState(false);
  const [view, setView] = useState<{ k: number; tx: number; ty: number }>({ k: 12, tx: 40, ty: 40 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const bodySize = def?.body.size_um ?? [10000, 10000];
  const groups = useMemo(() => groupPrimitives(render, bodySize), [render, bodySize]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const pins = useMemo(() => (def ? resolveComponent(def).pins : []), [def]);

  const commit = useCallback(
    (next: RenderPrimitiveDef[]) => {
      setPast((p) => [...p.slice(-99), render]);
      setFuture([]);
      setRender(next);
    },
    [render]
  );
  const undo = useCallback(() => {
    setPast((p) => {
      const prev = p[p.length - 1];
      if (!prev) return p;
      setFuture((f) => [render, ...f]);
      setRender(prev);
      return p.slice(0, -1);
    });
  }, [render]);
  const redo = useCallback(() => {
    setFuture((f) => {
      const next = f[0];
      if (!next) return f;
      setPast((p) => [...p, render]);
      setRender(next);
      return f.slice(1);
    });
  }, [render]);

  const selectedIndices = useMemo(() => {
    const set = new Set<number>();
    for (const id of selected) for (const i of groupById.get(id)?.indices ?? []) set.add(i);
    return set;
  }, [selected, groupById]);

  const snapUm = useCallback((v: number) => (snap ? Math.round(v / SNAP_UM) * SNAP_UM : Math.round(v)), [snap]);

  const moveSelected = useCallback(
    (dx: number, dy: number) => {
      if (!selectedIndices.size || (dx === 0 && dy === 0)) return;
      commit(render.map((p, i) => (selectedIndices.has(i) ? movePrimitive(p, dx, dy) : p)));
    },
    [render, selectedIndices, commit]
  );
  const deleteSelected = useCallback(() => {
    if (!selectedIndices.size) return;
    commit(render.filter((_, i) => !selectedIndices.has(i)));
    setSelected(new Set());
  }, [render, selectedIndices, commit]);
  const duplicateSelected = useCallback(() => {
    if (!selected.size) return;
    let next = [...render];
    const ids: string[] = [];
    for (const id of selected) {
      const g = groupById.get(id);
      if (!g) continue;
      const tag = nextTag(next);
      next = [...next, ...duplicateGroup(render, g, 1000, 1000, tag)];
      ids.push(tag);
    }
    commit(next);
    setSelected(new Set(ids));
  }, [render, selected, groupById, commit]);
  const rotateSelected = useCallback(() => {
    if (!selected.size) return;
    let b: ArtBounds | null = null;
    for (const id of selected) {
      const g = groupById.get(id);
      if (!g) continue;
      b = b ? { x: Math.min(b.x, g.bounds.x), y: Math.min(b.y, g.bounds.y), w: Math.max(b.x + b.w, g.bounds.x + g.bounds.w) - Math.min(b.x, g.bounds.x), h: Math.max(b.y + b.h, g.bounds.y + g.bounds.h) - Math.min(b.y, g.bounds.y) } : { ...g.bounds };
    }
    if (!b) return;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    commit(render.map((p, i) => (selectedIndices.has(i) ? rotatePrimitive(p, cx, cy) : p)));
  }, [render, selected, selectedIndices, groupById, commit]);

  // ---- keyboard: captured before the main editor's shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      e.stopImmediatePropagation();
      if (typing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(groups.filter((g) => !g.large).map((g) => g.id)));
        return;
      }
      const step = e.shiftKey ? 1000 : SNAP_UM;
      switch (e.key) {
        case 'Escape':
          if (selected.size) setSelected(new Set());
          else onClose();
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          deleteSelected();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          moveSelected(-step, 0);
          break;
        case 'ArrowRight':
          e.preventDefault();
          moveSelected(step, 0);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveSelected(0, -step);
          break;
        case 'ArrowDown':
          e.preventDefault();
          moveSelected(0, step);
          break;
        case 'r':
        case 'R':
          rotateSelected();
          break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo, duplicateSelected, deleteSelected, moveSelected, rotateSelected, groups, selected, onClose]);

  // ---- fit on open ----
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !def) return;
    const box = el.getBoundingClientRect();
    const wmm = mm(def.body.size_um[0]) + 12;
    const hmm = mm(def.body.size_um[1]) + 12;
    const k = Math.max(2, Math.min(box.width / wmm, box.height / hmm));
    setView({ k, tx: (box.width - mm(def.body.size_um[0]) * k) / 2, ty: (box.height - mm(def.body.size_um[1]) * k) / 2 });
  }, [def]);

  const toLocalUm = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const box = svgRef.current!.getBoundingClientRect();
      return [((clientX - box.left - view.tx) / view.k) * 1000, ((clientY - box.top - view.ty) / view.k) * 1000];
    },
    [view]
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const box = svgRef.current!.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const k = Math.max(1.5, Math.min(200, view.k * factor));
    setView({ k, tx: px - ((px - view.tx) * k) / view.k, ty: py - ((py - view.ty) * k) / view.k });
  };

  const onPointerDownGroup = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || photoMode) return;
    e.stopPropagation();
    const g = groupById.get(id);
    if (!g) return;
    let next = new Set(selected);
    if (e.shiftKey) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else if (!next.has(id)) next = new Set([id]);
    setSelected(next);
    if (g.large && !next.has(id)) return;
    const p = toLocalUm(e.clientX, e.clientY);
    setDrag({ kind: 'move', start: p, offset: [0, 0] });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerDownCanvas = (e: React.PointerEvent) => {
    const p = toLocalUm(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      setDrag({ kind: 'pan', start: [e.clientX, e.clientY], origin: [view.tx, view.ty] });
      return;
    }
    if (e.button !== 0) return;
    if (photoMode && photo) {
      setDrag({ kind: 'photo', start: p, origin: [photo.x_um, photo.y_um] });
      return;
    }
    if (!e.shiftKey) setSelected(new Set());
    setDrag({ kind: 'marquee', start: p, current: p, additive: e.shiftKey });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView({ ...view, tx: d.origin[0] + (e.clientX - d.start[0]), ty: d.origin[1] + (e.clientY - d.start[1]) });
      return;
    }
    const p = toLocalUm(e.clientX, e.clientY);
    if (d.kind === 'move') setDrag({ ...d, offset: [snapUm(p[0] - d.start[0]), snapUm(p[1] - d.start[1])] });
    else if (d.kind === 'marquee') setDrag({ ...d, current: p });
    else if (d.kind === 'photo' && photo) setPhoto({ ...photo, x_um: Math.round(d.origin[0] + p[0] - d.start[0]), y_um: Math.round(d.origin[1] + p[1] - d.start[1]) });
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'move') {
      if (d.offset[0] || d.offset[1]) moveSelected(d.offset[0], d.offset[1]);
    } else if (d.kind === 'marquee') {
      const x0 = Math.min(d.start[0], d.current[0]);
      const x1 = Math.max(d.start[0], d.current[0]);
      const y0 = Math.min(d.start[1], d.current[1]);
      const y1 = Math.max(d.start[1], d.current[1]);
      if (x1 - x0 > 200 || y1 - y0 > 200) {
        const hit = groups.filter((g) => !g.large && g.bounds.x >= x0 && g.bounds.x + g.bounds.w <= x1 && g.bounds.y >= y0 && g.bounds.y + g.bounds.h <= y1).map((g) => g.id);
        setSelected((cur) => (d.additive ? new Set([...cur, ...hit]) : new Set(hit)));
      }
    }
    setDrag(null);
  };

  const loadPhoto = async (file: File | undefined) => {
    if (!file || !def) return;
    const src = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片无法解码'));
      img.src = src;
    });
    const landscape = img.naturalWidth > img.naturalHeight;
    const portraitBody = def.body.size_um[1] >= def.body.size_um[0];
    const rot = landscape && portraitBody ? 90 : 0;
    // Start with the photo scaled to the body: its long side matches the body's long side.
    const longSide = Math.max(def.body.size_um[0], def.body.size_um[1]);
    const width_um = img.naturalWidth >= img.naturalHeight ? longSide : Math.round((longSide * img.naturalWidth) / img.naturalHeight);
    setPhoto({ src, w: img.naturalWidth, h: img.naturalHeight, width_um, x_um: 0, y_um: 0, opacity: 0.5, rot });
    setPhotoMode(true);
  };

  const save = () => {
    if (!def) return;
    const tagged = tagGroups(render, groups);
    const next: ComponentDefinition = { ...def, render: tagged };
    const r = st.apply([{ op: 'add_definition', definition: next }], '保存外观');
    if (r.ok) {
      st.toast('success', `已把 ${modelRef} 的新绘图保存到本项目（${tagged.length} 个图元，${groups.length} 个部件）。要写回元件库，请用“导出定义 JSON”。`);
      onClose();
    }
  };
  const exportJson = () => {
    if (!def) return;
    download(`${def.id}.json`, JSON.stringify({ ...def, render: tagGroups(render, groups) }, null, 2) + '\n');
  };

  /**
   * Overwrite the definition in `packages/catalog/src/definitions/`. This is the
   * durable answer for a drawing that is simply wrong: it outlives every project,
   * where 保存到本项目 dies with the document it was saved into.
   *
   * Writing the file makes Vite reload the page, so the design is flushed to local
   * storage first — the reload must not cost the user the last few edits.
   *
   * The schema check happens here rather than in the dev plugin: this is the very
   * validator `builtinCatalog()` runs at boot, and an invalid file would throw
   * there with no way back through the UI. The plugin cannot call it — a Vite
   * config is loaded as plain Node ESM and the workspace packages are source-only
   * TypeScript — so it enforces the filesystem rules and this enforces the schema.
   */
  const writeLibrary = async () => {
    if (!def) return;
    const next: ComponentDefinition = { ...def, render: tagGroups(render, groups) };
    const checked = validateComponentDefinition(next);
    if (!checked.ok) {
      st.toast('error', '这份绘图不符合定义 schema，没有写入元件库。', checked.issues.slice(0, 5).map((i) => `${i.path} ${i.message}`));
      return;
    }
    flushSave();
    try {
      const res = await fetch(WRITEBACK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; path?: string; error?: string };
      if (!res.ok || !payload.ok) {
        st.toast('error', `写回元件库失败：${payload.error ?? `HTTP ${res.status}`}`);
        return;
      }
      const overridden = design.embedded_catalog?.components?.some((d) => `${d.id}@${d.version}` === modelRef);
      st.toast(
        'success',
        `已写回 ${payload.path}。所有项目都会用这张新绘图；页面会自动重新加载。`,
        overridden ? ['注意：本项目还内嵌着该型号的自定义绘图，画布会继续用项目里的那份——撤销那次“保存外观”即可改用元件库版本。'] : undefined
      );
      onClose();
    } catch (e) {
      st.toast('error', `写回元件库失败：${(e as Error).message}（只有本地 pnpm dev 才有这个接口）`);
    }
  };

  if (!def) {
    return (
      <div className="artwork-layer" data-testid="artwork-editor">
        <div className="artwork-panel">
          <p>找不到定义 {modelRef}。</p>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    );
  }

  const offset = drag?.kind === 'move' ? drag.offset : [0, 0];
  const shown = render.map((p, i) => (selectedIndices.has(i) && (offset[0] || offset[1]) ? movePrimitive(p, offset[0]!, offset[1]!) : p));
  const hitOrder = [...groups].sort((a, b) => b.bounds.w * b.bounds.h - a.bounds.w * a.bounds.h);
  const selectedGroups = groups.filter((g) => selected.has(g.id));
  const only = selectedGroups.length === 1 ? selectedGroups[0]! : null;
  const setOnlyPos = (axis: 0 | 1, valueMm: number) => {
    if (!only) return;
    const target = Math.round(valueMm * 1000);
    const delta = axis === 0 ? target - only.bounds.x : target - only.bounds.y;
    moveSelected(axis === 0 ? delta : 0, axis === 1 ? delta : 0);
  };

  return (
    <div className="artwork-layer" data-testid="artwork-editor" onContextMenu={(e) => e.preventDefault()}>
      <div className="artwork-panel">
        <div className="artwork-head">
          <div>
            <strong>外观编辑器</strong> <span className="muted">{def.name} · {modelRef} · 单位 mm，坐标为定义局部坐标（未旋转）</span>
          </div>
          <div className="row">
            <button onClick={exportJson} data-testid="artwork-export">导出定义 JSON</button>
            <button onClick={save} data-testid="artwork-save" title="只存进当前项目：换项目、导入或应用 DSL 草稿都会失去它">保存到本项目</button>
            {CAN_WRITE_LIBRARY && (
              <button className="primary" onClick={() => void writeLibrary()} data-testid="artwork-write-library" title="覆盖 packages/catalog/src/definitions/ 里的定义：改一次，所有项目都用新绘图">
                写回元件库
              </button>
            )}
            <button onClick={onClose} data-testid="artwork-close">关闭</button>
          </div>
        </div>
        <div className="artwork-tools">
          <button onClick={undo} disabled={!past.length} title="撤销 (⌘Z)" data-testid="artwork-undo">撤销</button>
          <button onClick={redo} disabled={!future.length} title="重做 (⇧⌘Z)">重做</button>
          <span className="sep" />
          <button onClick={duplicateSelected} disabled={!selected.size} title="复制 (⌘D)" data-testid="artwork-duplicate">复制</button>
          <button onClick={rotateSelected} disabled={!selected.size} title="旋转 90° (R)" data-testid="artwork-rotate">旋转 90°</button>
          <button className="danger" onClick={deleteSelected} disabled={!selected.size} title="删除 (Delete)" data-testid="artwork-delete">删除</button>
          <span className="sep" />
          <label className="toggle"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />吸附 0.1 mm</label>
          <label className="toggle"><input type="checkbox" checked={showPins} onChange={(e) => setShowPins(e.target.checked)} />显示引脚</label>
          <span className="sep" />
          <button onClick={() => fileRef.current?.click()} data-testid="artwork-photo">底图照片…</button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void loadPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          {photo && (
            <>
              <label className="toggle"><input type="checkbox" checked={photoMode} onChange={(e) => setPhotoMode(e.target.checked)} data-testid="artwork-photo-mode" />拖动底图</label>
              <label className="field-inline">透明度<input type="range" min={0.1} max={1} step={0.05} value={photo.opacity} onChange={(e) => setPhoto({ ...photo, opacity: Number(e.target.value) })} /></label>
              <label className="field-inline">底图长边 (mm)<input type="number" step={0.5} value={mm(photo.w >= photo.h ? photo.width_um : (photo.width_um * photo.h) / photo.w)} onChange={(e) => { const long = Math.max(1000, Math.round(Number(e.target.value) * 1000)); setPhoto({ ...photo, width_um: photo.w >= photo.h ? long : Math.round((long * photo.w) / photo.h) }); }} style={{ width: 70 }} data-testid="artwork-photo-size" /></label>
              <button onClick={() => setPhoto({ ...photo, rot: ((photo.rot + 90) % 360) as 0 })} title="底图旋转 90°" data-testid="artwork-photo-rotate">转底图 90°</button>
              <button onClick={() => { setPhoto(null); setPhotoMode(false); }}>移除底图</button>
            </>
          )}
          <span className="sep" />
          {builtin && <button onClick={() => { commit(builtin.render.map((p) => ({ ...p }))); setSelected(new Set()); }} title="用内置元件库的绘图替换当前工作副本（保存后生效）">载入内置绘图</button>}
          <span className="spacer" />
          <span className="muted">{groups.length} 个部件 · 已选 {selected.size}</span>
        </div>
        <div className="artwork-main">
          <svg
            ref={svgRef}
            className={`artwork-canvas${photoMode ? ' photo-mode' : ''}`}
            data-testid="artwork-canvas"
            onWheel={onWheel}
            onPointerDown={onPointerDownCanvas}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
              <rect x={0} y={0} width={mm(bodySize[0])} height={mm(bodySize[1])} fill="none" stroke="#2563eb" strokeWidth={0.15} strokeDasharray="1 0.6" style={{ pointerEvents: 'none' }} />
              <g style={{ pointerEvents: 'none' }}>{shown.map((p, i) => renderNode(primitiveToNode(p), i))}</g>
              {photo && (() => {
                const w = mm(photo.width_um);
                const h = mm((photo.width_um * photo.h) / photo.w);
                const x = mm(photo.x_um);
                const y = mm(photo.y_um);
                // Drawn above the artwork at the chosen opacity so both stay visible; rotates about its top-left corner so (x, y) stays the drag handle.
                const shift = photo.rot === 90 ? `translate(${h} 0)` : photo.rot === 180 ? `translate(${w} ${h})` : photo.rot === 270 ? `translate(0 ${w})` : '';
                return (
                  <g transform={`translate(${x} ${y}) ${shift} rotate(${photo.rot})`} style={{ pointerEvents: 'none' }}>
                    <image href={photo.src} x={0} y={0} width={w} height={h} opacity={photo.opacity} preserveAspectRatio="none" />
                  </g>
                );
              })()}
              {showPins && (
                <g style={{ pointerEvents: 'none' }}>
                  {pins.map((p) => {
                    const left = p.local_um[0] < bodySize[0] / 2;
                    return (
                      <g key={p.name}>
                        <circle cx={mm(p.local_um[0])} cy={mm(p.local_um[1])} r={0.5} fill="none" stroke="#f59e0b" strokeWidth={0.18} opacity={0.95} />
                        <text x={mm(p.local_um[0]) + (left ? -0.9 : 0.9)} y={mm(p.local_um[1]) + 0.25} fontSize={0.7} fill="#b45309" fontFamily="monospace" textAnchor={left ? 'end' : 'start'}>{p.name}</text>
                      </g>
                    );
                  })}
                </g>
              )}
              {!photoMode &&
                hitOrder.map((g) => {
                  const isSel = selected.has(g.id);
                  const dx = isSel ? offset[0]! : 0;
                  const dy = isSel ? offset[1]! : 0;
                  return (
                    <rect
                      key={g.id}
                      data-testid="artwork-part"
                      data-part={g.id}
                      x={mm(g.bounds.x + dx) - 0.1}
                      y={mm(g.bounds.y + dy) - 0.1}
                      width={mm(g.bounds.w) + 0.2}
                      height={mm(g.bounds.h) + 0.2}
                      fill={isSel ? 'rgba(37,99,235,0.12)' : hover === g.id ? 'rgba(37,99,235,0.06)' : 'transparent'}
                      stroke={isSel ? '#2563eb' : hover === g.id ? '#93c5fd' : 'none'}
                      strokeWidth={0.12}
                      strokeDasharray={isSel ? '0.6 0.4' : undefined}
                      style={{ cursor: g.large ? 'default' : 'move' }}
                      onPointerDown={(e) => onPointerDownGroup(e, g.id)}
                      onPointerEnter={() => setHover(g.id)}
                      onPointerLeave={() => setHover((h) => (h === g.id ? null : h))}
                    />
                  );
                })}
              {drag?.kind === 'marquee' && (
                <rect x={mm(Math.min(drag.start[0], drag.current[0]))} y={mm(Math.min(drag.start[1], drag.current[1]))} width={mm(Math.abs(drag.current[0] - drag.start[0]))} height={mm(Math.abs(drag.current[1] - drag.start[1]))} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={0.12} style={{ pointerEvents: 'none' }} />
              )}
            </g>
          </svg>
          <aside className="artwork-side">
            <div className="panel-title">部件</div>
            {only ? (
              <>
                <p className="muted" data-testid="artwork-selected">{only.id} · {only.indices.length} 个图元（{[...new Set(only.indices.map((i) => render[i]!.t))].join('/')}）</p>
                <div className="row">
                  <label className="field"><span>左 (mm)</span><input type="number" step={0.1} value={mm(only.bounds.x)} onChange={(e) => setOnlyPos(0, Number(e.target.value))} data-testid="artwork-x" /></label>
                  <label className="field"><span>上 (mm)</span><input type="number" step={0.1} value={mm(only.bounds.y)} onChange={(e) => setOnlyPos(1, Number(e.target.value))} data-testid="artwork-y" /></label>
                </div>
                <p className="muted">尺寸 {mm(only.bounds.w)} × {mm(only.bounds.h)} mm</p>
              </>
            ) : selected.size > 1 ? (
              <p className="muted">已选 {selected.size} 个部件；方向键微调（Shift 为 1 mm），R 旋转，⌘D 复制，Delete 删除。</p>
            ) : (
              <p className="muted">点击部件选中，拖动移动；Shift 加选；框选多个；滚轮缩放，Alt+拖动或右键拖动平移。</p>
            )}
            <div className="panel-title">怎么用</div>
            <ol className="artwork-help">
              <li>点“底图照片…”放一张实物照片（横向照片会自动转 90° 对齐竖向的定义坐标），把“底图长边 (mm)”改成照片里板子长边的实际尺寸（这块板 {mm(Math.max(bodySize[0], bodySize[1]))} × {mm(Math.min(bodySize[0], bodySize[1]))} mm），勾选“拖动底图”把针脚对到橙色圆圈上，再取消勾选。</li>
              <li>选中画错的小元件拖到照片上的位置；多余的删掉，缺的用复制补。</li>
              <li>保存后本项目里所有该型号都用新绘图；“导出定义 JSON”可写回 <code>packages/catalog/src/definitions/</code>。</li>
            </ol>
            <p className="muted">这里只改外观绘图，不改引脚坐标、外形尺寸或电气数据。</p>
          </aside>
        </div>
      </div>
    </div>
  );
}
