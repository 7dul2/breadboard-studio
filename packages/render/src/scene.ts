/**
 * Shared scene builder: turns a DesignModel into drawing primitives in millimetres.
 * The editor renders the same primitives with React; the exporter serialises them to SVG.
 */
import type { RenderPrimitiveDef } from '@breadboard-studio/schema';
import { type DesignModel, type PlacedBoard, type PlacedComponent, type ResolvedWire, type Rect, toGlobal, type Transform } from '@breadboard-studio/core';

export type SceneNode =
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill?: string; stroke?: string; sw?: number; opacity?: number; dash?: string; cls?: string; data?: Record<string, string> }
  | { t: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; sw?: number; opacity?: number; cls?: string; data?: Record<string, string> }
  | { t: 'text'; x: number; y: number; text: string; size: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; rotate?: number; weight?: string; family?: string; cls?: string; opacity?: number; data?: Record<string, string> }
  | { t: 'path'; d: string; fill?: string; stroke?: string; sw?: number; cls?: string; opacity?: number; data?: Record<string, string> }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke?: string; sw?: number; cls?: string; dash?: string; opacity?: number; data?: Record<string, string> }
  | { t: 'polyline'; points: [number, number][]; stroke?: string; sw?: number; cls?: string; dash?: string; opacity?: number; linecap?: string; data?: Record<string, string> }
  | { t: 'group'; id?: string; transform?: string; cls?: string; opacity?: number; data?: Record<string, string>; children: SceneNode[] };

export interface SceneOptions {
  showHoleLabels?: boolean;
  showPinLabels?: boolean;
  /** Draw a visible badge on parts whose model is not verified. */
  showUnverifiedBadges?: boolean;
  /** Draw the ghost outline of upright modules as if unfolded. */
  showUprightGhost?: boolean;
  highlightHoles?: Set<string>;
  highlightPins?: Set<string>;
  highlightWires?: Set<string>;
  highlightComponents?: Set<string>;
  selectedIds?: Set<string>;
  /**
   * 当有东西被选中时，把没被高亮的导线压暗，只留下关心的那几根。
   * 由调用方决定什么时候开（一般 = 有选中项 且 用户没关掉这个开关）。
   */
  dimUnhighlighted?: boolean;
}

export const mm = (um: number): number => Math.round(um / 10) / 100;

export const WIRE_COLORS: Record<string, string> = {
  red: '#dc2626',
  black: '#111827',
  blue: '#2563eb',
  yellow: '#eab308',
  green: '#16a34a',
  white: '#e5e7eb',
  orange: '#f97316',
  purple: '#7c3aed',
  brown: '#92400e',
  gray: '#6b7280',
  grey: '#6b7280',
  cyan: '#06b6d4',
  pink: '#ec4899'
};

export function wireColor(c: string): string {
  return WIRE_COLORS[c] ?? (c.startsWith('#') ? c : '#dc2626');
}

/**
 * Group transform for one placed object, in millimetres. Exported because the
 * simulator overlay (apps/web §9.2) has to draw into the exact same local frame
 * as `componentScene`, so definition-local feature rects land on the part.
 */
export function transformAttr(t: Transform): string {
  return `translate(${mm(t.position[0])} ${mm(t.position[1])}) rotate(${t.rotation})`;
}

/** One definition drawing primitive (µm) as a scene node (mm). */
export function primitiveToNode(p: RenderPrimitiveDef): SceneNode {
  switch (p.t) {
    case 'rect':
      return { t: 'rect', x: mm(p.x), y: mm(p.y), w: mm(p.w), h: mm(p.h), rx: p.rx !== undefined ? mm(p.rx) : undefined, fill: p.fill, stroke: p.stroke, sw: p.sw !== undefined ? mm(p.sw) : undefined, opacity: p.opacity };
    case 'circle':
      return { t: 'circle', cx: mm(p.cx), cy: mm(p.cy), r: mm(p.r), fill: p.fill, stroke: p.stroke, sw: p.sw !== undefined ? mm(p.sw) : undefined };
    case 'text':
      return { t: 'text', x: mm(p.x), y: mm(p.y), text: p.text, size: mm(p.size), fill: p.fill, anchor: p.anchor, rotate: p.rotate, weight: p.weight };
    case 'line':
      return { t: 'line', x1: mm(p.x1), y1: mm(p.y1), x2: mm(p.x2), y2: mm(p.y2), stroke: p.stroke, sw: p.sw !== undefined ? mm(p.sw) : undefined };
    case 'path':
      return { t: 'path', d: p.d, fill: p.fill, stroke: p.stroke, sw: p.sw !== undefined ? mm(p.sw) : undefined };
  }
}

