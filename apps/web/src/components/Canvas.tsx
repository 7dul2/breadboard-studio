import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesignDocument, PointUm, Placement, WireEndpoint } from '@breadboard-studio/schema';
import { builtinCatalog } from '@breadboard-studio/catalog';
import {
  accessibleHolesForPin,
  applyOps,
  buildModel,
  catalogForDesign,
  conductiveSet,
  groupHoles,
  holeAtLocal,
  parseAddress,
  resolveComponent,
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

type DragMode =
  | { kind: 'none' }
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: [number, number]; current: [number, number] }
  | { kind: 'objects'; ids: string[]; startMm: [number, number]; moved: boolean; pointerId: number }
  | { kind: 'waypoint'; wireId: string; index: number; pointerId: number };

interface Preview {
  ops: Op[];
  design: DesignDocument;
  model: DesignModel;
  blocking: RuleResult[];
}


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
  const [view, setView] = useState<View>({ z: 6, px: 40, py: 40, rot: 0 });
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
  const spaceRef = useRef(false);

  const catalog = useMemo(() => catalogForDesign(design, builtinCatalog()), [design]);
  const model = analysis.model;

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
        for (const ep of [rw.from, rw.to]) {
          if (!ep) continue;
          if (ep.kind === 'hole') {
            holes.add(ep.address);
            // 选中一根线时，把两端各自"插到谁身上"一并点亮 —— 这是"不知道接到哪里"的答案。
            for (const h of groupHoles(model, ep.address)) {
              const owner = pinAtHole.get(h);
              if (owner) {
                pins.add(owner.pin);
                comps.add(owner.comp);
                break;
              }
            }
          } else pins.add(ep.address);
        }
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
    if (wiringGuide) {
      const steps = [...model.wires.values()].sort((a, b) => a.instance.id.localeCompare(b.instance.id, undefined, { numeric: true }));
      const cur = steps[buildStep];
      if (cur) {
        wires.add(cur.instance.id);
        for (const ep of [cur.from, cur.to]) {
          if (!ep) continue;
          if (ep.kind === 'hole') holes.add(ep.address);
          else pins.add(ep.address);
        }
      }
    }
    return { holes, pins, wires, comps };
  }, [selectedHole, selectedIds, highlightEndpoints, model, analysis, connectivityHighlight, wiringGuide, buildStep, pinAtHole]);

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
        selectedIds: new Set(selectedIds),
        // 有选中项时才压暗，否则整张图会一直是灰的
        dimUnhighlighted: dimUnhighlighted && (selectedIds.length > 0 || Boolean(selectedHole))
      }),
    [model, showHoleLabels, showPinLabels, highlight, selectedIds, selectedHole, dimUnhighlighted]
  );

  // ---- coordinate helpers ---------------------------------------------------
  const toMm = useCallback((clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const v = viewRef.current;
    const dx = (clientX - r.left - v.px) / v.z;
    const dy = (clientY - r.top - v.py) / v.z;
    if (!v.rot) return [dx, dy];
    // 视图转过角度，屏幕坐标要反向转回去才是设计坐标（R⁻¹ = Rᵀ）
    const rad = (v.rot * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return [dx * c + dy * s, -dx * s + dy * c];
  }, []);
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
    setView({ z, px, py, rot });
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
        setView({ z, px: cx - (cx - v.px) * k, py: cy - (cy - v.py) * k, rot: v.rot });
      } else {
        setView({ ...v, px: v.px - e.deltaX, py: v.py - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
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
  }, []);

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
        setView({ z, px: cx - (cx - v.px) * k, py: cy - (cy - v.py) * k, rot: v.rot });
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
        setView({ z, px: r.width / 2 - cx * z, py: r.height / 2 - cy * z, rot });
      },
      // Paste needs to know where the pointer is; the store has no view transform.
      cursorUm: (): PointUm | null => {
        const c = cursorRef.current;
        return c ? [Math.round(c[0] * 1000), Math.round(c[1] * 1000)] : null;
      }
    };
  }, [fit]);

  // ---- hit testing ----------------------------------------------------------
  function hit(e: { target: EventTarget | null; clientX: number; clientY: number }): { hole?: string; pin?: string; component?: string; board?: string; wire?: string; waypoint?: number; badge?: string } {
    const el = e.target as Element | null;
    if (!el || !(el instanceof Element)) return {};
    const wp = el.closest('[data-waypoint]') as HTMLElement | null;
    if (wp) return { wire: wp.dataset.wire, waypoint: Number(wp.dataset.waypoint) };
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
        ops.push({ op: 'move_board', id, position_um: ids.length === 1 ? snapBoardPosition(model, id, deltaUm) : [model.boards.get(id)!.transform.position[0] + deltaUm[0], model.boards.get(id)!.transform.position[1] + deltaUm[1]] });
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
    if (h.waypoint !== undefined && h.wire) {
      if (!canEdit) return;
      svg.setPointerCapture(e.pointerId);
      setDrag({ kind: 'waypoint', wireId: h.wire, index: h.waypoint, pointerId: e.pointerId });
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
    }
    setDrag({ kind: 'none' });
  }

  function endpointFromHit(h: ReturnType<typeof hit>): WireEndpoint | null {
    if (h.hole) {
      const st = model.holes.get(h.hole);
      if (!st) return null;
      if (st.status === 'occupied') {
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
    const h = hit(e);
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
            <text x={mm(b.x)} y={mm(b.y) - 2} fontSize={2.2} fill="#dc2626" fontWeight="bold">
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
        <text x={mm(pc.bounds.x)} y={mm(pc.bounds.y) - 2} fontSize={2.2} fill={invalid ? '#dc2626' : '#166534'} fontWeight="bold">
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
          <text x={cursorMm[0] + 2} y={cursorMm[1] - 2} fontSize={2} fill="#1f2937">
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
            <circle cx={0} cy={0} r={0.6} fill="#c7c9d1" />
          </pattern>
        </defs>
        <rect className="canvas-bg" width="100%" height="100%" fill="#eef0f4" />
        {view.z > 3 && <rect width="100%" height="100%" fill="url(#grid)" style={{ pointerEvents: 'none' }} />}
        <g transform={`translate(${view.px} ${view.py}) scale(${view.z}) rotate(${view.rot})`}>
          <g className={drag.kind === 'objects' && drag.moved ? 'scene scene-dim' : 'scene'}>
            <SceneNodes nodes={scene.nodes} />
          </g>
          {overlays}
          {/* Last painter wins `elementFromPoint`, so the simulator hit areas go after
              every other overlay; the component mounts only while a session executes. */}
          <SimulatorOverlay model={model} />
        </g>
      </svg>
      <div className="canvas-hud">
        <span>{Math.round(view.z * 100 / 6)}%</span>
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
