import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesignDocument, PointUm, Placement, WireEndpoint } from '@breadboard-studio/schema';
import { builtinCatalog } from '@breadboard-studio/catalog';
import {
  accessibleHolesForPin,
  applyOps,
  boardShape,
  buildModel,
  canResizeBoard,
  catalogForDesign,
  conductiveSet,
  groupHoles,
  holeAtLocal,
  isSolderableBoard,
  parseAddress,
  resolveComponent,
  RESIZE_LIMITS,
  rotateVec,
  toGlobal,
  toLocal,
  type DesignModel,
  type Op,
  type RuleResult
} from '@breadboard-studio/core';
import { buildScene, componentScene, boardScene, wireScene, mm, wireColor, type SceneNode } from '@breadboard-studio/render';
import { analysisOf, useStore } from '../store';
import { SNAP_UM, leadPin, snapBoardPosition, snapPlacement } from '../placement';
import { useSimulatorStore } from '../simulator/simulatorStore';
import { SimulatorOverlay } from '../simulator/ui/SimulatorOverlay';
import { SceneNodes, renderNode } from './SceneView';

interface View {
  z: number; // px per mm
  px: number;
  py: number;
  /** 视图旋转（度）。只影响显示，不写进设计数据。 */
  rot: number;
  /** 洞洞板焊接面：只影响显示与命中，不写入设计数据。 */
  side: 'front' | 'solder';
}

/** 把设计坐标按视图角度旋转（度）。 */
function rotateByDeg(p: [number, number], deg: number): [number, number] {
  if (!deg) return p;
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/**
 * 滚轮缩放灵敏度（每像素 deltaY 的指数系数）。
 * 一格滚轮的 deltaY 约 100px，这里约合 16% —— 想更细就调小，想更"跟手"就调大。
 */
const ZOOM_WHEEL_SENSITIVITY = 0.0016;
/** 缩放范围，避免缩到看不见或放大到坐标溢出。 */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 60;
/** 尺寸编辑的列数边界（与 core 的 RESIZE_LIMITS 同源，避免两处各写一份）。 */
const RESIZE_MIN_COLUMNS = RESIZE_LIMITS.columns.min;
const RESIZE_MAX_COLUMNS = RESIZE_LIMITS.columns.max;

type DragMode =
  | { kind: 'none' }
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: [number, number]; current: [number, number] }
  | { kind: 'objects'; ids: string[]; startMm: [number, number]; moved: boolean; pointerId: number }
  | { kind: 'waypoint'; wireId: string; index: number; pointerId: number }
  /**
   * 尺寸编辑（issue #22）：拖动面包板右/下边缘把手延长或裁剪。`plan` 是当前
   * 指针位置换算出的行列数（预览用），还没写进设计。
   */
  | { kind: 'resize'; boardId: string; axis: 'x' | 'y'; plan: { columns: number; rows: number }; pointerId: number }
  /**
   * 拖一根已经接好的线的端点。`from` 是拖起来那一刻的端点，用来判断"拖回原地"
   * 与"两端撞到同一个孔"，也让取消（松手前没动）什么都不改。
   */
  | { kind: 'wire-end'; wireId: string; end: WireEnd; startMm: [number, number]; from: WireEndpoint; moved: boolean; pointerId: number };

interface Preview {
  ops: Op[];
  design: DesignDocument;
  model: DesignModel;
  blocking: RuleResult[];
}

/** 一根导线的两端。`from` 画在第一个点上，`to` 画在最后一个点上。 */
type WireEnd = 'from' | 'to';