const HOLE_R = 0.5;

export function boardScene(pb: PlacedBoard, model: DesignModel, opts: SceneOptions): SceneNode {
  const def = pb.def;
  const rb = pb.resolved;
  const children: SceneNode[] = [];
  const w = mm(def.size_um[0]);
  const h = mm(def.size_um[1]);
  children.push({ t: 'rect', x: 0, y: 0, w, h, rx: mm(def.render.corner_radius_um ?? 1000), fill: def.render.body_color, stroke: def.render.edge_color ?? '#b8b4a6', sw: 0.3, cls: 'board-body', data: { board: pb.instance.id } });
  for (const rv of def.ravines) {
    children.push({ t: 'rect', x: mm(rv.x_um), y: mm(rv.y_um), w: mm(rv.w_um), h: mm(rv.h_um), fill: '#d9d5c7', stroke: '#c1bcab', sw: 0.15, cls: 'board-ravine' });
  }
  // rail markings
  for (const rail of def.rails) {
    const first = rb.holes.get(`${rail.id}_1`)!;
    const last = rb.holes.get(`${rail.id}_${rail.holes}`)!;
    const y = mm(rail.origin_um[1]) + (rail.marking_side === 'above' ? -1.6 : 1.6);
    if (rail.marking !== 'none') {
      children.push({ t: 'line', x1: mm(first.local_um[0]) - 1.5, y1: y, x2: mm(last.local_um[0]) + 1.5, y2: y, stroke: rail.marking_color, sw: 0.35, cls: 'rail-mark' });
      children.push({ t: 'text', x: mm(first.local_um[0]) - 3.2, y: y + 0.8, text: rail.marking, size: 2.2, fill: rail.marking_color, anchor: 'middle', weight: 'bold', cls: 'rail-mark' });
      children.push({ t: 'text', x: mm(last.local_um[0]) + 3.2, y: y + 0.8, text: rail.marking, size: 2.2, fill: rail.marking_color, anchor: 'middle', weight: 'bold', cls: 'rail-mark' });
    }
    // rail breaks
    for (let i = 1; i < rail.segments.length; i++) {
      const endHole = rb.holes.get(`${rail.id}_${rail.segments[i - 1]![1]}`)!;
      const startHole = rb.holes.get(`${rail.id}_${rail.segments[i]![0]}`)!;
      const x = (mm(endHole.local_um[0]) + mm(startHole.local_um[0])) / 2;
      children.push({ t: 'line', x1: x, y1: mm(rail.origin_um[1]) - 1.3, x2: x, y2: mm(rail.origin_um[1]) + 1.3, stroke: '#7c2d12', sw: 0.35, cls: 'rail-break' });
      children.push({ t: 'text', x, y: mm(rail.origin_um[1]) + (rail.marking_side === 'above' ? 3.2 : -2.2), text: '断', size: 1.4, fill: '#7c2d12', anchor: 'middle', cls: 'rail-break' });
    }
  }
  // row/column labels
  for (const block of def.terminal_blocks) {
    const firstRowY = mm(block.origin_um[1]);
    for (let c = 0; c < block.columns; c++) {
      const col = block.first_column + c;
      if (col === 1 || col % 5 === 0) {
        const x = mm(block.origin_um[0] + c * def.pitch_um);
        const isTopBlock = block === def.terminal_blocks[0];
        children.push({ t: 'text', x, y: isTopBlock ? firstRowY - 2.3 : firstRowY + (block.rows.length - 1) * mm(def.pitch_um) + 3.4, text: String(col), size: 1.7, fill: def.render.label_color ?? '#6b6b6b', anchor: 'middle', cls: 'board-label' });
      }
    }
    for (let r = 0; r < block.rows.length; r++) {
      const y = firstRowY + r * mm(def.pitch_um) + 0.6;
      children.push({ t: 'text', x: mm(block.origin_um[0]) - 2.6, y, text: block.rows[r]!, size: 1.7, fill: def.render.label_color ?? '#6b6b6b', anchor: 'middle', cls: 'board-label' });
      children.push({ t: 'text', x: mm(block.origin_um[0] + (block.columns - 1) * def.pitch_um) + 2.6, y, text: block.rows[r]!, size: 1.7, fill: def.render.label_color ?? '#6b6b6b', anchor: 'middle', cls: 'board-label' });
    }
  }
  // holes
  const holeNodes: SceneNode[] = [];
  for (const hole of rb.holes.values()) {
    const addr = `${pb.instance.id}.${hole.name}`;
    const st = model.holes.get(addr);
    const hl = opts.highlightHoles?.has(addr);
    let fill = def.render.hole_color ?? '#3b3b3b';
    let stroke: string | undefined;
    let sw: number | undefined;
    if (st?.status === 'blocked') fill = '#9ca3af';
    if (hl) {
      stroke = '#f59e0b';
      sw = 0.45;
    }
    holeNodes.push({ t: 'circle', cx: mm(hole.local_um[0]), cy: mm(hole.local_um[1]), r: hl ? HOLE_R + 0.35 : HOLE_R, fill, stroke, sw, cls: `hole hole-${st?.status ?? 'free'}`, data: { hole: addr } });
    if (opts.showHoleLabels && hole.kind === 'terminal') {
      holeNodes.push({ t: 'text', x: mm(hole.local_um[0]), y: mm(hole.local_um[1]) - 0.75, text: hole.name, size: 0.75, fill: '#6b7280', anchor: 'middle', cls: 'hole-label' });
    }
  }
  children.push({ t: 'group', cls: 'holes', children: holeNodes });
  const name = pb.instance.name ?? pb.instance.id;
  children.push({ t: 'text', x: 2, y: h - 1.2, text: `${name} · ${def.name}`, size: 1.6, fill: '#8a8577', anchor: 'start', cls: 'board-name' });
  const selected = opts.selectedIds?.has(pb.instance.id);
  if (selected) children.push({ t: 'rect', x: -0.6, y: -0.6, w: w + 1.2, h: h + 1.2, fill: 'none', stroke: '#2563eb', sw: 0.5, dash: '1.5 1', cls: 'selection' });
  if (pb.instance.locked) children.push({ t: 'text', x: w - 2, y: h - 1.2, text: '🔒', size: 2, anchor: 'end', cls: 'lock' });
  return { t: 'group', id: `board:${pb.instance.id}`, transform: transformAttr(pb.transform), cls: 'board', data: { board: pb.instance.id }, children };
}

function statusShort(s: string): string {
  return s === 'approximate' ? '近似' : s === 'unknown' ? '未知' : '';
}

function statusText(geo: string, elec: string): string {
  return `${geo === 'verified' ? '' : '几何' + statusShort(geo)} ${elec === 'verified' ? '' : '电气' + statusShort(elec)}`.trim();
}

function badge(x: number, y: number, text: string, anchor: 'start' | 'end', target?: string): SceneNode {
  const w = text.length * 1.35 + 2;
  const bx = anchor === 'end' ? x - w : x;
  return {
    t: 'group',
    cls: 'badge',
    data: target ? { badge: target } : undefined,
    children: [
      { t: 'rect', x: bx, y: y - 0.2, w, h: 2.4, rx: 0.5, fill: '#fef3c7', stroke: '#d97706', sw: 0.2 },
      { t: 'text', x: bx + 1, y: y + 1.5, text: `⚠ ${text}`, size: 1.4, fill: '#92400e', anchor: 'start' }
    ]
  };
}

export function componentScene(pc: PlacedComponent, opts: SceneOptions): SceneNode {
  const rc = pc.resolved;
  const children: SceneNode[] = [];
  const outline = rc.outline;
  const upright = rc.orientation === 'upright';
  const selected = opts.selectedIds?.has(pc.instance.id);
  const hl = opts.highlightComponents?.has(pc.instance.id);
  if (upright) {
    // Ghost of the module face (as if unfolded) + solid pin strip footprint.
    if (opts.showUprightGhost !== false) {
      children.push({ t: 'group', opacity: 0.28, cls: 'upright-ghost', children: rc.render.map(primitiveToNode) });
      children.push({ t: 'rect', x: mm(outline.x), y: mm(outline.y), w: mm(outline.w), h: mm(outline.h), fill: 'none', stroke: '#475569', sw: 0.25, dash: '1 0.8', cls: 'upright-ghost' });
    }
    const f = rc.footprint;
    children.push({ t: 'rect', x: mm(f.x), y: mm(f.y), w: mm(f.w), h: mm(f.h), rx: 0.3, fill: '#1e3a5f', stroke: '#0f172a', sw: 0.2, cls: 'component-body', data: { component: pc.instance.id } });
    const label = `${pc.instance.name ?? pc.instance.id}（立式）`;
    const lx = mm(f.x + f.w / 2);
    const ly = mm(f.y) - 1.2;
    children.push({ t: 'text', x: lx, y: ly, text: label, size: 1.5, fill: '#0f172a', anchor: 'middle', weight: 'bold', cls: 'component-name' });
  } else {
    children.push(...rc.render.map(primitiveToNode));
    if (!rc.render.length) {
      children.push({ t: 'rect', x: mm(outline.x), y: mm(outline.y), w: mm(outline.w), h: mm(outline.h), rx: 0.5, fill: '#cbd5e1', stroke: '#334155', sw: 0.2, cls: 'component-body' });
    }
    // Invisible hit target covering the body for selection/drag.
    children.push({ t: 'rect', x: mm(outline.x), y: mm(outline.y), w: mm(outline.w), h: mm(outline.h), fill: 'transparent', stroke: 'none', cls: 'component-hit', data: { component: pc.instance.id } });
    children.push({ t: 'text', x: mm(outline.x + outline.w / 2), y: mm(outline.y) - 0.9, text: pc.instance.name ?? pc.instance.id, size: 1.6, fill: '#0f172a', anchor: 'middle', weight: 'bold', cls: 'component-name' });
  }
  // pins
  for (const pin of pc.pins) {
    const [x, y] = [mm(pin.local_um[0]), mm(pin.local_um[1])];
    const header = pin.kind === 'header';
    const pinAddr = `${pc.instance.id}.${pin.name}`;
    const pinHl = opts.highlightPins?.has(pinAddr);
    if (pinHl) children.push({ t: 'circle', cx: x, cy: y, r: 1.5, fill: '#fde68a', stroke: '#f59e0b', sw: 0.35, cls: 'pin-highlight' });
    const pinRender = header ? pc.def.pin_render : undefined;
    const pinSize = mm(pinRender?.size_um ?? 1400);
    if (pinRender?.shape === 'circle') {
      children.push({ t: 'circle', cx: x, cy: y, r: pinSize / 2, fill: pinRender.fill ?? '#d4af37', stroke: pinRender.stroke ?? '#4b5563', sw: mm(pinRender.stroke_width_um ?? 150), cls: `pin pin-${pin.kind}`, data: { pin: pinAddr } });
      if (pinRender.hole_fill && (pinRender.hole_size_um ?? 0) > 0) {
        children.push({ t: 'circle', cx: x, cy: y, r: mm(pinRender.hole_size_um!) / 2, fill: pinRender.hole_fill, cls: 'pin-hole' });
      }
    } else {
      children.push({ t: 'rect', x: x - pinSize / 2, y: y - pinSize / 2, w: pinSize, h: pinSize, fill: pinRender?.fill ?? (header ? '#d4af37' : '#e5e7eb'), stroke: pinRender?.stroke ?? '#4b5563', sw: mm(pinRender?.stroke_width_um ?? 150), cls: `pin pin-${pin.kind}`, data: { pin: pinAddr } });
      if (!header) children.push({ t: 'circle', cx: x, cy: y, r: 0.35, fill: '#374151', cls: 'pin-terminal-dot' });
    }
    if (opts.showPinLabels !== false && pinRender?.show_labels !== false) {
      const inside = rc.outline;
      const cx = inside.x + inside.w / 2;
      const cy = inside.y + inside.h / 2;
      const dx = pin.local_um[0] - cx;
      const dy = pin.local_um[1] - cy;
      const horizontal = Math.abs(dx) * inside.h > Math.abs(dy) * inside.w; // pin near left/right edge
      let tx = x;
      let ty = y + 0.5;
      let anchor: 'start' | 'middle' | 'end' = 'middle';
      let rotate = 0;
      if (horizontal) {
        anchor = dx < 0 ? 'start' : 'end';
        tx = dx < 0 ? x + 1.2 : x - 1.2;
      } else {
        rotate = -90;
        anchor = dy < 0 ? 'end' : 'start';
        ty = dy < 0 ? y - 1.2 : y + 1.2;
      }
      children.push({ t: 'text', x: tx, y: ty, text: pin.name, size: 1.1, fill: upright ? '#0f172a' : '#f8fafc', anchor, rotate, cls: 'pin-label', family: 'monospace' });
    }
  }
  if (selected || hl) {
    children.push({ t: 'rect', x: mm(outline.x) - 0.6, y: mm(outline.y) - 0.6, w: mm(outline.w) + 1.2, h: mm(outline.h) + 1.2, fill: 'none', stroke: selected ? '#2563eb' : '#f59e0b', sw: 0.5, dash: selected ? '1.5 1' : undefined, cls: 'selection' });
  }
  if (pc.instance.locked) children.push({ t: 'text', x: mm(outline.x + outline.w) - 1, y: mm(outline.y) + 2.2, text: '🔒', size: 2, anchor: 'end', cls: 'lock' });
  return { t: 'group', id: `component:${pc.instance.id}`, transform: transformAttr(pc.transform), cls: `component ${pc.onBoard ? 'on-board' : 'off-board'}`, data: { component: pc.instance.id }, children };
}