export function Canvas() {
  const design = useStore((s) => s.design);
  const analysis = analysisOf(design);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectedHole = useStore((s) => s.selectedHole);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const wireDraft = useStore((s) => s.wireDraft);
  const showHoleLabels = useStore((s) => s.showHoleLabels);
  const showPinLabels = useStore((s) => s.showPinLabels);
  const connectivityHighlight = useStore((s) => s.connectivityHighlight);
  const dimUnhighlighted = useStore((s) => s.dimUnhighlighted);
  const highlightEndpoints = useStore((s) => s.highlightEndpoints);
  const fitRequest = useStore((s) => s.fitRequest);
  const mode = useStore((s) => s.mode);
  // The wiring guide highlights its current wire exactly while its panel is open.
  const wiringGuide = useStore((s) => s.mode === 'build' && s.rightTab === 'wiring');
  const buildStep = useStore((s) => s.buildStep);
  const wireColorName = useStore((s) => s.wireColor);
  const wireRoute = useStore((s) => s.wireRoute);
  const { apply, select, selectHole, setWireDraft, cancelInteraction, toast } = useStore.getState();

  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ z: 6, px: 40, py: 40, rot: 0, side: 'front' });
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const [drag, setDragState] = useState<DragMode>({ kind: 'none' });
  const setDrag = (d: DragMode) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewReq = useRef<{ pending: [number, number] | null; raf: number | null }>({ pending: null, raf: null });
  const [cursorMm, setCursorMm] = useState<[number, number] | null>(null);
  /** Same value as `cursorMm`, readable from the window bridge without re-running its effect. */
  const cursorRef = useRef<[number, number] | null>(null);
  const [wpDrag, setWpDrag] = useState<{ wireId: string; index: number; pos: PointUm } | null>(null);
  /** 正在拖的线端点：跟着指针画一条虚线，并标出候选落点。 */
  const [endDrag, setEndDrag] = useState<{ wireId: string; end: WireEnd; pos: PointUm } | null>(null);
  /**
   * 尺寸编辑模式（issue #22）：双击面包板进入，显示边缘把手；Esc / 再次双击退出。
   * 只有 drag.kind === 'resize' 进行中才真正改设计。
   */
  const [resizeEditId, setResizeEditId] = useState<string | null>(null);
  const spaceRef = useRef(false);

  const catalog = useMemo(() => catalogForDesign(design, builtinCatalog()), [design]);
  const model = analysis.model;

  /** 与接线向导 buildSteps 相同的排序：保证 buildStep 下标对应同一根线。 */
  const sortedWires = useMemo(
    () => [...model.wires.values()].sort((a, b) => a.instance.id.localeCompare(b.instance.id, undefined, { numeric: true })),
    [model]
  );
  /** 向导聚焦生效 = 向导面板打开 且 当前步骤确有一根线（线被删光/下标越界时自动退回普通高亮）。 */
  const wizardStep = wiringGuide ? sortedWires[buildStep] : undefined;
  const wizardFocus = Boolean(wizardStep);

  /**
   * 孔 → 插在这个孔里的引脚。一根线插进一个空孔时，光看导线是看不出它接到谁的：
   * 电气上它接的是同一列导通组里的那个引脚，这张表就是把这句话还原出来。
   */
  const pinAtHole = useMemo(() => {
    const m = new Map<string, { comp: string; pin: string }>();
    for (const pc of model.components.values()) {
      for (const pin of pc.pins) {
        if (!pin.hole) continue;
        m.set(`${pin.hole.board_id}.${pin.hole.hole}`, { comp: pc.instance.id, pin: `${pc.instance.id}.${pin.name}` });
      }
    }
    return m;
  }, [model]);

  /** 所有引脚的世界坐标（mm），命中测试用。 */
  const pinPoints = useMemo(() => {
    const out: { addr: string; x: number; y: number }[] = [];
    for (const pc of model.components.values()) {
      for (const pin of pc.pins) out.push({ addr: `${pc.instance.id}.${pin.name}`, x: mm(pin.global_um[0]), y: mm(pin.global_um[1]) });
    }
    return out;
  }, [model]);

  /** 落点上的元件：取包围盒最小的那个（最具体的先赢）。 */
  const componentAt = useCallback(
    (p: [number, number]): string | undefined => {
      let best: { id: string; area: number } | null = null;
      for (const pc of model.components.values()) {
        const b = { x: mm(pc.bounds.x) - 0.6, y: mm(pc.bounds.y) - 0.6, w: mm(pc.bounds.w) + 1.2, h: mm(pc.bounds.h) + 1.2 };
        if (p[0] < b.x || p[0] > b.x + b.w || p[1] < b.y || p[1] > b.y + b.h) continue;
        const area = b.w * b.h;
        if (!best || area < best.area) best = { id: pc.instance.id, area };
      }
      return best?.id;
    },
    [model]
  );

  // ---- highlight sets -------------------------------------------------------
  const highlight = useMemo(() => {
    const holes = new Set<string>();
    const pins = new Set<string>();
    const wires = new Set<string>();
    const comps = new Set<string>();
    /** 点亮一根导线的两端：孔 → 同组导通孔 → 插在同一列里的引脚。 */
    const addWireEndpoints = (rw: { from: { kind: string; address: string } | null; to: { kind: string; address: string } | null }) => {
      for (const ep of [rw.from, rw.to]) {
        if (!ep) continue;
        if (ep.kind === 'hole') {
          holes.add(ep.address);
          // 不知道接到哪里时，答案是"这一列上插着谁"。
          for (const h of groupHoles(model, ep.address)) {
            const owner = pinAtHole.get(h);
            if (owner) {
              pins.add(owner.pin);
              comps.add(owner.comp);
            }
          }
        } else pins.add(ep.address);
      }
    };
    if (selectedHole) {
      const set = connectivityHighlight ? conductiveSet(model, analysis.connectivity, selectedHole) : { holes: groupHoles(model, selectedHole), pins: [] };
      set.holes.forEach((h) => holes.add(h));
      set.pins.forEach((p) => pins.add(p));
      // 空孔本身没有意义，真正要知道的是"这一列上插着谁"。
      for (const h of groupHoles(model, selectedHole)) {
        const owner = pinAtHole.get(h);
        if (owner) {
          pins.add(owner.pin);
          comps.add(owner.comp);
        }
      }
      const net = analysis.connectivity.netByRoot.get(analysis.connectivity.full.find(selectedHole));
      if (connectivityHighlight && net) net.wires.forEach((w) => wires.add(w));
    }
    for (const id of selectedIds) {
      const rw = model.wires.get(id);
      if (rw) {
        addWireEndpoints(rw);
        continue;
      }
      // 选中的是元件/面包板：把"插在它身上"的导线挑出来。
      //
      // 这里刻意**不**用电学导通组来判断。像 GND / 3V3 这种共用网络，用导通组
      // 会把所有接在电源轨上的线全点亮（选一个旋钮就连屏幕的电源线都亮），
      // 那就不是"直连"了。物理上"直连"= 导线端点落在该元件引脚所在的那一列
      // 面包板孔里，所以用 groupHoles（板内导通组）而不是 connectivity（整网）。
      if (model.components.has(id) || model.boards.has(id)) {
        comps.add(id);
        const own = new Set<string>();
        const pc = model.components.get(id);
        if (pc) {
          for (const p of pc.pins) {
            if (!p.hole) continue;
            const addr = `${p.hole.board_id}.${p.hole.hole}`;
            own.add(addr);
            for (const h of groupHoles(model, addr)) own.add(h);
          }
        }
        if (model.boards.has(id)) {
          for (const h of model.holes.keys()) {
            if (parseAddress(h)?.owner === id) own.add(h);
          }
        }
        if (own.size) {
          for (const w of model.wires.values()) {
            const wired = [w.from, w.to].some((ep) => ep && own.has(ep.address));
            if (wired) wires.add(w.instance.id);
          }
        }
      }
    }
    for (const ep of highlightEndpoints) {
      const parsed = parseAddress(ep);
      if (parsed && model.boards.has(parsed.owner)) holes.add(ep);
      else pins.add(ep);
    }
    if (wizardStep) {
      // 向导聚焦以当前步骤为准：清掉之前画布选择/整网高亮的干扰，
      // 只留当前这根线（含编号）和它的两端。
      holes.clear();
      pins.clear();
      wires.clear();
      comps.clear();
      wires.add(wizardStep.instance.id);
      addWireEndpoints(wizardStep);
    }
    return { holes, pins, wires, comps };
  }, [selectedHole, selectedIds, highlightEndpoints, model, analysis, connectivityHighlight, wizardStep, pinAtHole]);

  const scene = useMemo(
    () =>
      buildScene(model, {
        showHoleLabels,
        showPinLabels,
        showUnverifiedBadges: false,
        showUprightGhost: true,
        highlightHoles: highlight.holes,
        highlightPins: highlight.pins,
        highlightWires: highlight.wires,
        highlightComponents: highlight.comps,
        // 向导聚焦时清空选中轮廓：当前步骤是唯一的主角，
        // 连之前选中的那根线的蓝色 halo 也一起让位压暗。
        selectedIds: wizardFocus ? new Set<string>() : new Set(selectedIds),
        // 有选中项时压暗；接线向导聚焦时无条件压暗其余导线
        dimUnhighlighted: wizardFocus || (dimUnhighlighted && (selectedIds.length > 0 || Boolean(selectedHole)))
      }),
    [model, showHoleLabels, showPinLabels, highlight, selectedIds, selectedHole, dimUnhighlighted, wizardFocus]
  );

  // ---- coordinate helpers ---------------------------------------------------
  const toMm = useCallback((clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const v = viewRef.current;
    const dx = (clientX - r.left - v.px) / v.z;
    const dy = (clientY - r.top - v.py) / v.z;
    let x = dx;
    let y = dy;
    if (v.rot) {
      // 视图转过角度，屏幕坐标要反向转回去才是设计坐标（R⁻¹ = Rᵀ）
      const rad = (v.rot * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      x = dx * c + dy * s;
      y = -dx * s + dy * c;
    }
    if (v.side === 'solder') {
      const axis = scene.bounds.x + scene.bounds.w / 2;
      x = 2 * axis - x;
    }
    return [x, y];
  }, [scene.bounds.x, scene.bounds.w]);
  const toUm = (p: [number, number]): PointUm => [Math.round(p[0] * 1000), Math.round(p[1] * 1000)];

  const fit = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const b = model.bounds ?? { x: 0, y: 0, w: 100000, h: 60000 };
    const rot = viewRef.current.rot;
    // 旋转后要按旋转过的外接矩形来算，否则转 90° 内容会跑出视口
    const corners: [number, number][] = [
      [b.x / 1000, b.y / 1000],
      [(b.x + b.w) / 1000, b.y / 1000],
      [b.x / 1000, (b.y + b.h) / 1000],
      [(b.x + b.w) / 1000, (b.y + b.h) / 1000]
    ].map((p) => rotateByDeg(p as [number, number], rot));
    const minX = Math.min(...corners.map((p) => p[0]));
    const maxX = Math.max(...corners.map((p) => p[0]));
    const minY = Math.min(...corners.map((p) => p[1]));
    const maxY = Math.max(...corners.map((p) => p[1]));
    const wMm = maxX - minX + 20;
    const hMm = maxY - minY + 20;
    const z = Math.max(0.5, Math.min(40, Math.min(r.width / wMm, r.height / hMm)));
    const px = (r.width - (maxX - minX) * z) / 2 - minX * z;
    const py = (r.height - (maxY - minY) * z) / 2 - minY * z;
    setView((v) => ({ ...v, z, px, py, rot }));
  }, [model]);

  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        // 无极缩放：把 deltaY 统一成像素后按指数连续换算。
        // 一格滚轮约 100px → 约 16%，触控板/捏合的细小 delta 也照样平滑；
        // 原来的 0.01 系数一格能跳 2.7 倍，所以看着"一档一档"。
        const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
        const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.z * Math.exp(-px * ZOOM_WHEEL_SENSITIVITY)));
        const k = z / v.z;
        setView({ ...v, z, px: cx - (cx - v.px) * k, py: cy - (cy - v.py) * k });
      } else {
        setView({ ...v, px: v.px - e.deltaX, py: v.py - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const dragging = dragRef.current;
      if (e.key === 'Escape' && dragging.kind === 'wire-end') {
        // 放弃这次改接：先还掉指针捕获，别让随后的 pointerup 又落一个端点。
        try {
          svgRef.current?.releasePointerCapture(dragging.pointerId);
        } catch {
          // 捕获可能早就被浏览器收回了，忽略。
        }
        dragRef.current = { kind: 'none' };
        setDragState({ kind: 'none' });
        setEndDrag(null);
        return;
      }
      if (e.key === 'Escape' && dragging.kind === 'resize') {
        try {
          svgRef.current?.releasePointerCapture(dragging.pointerId);
        } catch {
          // 同上：忽略已被收回的捕获。
        }
        dragRef.current = { kind: 'none' };
        setDragState({ kind: 'none' });
        setPreview(null);
        return;
      }
      if (e.key === 'Escape' && resizeEditId) {
        setResizeEditId(null);
        return;
      }
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        spaceRef.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [resizeEditId]);

  // Expose zoom controls to the toolbar through the store-free window bridge.
  useEffect(() => {
    (window as unknown as { __bbsCanvas?: unknown }).__bbsCanvas = {
      fit,
      zoomBy: (f: number) => {
        const svg = svgRef.current!;
        const r = svg.getBoundingClientRect();
        const v = viewRef.current;
        const cx = r.width / 2;
        const cy = r.height / 2;
        const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.z * f));
        const k = z / v.z;
        setView({ ...v, z, px: cx - (cx - v.px) * k, py: cy - (cy - v.py) * k });
      },
      /**
       * 转动视图。绕视口中心转，所以视野中心的设计坐标保持不动，
       * 转完不用手动 pan。
       */
      rotateBy: (deltaDeg: number) => {
        const svg = svgRef.current!;
        const r = svg.getBoundingClientRect();
        const cx = r.width / 2;
        const cy = r.height / 2;
        const v = viewRef.current;
        const rot = (((v.rot + deltaDeg) % 360) + 360) % 360;
        const [rx, ry] = rotateByDeg([cx - v.px, cy - v.py], deltaDeg);
        setView({ ...v, rot, px: cx - rx, py: cy - ry });
      },
      rotateTo: (deg: number) => {
        const svg = svgRef.current!;
        const r = svg.getBoundingClientRect();
        const cx = r.width / 2;
        const cy = r.height / 2;
        const v = viewRef.current;
        const rot = (((deg % 360) + 360) % 360);
        const [rx, ry] = rotateByDeg([cx - v.px, cy - v.py], rot - v.rot);
        setView({ ...v, rot, px: cx - rx, py: cy - ry });
      },
      toggleSolderSide: () => setView((v) => ({ ...v, side: v.side === 'front' ? 'solder' : 'front' })),
      zoomTo: (z: number) => setView((v) => ({ ...v, z })),
      // 「已选元件」面板用它把视图移到目标上（入参是全局 µm 包围盒）。
      // 留 40mm 边距、最高 200%：只框住目标本身会把一根细线放到 500%，除了它什么都看不见。
      // 视图可以旋转（rotate-view），变换是 translate∘scale∘rotate，所以目标中心要先转过去。
      centerOn: (b: { x: number; y: number; w: number; h: number }) => {
        const svg = svgRef.current;
        if (!svg) return;
        const r = svg.getBoundingClientRect();
        const rot = viewRef.current.rot;
        const swap = rot % 180 !== 0;
        const z = Math.max(1, Math.min(12, Math.min(r.width / (mm(swap ? b.h : b.w) + 40), r.height / (mm(swap ? b.w : b.h) + 40))));
        const [cx, cy] = rotateByDeg([mm(b.x + b.w / 2), mm(b.y + b.h / 2)], rot);
        setView((v) => ({ ...v, z, px: r.width / 2 - cx * z, py: r.height / 2 - cy * z, rot }));
      },
      // Paste needs to know where the pointer is; the store has no view transform.
      cursorUm: (): PointUm | null => {
        const c = cursorRef.current;
        return c ? [Math.round(c[0] * 1000), Math.round(c[1] * 1000)] : null;
      }
    };
  }, [fit]);

  // ---- hit testing ----------------------------------------------------------
  function hit(e: { target: EventTarget | null; clientX: number; clientY: number }): { hole?: string; pin?: string; component?: string; board?: string; wire?: string; waypoint?: number; badge?: string; end?: WireEnd; resizeHandle?: { board: string; axis: 'x' | 'y' } } {
    const el = e.target as Element | null;
    if (!el || !(el instanceof Element)) return {};
    const handle = el.closest('[data-resize-handle]') as HTMLElement | null;
    if (handle?.dataset.resizeHandle) return { resizeHandle: { board: handle.dataset.resizeBoard!, axis: handle.dataset.resizeHandle as 'x' | 'y' } };
    const wp = el.closest('[data-waypoint]') as HTMLElement | null;
    if (wp) return { wire: wp.dataset.wire, waypoint: Number(wp.dataset.waypoint) };
    // 线端点的抓取圈压在孔上面，所以要先于 data-hole 判断：指针落在插头上时
    // 用户想拖的是这根线，不是那个孔。
    const endEl = el.closest('[data-end]') as HTMLElement | null;
    if (endEl?.dataset.wire) return { wire: endEl.dataset.wire, end: endEl.dataset.end as WireEnd };
    const hole = (el.closest('[data-hole]') as HTMLElement | null)?.dataset.hole;
    if (hole) return { hole };
    const pin = (el.closest('[data-pin]') as HTMLElement | null)?.dataset.pin;
    const component = (el.closest('[data-component]') as HTMLElement | null)?.dataset.component;
    const wire = (el.closest('[data-wire]') as HTMLElement | null)?.dataset.wire;
    const board = (el.closest('[data-board]') as HTMLElement | null)?.dataset.board;
    const badge = (el.closest('[data-badge]') as HTMLElement | null)?.dataset.badge;
    if (pin || component) return { pin, component, wire, board, badge };
    // 导线画在元件之上，于是 DOM 最上面那层永远是导线：6×6 轻触开关、被线压住的
    // 引脚全都点不到。这里按几何把命中让回给元件 —— 想选那根线，点它没被元件压住
    // 的那一段（或从「已选元件」面板里点）。
    const p = toMm(e.clientX, e.clientY);
    let nearPin: string | undefined;
    let nearD = 1.15;
    for (const q of pinPoints) {
      const d = Math.hypot(q.x - p[0], q.y - p[1]);
      if (d <= nearD) {
        nearD = d;
        nearPin = q.addr;
      }
    }
    if (nearPin) return { pin: nearPin };
    const comp = componentAt(p);
    if (comp) return { component: comp };
    return { pin, component, wire, board, badge };
  }

  // ---- placement computation -----------------------------------------------
  const snapPlacementForComponent = (id: string, deltaUm: PointUm, base: DesignDocument): Placement | null => snapPlacement(model, base, id, deltaUm);

  function buildMoveOps(ids: string[], deltaUm: PointUm): Op[] {
    const ops: Op[] = [];
    for (const id of ids) {
      if (model.boards.has(id)) {
        if (design.boards.find((b) => b.id === id)?.locked) continue;
        const board = model.boards.get(id)!;
        const position = ids.length === 1 && board.def.render.style !== 'perfboard'
          ? snapBoardPosition(model, id, deltaUm)
          : [board.transform.position[0] + deltaUm[0], board.transform.position[1] + deltaUm[1]] as PointUm;
        ops.push({ op: 'move_board', id, position_um: position });
      } else if (model.components.has(id)) {
        if (design.components.find((c) => c.id === id)?.locked) continue;
        const pl = snapPlacementForComponent(id, deltaUm, design);
        if (pl) ops.push({ op: 'move_component', id, placement: pl });
      }
    }
    return ops;
  }

  function computePreview(ops: Op[]): Preview | null {
    if (!ops.length) return null;
    const r = applyOps(design, ops, { catalog, allow_blocking: true });
    if (!r.ok) return null;
    const m = buildModel(r.design, catalog);
    const movedIds = new Set(ops.map((o) => ('id' in o ? o.id : '')));
    const blocking = r.results.filter((x) => x.blocking && x.objects.some((o) => movedIds.has(o)));
    return { ops, design: r.design, model: m, blocking };
  }

  /** 这块板上会被一次尺寸编辑牵动的对象：板自己、板上元件、端点在本板的导线。 */
  function affectedByResize(d: DesignDocument, boardId: string): Set<string> {
    const affected = new Set([boardId]);
    for (const c of d.components) {
      if (c.placement.kind === 'board' && c.placement.board_id === boardId) affected.add(c.id);
    }
    for (const w of d.wires) {
      for (const ep of [w.from, w.to] as WireEndpoint[]) {
        if (ep?.hole && ep.hole.startsWith(`${boardId}.`)) {
          affected.add(w.id);
          break;
        }
      }
    }
    return affected;
  }

  /**
   * 尺寸编辑的预览。和拖动不同：新板会让**别的**对象越界（元件其余排针伸出新
   * 边缘 = `pin_not_on_hole`，objects 是元件不是板），所以不能只按板 id 过滤。
   * 这里取「这次操作**新引入**的 blocking」，再限定在受牵动的对象上，既不会漏
   * 报，也不会把设计里本来就有的 blocking 算到这次拖动的账上。
   */
  function computeResizePreview(boardId: string, plan: { columns: number; rows: number }): Preview | null {
    const ops: Op[] = [{ op: 'resize_board', id: boardId, columns: plan.columns, rows: plan.rows }];
    const r = applyOps(design, ops, { catalog, allow_blocking: true });
    if (!r.ok) return null;
    const m = buildModel(r.design, catalog);
    const before = new Set(analysis.results.filter((x) => x.blocking).map((x) => `${x.code}|${x.objects.join(',')}`));
    const affected = affectedByResize(r.design, boardId);
    const blocking = r.results.filter(
      (x) =>
        x.blocking &&
        !before.has(`${x.code}|${x.objects.join(',')}`) &&
        (x.objects.some((o) => affected.has(o)) || Boolean(x.endpoints?.some((e) => e.startsWith(`${boardId}.`))))
    );
    return { ops, design: r.design, model: m, blocking };
  }

  function schedulePreview(pos: [number, number]) {
    previewReq.current.pending = pos;
    if (previewReq.current.raf !== null) return;
    previewReq.current.raf = requestAnimationFrame(() => {
      previewReq.current.raf = null;
      const p = previewReq.current.pending;
      previewReq.current.pending = null;
      const d = dragRef.current;
      if (!p || d.kind !== 'objects') return;
      const delta: PointUm = [Math.round((p[0] - d.startMm[0]) * 1000), Math.round((p[1] - d.startMm[1]) * 1000)];
      setPreview(computePreview(buildMoveOps(d.ids, delta)));
    });
  }

  /** 尺寸编辑的实时预览（与对象拖动共用 preview 状态，但 op 不同）。 */
  const resizeReq = useRef<{ raf: number | null }>({ raf: null });
  function scheduleResizePreview() {
    if (resizeReq.current.raf !== null) return;
    resizeReq.current.raf = requestAnimationFrame(() => {
      resizeReq.current.raf = null;
      const d = dragRef.current;
      if (d.kind !== 'resize') return;
      setPreview(computeResizePreview(d.boardId, d.plan));
    });
  }

  // ---- placing a new component ---------------------------------------------
  function computePlacing(at: [number, number] | null) {
    if (!placing || !at) return null;
    const def = catalog.getComponent(placing.model);
    if (!def) return null;
    const rc = resolveComponent(def);
    const anchor = leadPin(rc.pins, placing.rotation);
    const cursorUm = toUm(at);
    const anchorOffset = anchor ? rotateVec(anchor.local_um, placing.rotation) : null;
    let placement: Placement = {
      kind: 'off_board',
      position_um: anchorOffset
        ? [cursorUm[0] - anchorOffset[0], cursorUm[1] - anchorOffset[1]]
        : [cursorUm[0] - Math.round(rc.outline.w / 2), cursorUm[1] - Math.round(rc.outline.h / 2)],
      rotation_deg: placing.rotation
    };
    if (anchor) {
      for (const pb of model.boards.values()) {
        const local = toLocal(cursorUm, pb.transform);
        const h = holeAtLocal(pb.resolved, local, SNAP_UM);
        if (h) {
          placement = { kind: 'board', board_id: pb.instance.id, anchor_hole: h.name, anchor_pin: anchor.name, rotation_deg: placing.rotation };
          break;
        }
      }
    }
    const id = nextComponentId(design, placing.model);
    const op: Op = { op: 'add_component', component: { id, model: placing.model, name: def.name, placement } };
    const r = applyOps(design, [op], { catalog, allow_blocking: true });
    if (!r.ok) return null;
    const m = buildModel(r.design, catalog);
    const blocking = r.results.filter((x) => x.blocking && x.objects.includes(id));
    return { op, model: m, id, blocking, def };
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const placingPreview = useMemo(() => computePlacing(cursorMm), [placing, cursorMm, design, model]);

  // ---- pointer handlers ------------------------------------------------------
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current!;
    const p = toMm(e.clientX, e.clientY);
    const h = hit(e);
    if (e.button === 1 || spaceRef.current || tool === 'pan') {
      svg.setPointerCapture(e.pointerId);
      setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, view });
      return;
    }
    if (e.button === 2) return;
    if (placing) return; // handled on click
    if (tool === 'wire') return; // handled on click
    // Two independent reasons the canvas may not be edited: 仿真 mode offers no
    // editing tool at all, and a live session freezes the topology (plan §9.8).
    // Either way pointer-down still selects — it just never captures the pointer or
    // starts a drag, so the edit is refused *before* it happens, not by a later toast.
    const canEdit = useStore.getState().mode === 'build' && useSimulatorStore.getState().canEditTopology;
    if (h.wire && h.end) {
      // 已经接好的线，抓住它的插头就能改接到别的孔/端子 —— 选中照旧发生，
      // 只有真的拖出去了（moved）才会写设计。
      select([h.wire]);
      if (!canEdit) return;
      const w = design.wires.find((x) => x.id === h.wire);
      const ep = h.end === 'from' ? w?.from : w?.to;
      if (!w || !ep) return;
      svg.setPointerCapture(e.pointerId);
      setDrag({ kind: 'wire-end', wireId: w.id, end: h.end, startMm: p, from: ep, moved: false, pointerId: e.pointerId });
      return;
    }
    if (h.waypoint !== undefined && h.wire) {
      if (!canEdit) return;
      svg.setPointerCapture(e.pointerId);
      setDrag({ kind: 'waypoint', wireId: h.wire, index: h.waypoint, pointerId: e.pointerId });
      return;
    }
    if (h.resizeHandle) {
      // 尺寸编辑：把手已可见（resize 模式才有），按下即开始拖。
      if (!canEdit) return;
      const pb = model.boards.get(h.resizeHandle.board);
      if (!pb) return;
      const shape = boardShape(pb.def);
      svg.setPointerCapture(e.pointerId);
      setDrag({
        kind: 'resize',
        boardId: h.resizeHandle.board,
        axis: h.resizeHandle.axis,
        plan: { columns: shape?.columns ?? 0, rows: shape?.rows ?? 0 },
        pointerId: e.pointerId
      });
      return;
    }
    if (h.hole) {
      selectHole(h.hole);
      return;
    }
    const objId = (h.pin ? parseAddress(h.pin)?.owner : undefined) ?? h.component ?? h.wire ?? h.badge ?? h.board;
    if (objId) {
      let ids = selectedIds;
      if (e.shiftKey) {
        select([objId], true);
        ids = selectedIds.includes(objId) ? selectedIds.filter((x) => x !== objId) : [...selectedIds, objId];
      } else if (!selectedIds.includes(objId)) {
        select([objId]);
        ids = [objId];
      }
      const draggable = canEdit ? ids.filter((id) => model.components.has(id) || model.boards.has(id)) : [];
      if (draggable.length && !h.wire) {
        svg.setPointerCapture(e.pointerId);
        setDrag({ kind: 'objects', ids: draggable, startMm: p, moved: false, pointerId: e.pointerId });
      }
      return;
    }
    // empty space: marquee
    svg.setPointerCapture(e.pointerId);
    setDrag({ kind: 'marquee', start: p, current: p });
    if (!e.shiftKey) select([]);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = toMm(e.clientX, e.clientY);
    setCursorMm(p);
    cursorRef.current = p;
    const d = dragRef.current;
    switch (d.kind) {
      case 'pan':
        setView({ ...d.view, px: d.view.px + (e.clientX - d.startX), py: d.view.py + (e.clientY - d.startY) });
        break;
      case 'marquee':
        setDrag({ ...d, current: p });
        break;
      case 'objects': {
        const moved = d.moved || Math.hypot(p[0] - d.startMm[0], p[1] - d.startMm[1]) > 0.8;
        if (moved !== d.moved) setDrag({ ...d, moved });
        if (moved) schedulePreview(p);
        break;
      }
      case 'waypoint':
        setWpDrag({ wireId: d.wireId, index: d.index, pos: toUm(p) });
        break;
      case 'resize': {
        // 指针 → 板本地 µm → 列/行数（按孔距吸附）。把手拖的是新板的边缘线：
        // 塑料边宽度不变，所以先减掉边缘到最后一列/行的距离。
        const pb = model.boards.get(d.boardId);
        if (!pb) break;
        const local = toLocal(toUm(p), pb.transform);
        const def = pb.def;
        const pitch = def.pitch_um;
        if (d.axis === 'x') {
          const block = def.terminal_blocks[0]!;
          const marginRight = Math.max(0, def.size_um[0] - block.origin_um[0] - (block.columns - 1) * pitch);
          const columns = Math.max(RESIZE_MIN_COLUMNS, Math.min(RESIZE_MAX_COLUMNS, Math.round((local[0] - block.origin_um[0] - marginRight) / pitch) + 1));
          setDrag({ ...d, plan: { ...d.plan, columns } });
        } else {
          // 下把手指的是下块最后一行的下边缘：新行数 = round((y − 下块首行 y − 下塑料边)/孔距) + 1
          const last = def.terminal_blocks[def.terminal_blocks.length - 1]!;
          const marginBottom = Math.max(0, def.size_um[1] - last.origin_um[1] - (last.rows.length - 1) * pitch);
          const maxRows = boardShape(def)?.rows ?? last.rows.length;
          const rows = Math.max(1, Math.min(maxRows, Math.round((local[1] - last.origin_um[1] - marginBottom) / pitch) + 1));
          setDrag({ ...d, plan: { ...d.plan, rows } });
        }
        scheduleResizePreview();
        break;
      }
      case 'wire-end': {
        const moved = d.moved || Math.hypot(p[0] - d.startMm[0], p[1] - d.startMm[1]) > 0.8;
        if (moved !== d.moved) setDrag({ ...d, moved });
        if (moved) setEndDrag({ wireId: d.wireId, end: d.end, pos: toUm(p) });
        break;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragRef.current;
    const p = toMm(e.clientX, e.clientY);
    switch (d.kind) {
      case 'marquee': {
        const x0 = Math.min(d.start[0], p[0]);
        const x1 = Math.max(d.start[0], p[0]);
        const y0 = Math.min(d.start[1], p[1]);
        const y1 = Math.max(d.start[1], p[1]);
        if (x1 - x0 > 1 && y1 - y0 > 1) {
          const ids: string[] = [];
          for (const pc of model.components.values()) {
            const b = pc.bounds;
            if (mm(b.x) >= x0 && mm(b.x + b.w) <= x1 && mm(b.y) >= y0 && mm(b.y + b.h) <= y1) ids.push(pc.instance.id);
          }
          for (const rw of model.wires.values()) {
            if (rw.points.length && rw.points.every((pt) => mm(pt[0]) >= x0 && mm(pt[0]) <= x1 && mm(pt[1]) >= y0 && mm(pt[1]) <= y1)) ids.push(rw.instance.id);
          }
          for (const pb of model.boards.values()) {
            const b = pb.bounds;
            if (mm(b.x) >= x0 && mm(b.x + b.w) <= x1 && mm(b.y) >= y0 && mm(b.y + b.h) <= y1) ids.push(pb.instance.id);
          }
          select(ids, e.shiftKey);
        }
        break;
      }
      case 'objects': {
        if (d.moved) {
          const delta: PointUm = [Math.round((p[0] - d.startMm[0]) * 1000), Math.round((p[1] - d.startMm[1]) * 1000)];
          const ops = buildMoveOps(d.ids, delta);
          const pv = computePreview(ops);
          if (pv && pv.blocking.length) {
            toast('error', '目标位置冲突，已取消移动', pv.blocking.map((b) => `${b.code}: ${b.message}`).slice(0, 4));
          } else if (ops.length) {
            apply(ops, '移动');
          }
        }
        setPreview(null);
        break;
      }
      case 'resize': {
        // 松手确认：预览能算出来且没有 blocking 才写设计；否则 toast 解释原因。
        const ops: Op[] = [{ op: 'resize_board', id: d.boardId, columns: d.plan.columns, rows: d.plan.rows }];
        const pv = computeResizePreview(d.boardId, d.plan);
        const pb = model.boards.get(d.boardId);
        const shape = pb ? boardShape(pb.def) : null;
        const unchanged = shape && shape.columns === d.plan.columns && shape.rows === d.plan.rows;
        if (pv && !pv.blocking.length && !unchanged) {
          const r = apply(ops, `调整尺寸（${d.plan.columns} 列 × ${d.plan.rows} 行）`);
          if (r.ok) toast('success', `已调整为 ${d.plan.columns} 列 × ${d.plan.rows} 行`);
        } else if (pv && pv.blocking.length) {
          toast('error', '该尺寸会破坏已有连接，未应用', pv.blocking.map((b) => `${b.code}: ${b.message}`).slice(0, 4));
        } else if (!pv && !unchanged) {
          // 预览算不出来 = op 自己拒绝了（例如裁掉了仍被引用的孔位）。真的试一次，
          // 让 store 的错误提示带出具体孔号；失败不会写入任何东西。
          apply(ops, `调整尺寸（${d.plan.columns} 列 × ${d.plan.rows} 行）`);
        }
        setPreview(null);
        break;
      }
      case 'waypoint': {
        if (wpDrag) {
          const w = design.wires.find((x) => x.id === wpDrag.wireId);
          const rw = model.wires.get(wpDrag.wireId);
          if (w && rw) {
            const wps = rw.waypoints_um.map((q) => [q[0], q[1]] as PointUm);
            wps[wpDrag.index] = wpDrag.pos;
            apply([{ op: 'update_wire', id: w.id, patch: { waypoints_um: wps, path_mode: 'manual' } }], '调整拐点');
          }
        }
        setWpDrag(null);
        break;
      }
      case 'wire-end': {
        setEndDrag(null);
        if (d.moved) {
          const ep = wireEndTarget(e, d.wireId, d.end);
          if (ep) apply([{ op: 'update_wire', id: d.wireId, patch: d.end === 'from' ? { from: ep } : { to: ep } }], '改接导线');
        }
        break;
      }
    }
    setDrag({ kind: 'none' });
  }

  /**
   * 松手时把指针位置解析成这个端点要改接到的目标。返回 null 表示不改：拖回原地、
   * 松手在空白处、或者落点非法（非法情况由 endpointFromHit 说明原因）。
   */
  function wireEndTarget(e: { target: EventTarget | null; clientX: number; clientY: number }, wireId: string, end: WireEnd): WireEndpoint | null {
    const w = design.wires.find((x) => x.id === wireId);
    if (!w) return null;
    const own = end === 'from' ? w.from : w.to;
    const other = end === 'from' ? w.to : w.from;
    // pointer capture 会让 pointerup.target 永远是 SVG；elementFromPoint 才是松手处
    // 真正位于最上层的孔或板外端子。
    const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
    const h = hit({ ...e, target: dropTarget ?? e.target });
    // 导线画在孔上面，指针常常落在线上：按几何退回找下面的孔（与接线模式同一套）。
    let targetHit: { hole?: string; pin?: string } = h;
    if (!h.hole && !h.pin) {
      const global = toUm(toMm(e.clientX, e.clientY));
      for (const pb of model.boards.values()) {
        const hole = holeAtLocal(pb.resolved, toLocal(global, pb.transform), SNAP_UM);
        if (hole) {
          targetHit = { hole: `${pb.instance.id}.${hole.name}` };
          break;
        }
      }
    }
    // 几何回退以后再比较，才能正确识别被导线抓取圈遮住的原孔。
    // 拖回原来的孔/端子：当作没动过，别报"这个孔已经有线了"。
    if ((targetHit.hole !== undefined && targetHit.hole === own?.hole) || (targetHit.pin !== undefined && targetHit.pin === own?.terminal)) return null;
    if ((targetHit.hole !== undefined && targetHit.hole === other?.hole) || (targetHit.pin !== undefined && targetHit.pin === other?.terminal)) {
      toast('error', '同一根线的两端不能接在同一个孔或端子上');
      return null;
    }
    if (!targetHit.hole && !targetHit.pin) return null; // 松手在空白处 = 取消
    return endpointFromHit(targetHit);
  }

  function endpointFromHit(h: ReturnType<typeof hit>): WireEndpoint | null {
    if (h.hole) {
      const st = model.holes.get(h.hole);
      if (!st) return null;
      if (st.status === 'occupied') {
        const parsed = parseAddress(h.hole);
        if (parsed && isSolderableBoard(model, parsed.owner)) {
          if (st.wires.length) {
            toast('error', `焊盘 ${h.hole} 已插有导线 ${st.wires.join(', ')}`);
            return null;
          }
          return { hole: h.hole };
        }
        // clicking an inserted pin's hole: pick a free hole in the same group
        const alt = accessibleHolesForPin(model, st.component_id!, st.pin!)[0];
        if (!alt) {
          toast('error', `孔 ${h.hole} 被 ${st.component_id}.${st.pin} 占用，且同组没有空闲孔`);
          return null;
        }
        toast('info', `孔 ${h.hole} 被引脚占用，已改用同组空孔 ${alt}`);
        return { hole: alt };
      }
      if (st.status === 'blocked') {
        toast('error', `孔 ${h.hole} 被 ${st.component_id} 的板体遮挡，不能插线`);
        return null;
      }
      if (st.wires.length) {
        toast('error', `孔 ${h.hole} 已插有导线 ${st.wires.join(', ')}；一个孔只能插一根线`);
        return null;
      }
      return { hole: h.hole };
    }
    if (h.pin) {
      const parsed = parseAddress(h.pin)!;
      const pc = model.components.get(parsed.owner);
      const pin = pc?.pins.find((x) => x.name === parsed.name);
      if (!pc || !pin) return null;
      if (pin.hole) {
        if (isSolderableBoard(model, pin.hole.board_id)) return { hole: `${pin.hole.board_id}.${pin.hole.hole}` };
        const alt = accessibleHolesForPin(model, pc.instance.id, pin.name)[0];
        if (!alt) {
          toast('error', `引脚 ${h.pin} 所在孔组没有空闲孔可引出`);
          return null;
        }
        return { hole: alt };
      }
      return { terminal: h.pin };
    }
    return null;
  }

  function onClick(e: React.MouseEvent<SVGSVGElement>) {
    const h = hit(e);
    if (placing) {
      const pv = computePlacing(toMm(e.clientX, e.clientY));
      if (!pv) return;
      if (pv.blocking.length) {
        toast('error', '此处不能放置', pv.blocking.map((b) => `${b.code}: ${b.message}`).slice(0, 4));
        return;
      }
      const r = apply([pv.op], '放置元件');
      if (r.ok) {
        select([pv.id]);
        if (!e.shiftKey) cancelInteraction();
      }
      return;
    }
    if (tool === 'wire') {
      // A routed wire may visually pass over a hole. In wire mode, recover the
      // underlying board hole from the click position so it remains usable.
      let endpointHit = h;
      if (!h.hole && !h.pin) {
        const global = toUm(toMm(e.clientX, e.clientY));
        for (const pb of model.boards.values()) {
          const hole = holeAtLocal(pb.resolved, toLocal(global, pb.transform), SNAP_UM);
          if (hole) {
            endpointHit = { hole: `${pb.instance.id}.${hole.name}` };
            break;
          }
        }
      }
      const ep = endpointFromHit(endpointHit);
      if (!ep) return;
      if (!wireDraft) {
        setWireDraft({ from: ep });
        return;
      }
      const same = (a: WireEndpoint, b: WireEndpoint) => a.hole === b.hole && a.terminal === b.terminal;
      if (same(wireDraft.from, ep)) {
        toast('info', '起点和终点相同，请选择另一个孔或端子');
        return;
      }
      const r = apply([{ op: 'add_wire', wire: { from: wireDraft.from, to: ep, color: wireColorName, route: wireRoute } }], '接线');
      if (r.ok) {
        setWireDraft(null);
        const newId = r.changed[0];
        if (newId) select([newId]);
      }
    }
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    // pointer capture 会把 click/dblclick 的 target 重定向到 svg 本身（pointerdown
    // 时为了拖动调用过 setPointerCapture），所以这里必须按落点重新命中一次，
    // 否则 elementFromPoint 之前拿到的永远是 svg，板/拐点全部落空。
    const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
    const h = hit({ target: dropTarget ?? e.target, clientX: e.clientX, clientY: e.clientY });
    if (h.resizeHandle) return; // 把手双击不做事，避免误退出
    const boardId = h.board;
    if (boardId && tool === 'select' && !placing) {
      const pb = model.boards.get(boardId);
      if (!pb || pb.instance.locked || !canResizeBoard(pb.def)) {
        if (pb && pb.instance.locked) toast('error', `${boardId} 已锁定，先解锁再调整尺寸`);
        return;
      }
      // 双击进入/退出尺寸编辑（issue #22）
      setResizeEditId((cur) => (cur === boardId ? null : boardId));
      select([boardId]);
      return;
    }
    if (h.waypoint !== undefined && h.wire) {
      const rw = model.wires.get(h.wire);
      if (!rw) return;
      const wps = rw.waypoints_um.filter((_, i) => i !== h.waypoint).map((q) => [q[0], q[1]] as PointUm);
      apply([{ op: 'update_wire', id: h.wire, patch: { waypoints_um: wps, path_mode: 'manual' } }], '删除拐点');
      return;
    }
    if (h.wire && tool === 'select') {
      const rw = model.wires.get(h.wire);
      if (!rw || rw.points.length < 2) return;
      const p = toUm(toMm(e.clientX, e.clientY));
      // insert a waypoint on the nearest segment
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 1; i < rw.points.length; i++) {
        const a = rw.points[i - 1]!;
        const b = rw.points[i]!;
        const d = distToSegment(p, a, b);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      const wps = [...rw.points.slice(1, -1).map((q) => [q[0], q[1]] as PointUm)];
      wps.splice(bestI - 1, 0, p);
      apply([{ op: 'update_wire', id: h.wire, patch: { waypoints_um: wps, path_mode: 'manual' } }], '添加拐点');
      select([h.wire]);
    }
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (placing || wireDraft) cancelInteraction();
  }

  // ---- overlays -------------------------------------------------------------
  const overlays: React.ReactNode[] = [];
  if (preview && drag.kind === 'objects') {
    const invalid = preview.blocking.length > 0;
    const nodes: SceneNode[] = [];
    for (const id of drag.ids) {
      const pc = preview.model.components.get(id);
      if (pc) nodes.push(componentScene(pc, { showPinLabels: true, showUnverifiedBadges: false }));
      const pb = preview.model.boards.get(id);
      if (pb) nodes.push(boardScene(pb, preview.model, { showUnverifiedBadges: false }));
    }
    overlays.push(
      <g key="preview" className={`preview ${invalid ? 'preview-invalid' : 'preview-ok'}`} opacity={0.75} style={{ pointerEvents: 'none' }}>
        <SceneNodes nodes={nodes} />
        {drag.ids.map((id) => {
          const pc = preview.model.components.get(id);
          if (!pc) return null;
          return <rect key={id} x={mm(pc.bounds.x) - 0.6} y={mm(pc.bounds.y) - 0.6} width={mm(pc.bounds.w) + 1.2} height={mm(pc.bounds.h) + 1.2} fill="none" stroke={invalid ? '#dc2626' : '#16a34a'} strokeWidth={0.6} strokeDasharray="1.5 1" />;
        })}
        {invalid && (() => {
          const pc = preview.model.components.get(drag.ids[0]!);
          const pb = preview.model.boards.get(drag.ids[0]!);
          const b = pc?.bounds ?? pb?.bounds;
          if (!b) return null;
          return (
            <text className="overlay-bad" x={mm(b.x)} y={mm(b.y) - 2} fontSize={2.2} fontWeight="bold">
              ✕ {preview.blocking[0]!.code}
            </text>
          );
        })()}
      </g>
    );
  }
  if (placingPreview) {
    const pc = placingPreview.model.components.get(placingPreview.id)!;
    const invalid = placingPreview.blocking.length > 0;
    overlays.push(
      <g key="placing" opacity={0.8} style={{ pointerEvents: 'none' }}>
        {renderNode(componentScene(pc, { showPinLabels: true, showUnverifiedBadges: false }), 'placing')}
        <rect x={mm(pc.bounds.x) - 0.6} y={mm(pc.bounds.y) - 0.6} width={mm(pc.bounds.w) + 1.2} height={mm(pc.bounds.h) + 1.2} fill="none" stroke={invalid ? '#dc2626' : '#16a34a'} strokeWidth={0.6} strokeDasharray="1.5 1" />
        <text x={mm(pc.bounds.x)} y={mm(pc.bounds.y) - 2} fontSize={2.2} className={invalid ? 'overlay-bad' : 'overlay-good'} fontWeight="bold">
          {invalid ? `✕ ${placingPreview.blocking[0]!.code}` : pc.onBoard ? `放在 ${(pc.instance.placement as { board_id: string }).board_id}.${(pc.instance.placement as { anchor_hole: string }).anchor_hole}（R 旋转，Esc 取消）` : '板外放置（R 旋转，Esc 取消）'}
        </text>
      </g>
    );
  }
  if (wireDraft && cursorMm) {
    const ep = wireDraft.from;
    let start: PointUm | null = null;
    if (ep.hole) {
      const parsed = parseAddress(ep.hole)!;
      const pb = model.boards.get(parsed.owner);
      const hole = pb?.resolved.holes.get(parsed.name);
      if (pb && hole) start = toGlobal(hole.local_um, pb.transform);
    } else if (ep.terminal) {
      const parsed = parseAddress(ep.terminal)!;
      const pin = model.components.get(parsed.owner)?.pins.find((x) => x.name === parsed.name);
      if (pin) start = pin.global_um;
    }
    if (start) {
      overlays.push(
        <g key="draft" style={{ pointerEvents: 'none' }}>
          <polyline points={`${mm(start[0])},${mm(start[1])} ${mm(start[0])},${cursorMm[1]} ${cursorMm[0]},${cursorMm[1]}`} fill="none" stroke={wireColor(wireColorName)} strokeWidth={1} strokeDasharray="2 1" strokeLinecap="round" opacity={0.8} />
          <circle cx={mm(start[0])} cy={mm(start[1])} r={1} fill={wireColor(wireColorName)} stroke="#111" strokeWidth={0.2} />
          <text className="overlay-hint" x={cursorMm[0] + 2} y={cursorMm[1] - 2} fontSize={2}>
            起点 {ep.hole ?? ep.terminal} → 点击终点孔/端子（Esc 取消）
          </text>
        </g>
      );
    }
  }
  if (wpDrag) {
    const rw = model.wires.get(wpDrag.wireId);
    if (rw) {
      const pts = rw.points.map((q) => [q[0], q[1]] as PointUm);
      pts[wpDrag.index + 1] = wpDrag.pos;
      overlays.push(<polyline key="wp" points={pts.map((q) => `${mm(q[0])},${mm(q[1])}`).join(' ')} fill="none" stroke="#2563eb" strokeWidth={1} strokeDasharray="1.5 1" style={{ pointerEvents: 'none' }} />);
    }
  }
  if (endDrag) {
    const rw = model.wires.get(endDrag.wireId);
    if (rw && rw.points.length >= 2) {
      // from 画在第一个点上、to 画在最后一个点上，所以不动的那端在另一边。
      const anchor = endDrag.end === 'from' ? rw.points[rw.points.length - 1]! : rw.points[0]!;
      const cx = mm(endDrag.pos[0]);
      const cy = mm(endDrag.pos[1]);
      overlays.push(
        <g key="wire-end" style={{ pointerEvents: 'none' }}>
          <polyline points={`${mm(anchor[0])},${mm(anchor[1])} ${cx},${cy}`} fill="none" stroke={wireColor(rw.instance.color)} strokeWidth={0.9} strokeDasharray="2 1" strokeLinecap="round" opacity={0.9} />
          <circle cx={cx} cy={cy} r={1.4} fill="none" stroke="#2563eb" strokeWidth={0.35} strokeDasharray="0.9 0.7" />
          <text className="overlay-hint" x={cx + 2} y={cy - 2} fontSize={2}>
            松开改接到目标孔/端子（Esc 取消）
          </text>
        </g>
      );
    }
  }
  if (drag.kind === 'resize' && preview && !preview.blocking.length) {
    // 尺寸编辑预览：盖住旧板范围再画新板 —— 新板以同 position 派生，缩小裁剪时
    // 旧板的"多出来"的部分被遮住，视觉上就是那一下裁剪。
    const pbNew = preview.model.boards.get(drag.boardId);
    const pbOld = model.boards.get(drag.boardId);
    if (pbNew && pbOld) {
      // 遮盖半径 1.0mm：旧板的选中框是 bounds ±0.6mm、描边 0.5mm，盖 0.5mm 会
      // 露出外面小半圈虚线，看着像 bug。1.0mm 完全盖住，又不足以吃掉邻板的边。
      const ob = pbOld.bounds;
      overlays.push(
        <g key="resize-preview" style={{ pointerEvents: 'none' }}>
          <rect className="canvas-bg" x={mm(ob.x) - 1} y={mm(ob.y) - 1} width={mm(ob.w) + 2} height={mm(ob.h) + 2} fill="#eef0f4" />
          <SceneNodes nodes={[boardScene(pbNew, preview.model, { showUnverifiedBadges: false })]} />
          <text className="overlay-hint" x={mm(ob.x)} y={mm(ob.y) - 2.5} fontSize={2.2} fontWeight="bold">
            {drag.plan.columns} 列 × {drag.plan.rows} 行 · {(pbNew.bounds.w / 1000).toFixed(1)} × {(pbNew.bounds.h / 1000).toFixed(1)} mm（松开确认，Esc 取消）
          </text>
        </g>
      );
    }
  }
  if (drag.kind === 'resize' && (!preview || preview.blocking.length > 0)) {
    // 这个尺寸会裁掉仍被引用的孔位 / 让元件排针落到板外：明确说"不行"，别静默。
    const pb = model.boards.get(drag.boardId);
    if (pb) {
      overlays.push(
        <text key="resize-invalid" className="overlay-bad" x={mm(pb.bounds.x)} y={mm(pb.bounds.y) - 2.5} fontSize={2.2} fontWeight="bold" style={{ pointerEvents: 'none' }}>
          ✕ {drag.plan.columns} 列 × {drag.plan.rows} 行不可用：{preview?.blocking[0]?.message ?? '会裁掉仍被引用的孔位'}
        </text>
      );
    }
  }
  if (resizeEditId && drag.kind !== 'resize') {
    // 尺寸编辑模式：板右/下边缘各一个把手，拖动延长或裁剪。
    const pb = model.boards.get(resizeEditId);
    if (pb) {
      const [w, h] = pb.def.size_um;
      const rightMid = toGlobal([w, h / 2], pb.transform);
      const bottomMid = toGlobal([w / 2, h], pb.transform);
      const canRows = pb.def.terminal_blocks.length > 1;
      const handle = (cx: number, cy: number, axis: 'x' | 'y', testid: string) => (
        <rect
          key={axis}
          x={cx - 1.6} y={cy - 1.6} width={3.2} height={3.2} rx={0.5}
          className="resize-handle" data-resize-handle={axis} data-resize-board={pb.instance.id} data-testid={testid}
          style={{ cursor: axis === 'x' ? 'ew-resize' : 'ns-resize' }}
        />
      );
      overlays.push(
        <g key="resize-handles">
          {handle(mm(rightMid[0]), mm(rightMid[1]), 'x', `resize-handle-x-${pb.instance.id}`)}
          {canRows && handle(mm(bottomMid[0]), mm(bottomMid[1]), 'y', `resize-handle-y-${pb.instance.id}`)}
          <text className="overlay-hint" x={mm(pb.bounds.x)} y={mm(pb.bounds.y) - 2.5} fontSize={2.2} style={{ pointerEvents: 'none' }}>
            尺寸编辑：拖右/下边缘把手延长或裁剪（按孔距吸附），Esc 或再次双击退出
          </text>
        </g>
      );
    }
  }
  if (drag.kind === 'marquee') {
    const x = Math.min(drag.start[0], drag.current[0]);
    const y = Math.min(drag.start[1], drag.current[1]);
    overlays.push(<rect key="marquee" x={x} y={y} width={Math.abs(drag.current[0] - drag.start[0])} height={Math.abs(drag.current[1] - drag.start[1])} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={0.3} strokeDasharray="1 0.6" style={{ pointerEvents: 'none' }} />);
  }

  const cursor = drag.kind === 'pan' || tool === 'pan' ? 'grab' : tool === 'wire' || placing ? 'crosshair' : 'default';
  const draggingCls = drag.kind === 'objects' && drag.moved ? 'dragging' : '';

  return (
    <div className="canvas-wrap" data-testid="canvas">
      <svg
        ref={svgRef}
        className={`canvas ${draggingCls}`}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setCursorMm(null); cursorRef.current = null; }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <defs>
          <pattern id="grid" width={2.54 * view.z} height={2.54 * view.z} patternUnits="userSpaceOnUse" x={view.px} y={view.py}>
            <circle className="grid-dot" cx={0} cy={0} r={0.6} fill="#c7c9d1" />
          </pattern>
        </defs>
        <rect className="canvas-bg" width="100%" height="100%" fill="#eef0f4" />
        {view.z > 3 && <rect width="100%" height="100%" fill="url(#grid)" style={{ pointerEvents: 'none' }} />}
        <g transform={`translate(${view.px} ${view.py}) scale(${view.z}) rotate(${view.rot})${view.side === 'solder' ? ` translate(${2 * (scene.bounds.x + scene.bounds.w / 2)} 0) scale(-1 1)` : ''}`}>
          <g className={drag.kind === 'objects' && drag.moved ? 'scene scene-dim' : 'scene'}>
            <SceneNodes nodes={scene.nodes} />
          </g>
          {overlays}
          {/* Last painter wins `elementFromPoint`, so the simulator hit areas go after
              every other overlay; the component mounts only while a session executes. */}
          <SimulatorOverlay model={model} />
        </g>
      </svg>
      <div className="canvas-hud" data-testid="canvas-hud">
        <span>{Math.round(view.z * 100 / 6)}%</span>
        <span>{view.side === 'solder' ? '焊接面' : '元件面'}</span>
        {cursorMm && (
          <span>
            x {cursorMm[0].toFixed(1)} mm · y {cursorMm[1].toFixed(1)} mm
          </span>
        )}
        {selectedHole && <span>孔 {selectedHole}</span>}
      </div>
      {!design.boards.length && !placing && (
        <div className="canvas-empty">
          <p>画布是空的。</p>
          {/* The library only exists in 搭建, so 仿真 must not point at a panel that is not there. */}
          <p>{mode === 'build' ? '从左侧元件库添加一块面包板，或从“项目”菜单载入示例。' : '先切到“搭建”放置元件并接线，再回来运行。'}</p>
        </div>
      )}
    </div>
  );
}

/** The visually top-left header pin after rotation: the pin the cursor holds while placing. */

function nextComponentId(design: DesignDocument, model: string): string {
  const prefix = model.split('@')[0]!.replace(/_breakout$|_module$|_generic$/, '');
  const used = new Set([...design.boards, ...design.components, ...design.wires].map((o) => o.id));
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

function distToSegment(p: PointUm, a: PointUm, b: PointUm): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export { rotateVec, wireScene };