export function wireScene(rw: ResolvedWire, index: number, opts: SceneOptions): SceneNode {
  const w = rw.instance;
  const pts = rw.points.map((p) => [mm(p[0]), mm(p[1])] as [number, number]);
  const color = wireColor(w.color);
  const selected = opts.selectedIds?.has(w.id);
  const hl = opts.highlightWires?.has(w.id);
  const children: SceneNode[] = [];
  if (pts.length >= 2) {
    if (selected || hl) children.push({ t: 'polyline', points: pts, stroke: selected ? '#2563eb' : '#f59e0b', sw: 2.2, opacity: 0.5, linecap: 'round', cls: 'wire-halo' });
    children.push({ t: 'polyline', points: pts, stroke: '#111827', sw: 1.35, opacity: 0.35, linecap: 'round', cls: 'wire-shadow' });
    children.push({ t: 'polyline', points: pts, stroke: color, sw: 1.0, linecap: 'round', dash: w.route === 'elevated' ? '2.2 1.1' : undefined, cls: `wire wire-${w.route}`, data: { wire: w.id } });
    if (w.color === 'white' || w.color === 'yellow') children.push({ t: 'polyline', points: pts, stroke: '#9ca3af', sw: 0.15, cls: 'wire-outline', data: { wire: w.id } });
    // 两端的「插头」。可见的小圆照旧只是装饰（CSS 里 pointer-events: none），
    // 叠在下面的透明抓取圈才是拖拽改接的落点：把一根已经插好的线的端点
    // 拖到别的孔/端子上，不必先删线重画。见 Canvas 的 wire-end 拖拽。
    for (const [end, p] of [
      ['from', pts[0]!],
      ['to', pts[pts.length - 1]!]
    ] as Array<['from' | 'to', [number, number]]>) {
      children.push({ t: 'circle', cx: p[0], cy: p[1], r: 1.4, fill: 'transparent', cls: 'wire-end-hit', data: { wire: w.id, end } });
      children.push({ t: 'circle', cx: p[0], cy: p[1], r: 0.75, fill: color, stroke: '#111827', sw: 0.2, cls: 'wire-end', data: { wire: w.id, end } });
    }
    // number label at the mid-point of the longest segment
    let best = 0;
    let bi = 1;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    const mx = (pts[bi]![0] + pts[bi - 1]![0]) / 2;
    const my = (pts[bi]![1] + pts[bi - 1]![1]) / 2;
    children.push({ t: 'circle', cx: mx, cy: my, r: 1.35, fill: '#ffffff', stroke: color, sw: 0.3, cls: 'wire-tag' });
    children.push({ t: 'text', x: mx, y: my + 0.55, text: String(index), size: 1.5, fill: '#111827', anchor: 'middle', weight: 'bold', cls: 'wire-tag', family: 'monospace' });
  } else if (pts.length === 1) {
    children.push({ t: 'circle', cx: pts[0]![0], cy: pts[0]![1], r: 0.9, fill: color, stroke: '#111827', sw: 0.2, cls: 'wire-draft' });
  }
  if (selected && w.path_mode === 'manual') {
    for (const [i, p] of rw.waypoints_um.entries()) {
      children.push({ t: 'rect', x: mm(p[0]) - 0.8, y: mm(p[1]) - 0.8, w: 1.6, h: 1.6, fill: '#ffffff', stroke: '#2563eb', sw: 0.3, cls: 'waypoint', data: { wire: w.id, waypoint: String(i) } });
    }
  }
  // 聚焦模式：没被高亮也没被选中的导线整体压暗（连编号一起淡掉）
  const dimmed = Boolean(opts.dimUnhighlighted) && !hl && !selected;
  return { t: 'group', id: `wire:${w.id}`, cls: `wire-group${dimmed ? ' wire-dimmed' : ''}`, data: { wire: w.id }, opacity: dimmed ? 0.16 : undefined, children };
}

export interface Scene {
  nodes: SceneNode[];
  /** Scene bounds in mm. */
  bounds: { x: number; y: number; w: number; h: number };
}

export function buildScene(model: DesignModel, opts: SceneOptions = {}): Scene {
  const nodes: SceneNode[] = [];
  for (const pb of model.boards.values()) nodes.push(boardScene(pb, model, opts));
  const comps = [...model.components.values()];
  for (const pc of comps) nodes.push(componentScene(pc, opts));
  const wires = [...model.wires.values()].sort((a, b) => a.instance.id.localeCompare(b.instance.id, undefined, { numeric: true }));
  wires.forEach((rw, i) => nodes.push(wireScene(rw, i + 1, opts)));
  // Badges and hints live in an unrotated global layer so text stays readable.
  const annotations: SceneNode[] = [];
  if (opts.showUnverifiedBadges !== false) {
    for (const pb of model.boards.values()) {
      const text = statusText(pb.def.geometry_status, pb.def.electrical_status);
      if (text) annotations.push(badge(mm(pb.bounds.x + pb.bounds.w) - 1.5, mm(pb.bounds.y) + 1, text, 'end', pb.instance.id));
    }
    for (const pc of comps) {
      const text = statusText(pc.def.geometry_status, pc.def.electrical_status);
      if (text) annotations.push(badge(mm(pc.bounds.x), mm(pc.bounds.y + pc.bounds.h) + 0.8, text, 'start', pc.instance.id));
    }
  }
  for (const pc of comps) {
    if (!pc.onBoard) {
      annotations.push({ t: 'text', x: mm(pc.bounds.x + pc.bounds.w / 2), y: mm(pc.bounds.y + pc.bounds.h) + 5.4, text: '板外器件：仅通过线缆连接端子', size: 1.5, fill: '#6b21a8', anchor: 'middle', cls: 'offboard-hint' });
    }
  }
  nodes.push({ t: 'group', cls: 'annotations', children: annotations });
  const b: Rect = model.bounds ?? { x: 0, y: 0, w: 100000, h: 60000 };
  return { nodes, bounds: { x: mm(b.x), y: mm(b.y), w: mm(b.w), h: mm(b.h) } };
}

export function pinGlobalMm(pc: PlacedComponent, pinName: string): [number, number] | null {
  const p = pc.pins.find((x) => x.name === pinName);
  if (!p) return null;
  return [mm(p.global_um[0]), mm(p.global_um[1])];
}

export { toGlobal };
