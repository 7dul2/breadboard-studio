/**
 * 3D 预览的**纯几何规划**：把 DesignModel 翻成"盒子 / 圆柱 / 管"的清单。
 *
 * 刻意和 three.js 分开：这一层不碰 WebGL，所以能单测；渲染层只负责把清单变成
 * Mesh。数据本来就够用 —— 每份定义里都有 body.size_um / height_um / render 图元，
 * 板子有 size_um / ravines / rails，导线有折线点，所以 3D 是**自动生成**的，
 * 不需要给每个元件手搓模型。
 *
 * 坐标约定：设计坐标 (x, y) [mm] → three 的 (x, y_向上, z)，即板面是 XZ 平面、
 * 板的上表面在 y = 0，元件往上长。单位就是毫米，相机 near/far 按毫米给。
 */
import type { ComponentDefinition, PointUm } from '@breadboard-studio/schema';
import type { DesignModel, PlacedBoard, PlacedComponent, Rect, ResolvedWire, Transform } from '@breadboard-studio/core';
import { wireColor } from '@breadboard-studio/render';

/** 面包板厚度（实物 MB-102 约 8.5–10 mm）。 */
export const BOARD_THICKNESS_MM = 8.5;
export const HOLE_RADIUS_MM = 0.55;
export const PIN_RADIUS_MM = 0.32;
export const PIN_HEIGHT_MM = 1.6;
export const WIRE_RADIUS_MM = 0.6;
/** 立式模块的板厚（PCB）。 */
const UPRIGHT_PCB_MM = 1.8;

export type Prim3DGroup = 'board' | 'ravine' | 'rail' | 'component' | 'art' | 'wire';

export type Prim3D =
  | { kind: 'box'; key: string; group: Prim3DGroup; center: [number, number, number]; size: [number, number, number]; color: string; rotateY: number; opacity?: number }
  | { kind: 'tube'; key: string; group: Prim3DGroup; points: [number, number, number][]; radius: number; color: string };

export interface Hole3D {
  x: number;
  z: number;
  r: number;
}
export interface Pin3D {
  x: number;
  z: number;
  r: number;
  h: number;
  color: string;
  /** 它属于哪个元件（后面做点选要用）。 */
  component: string;
}

export interface Scene3D {
  prims: Prim3D[];
  holes: Hole3D[];
  pins: Pin3D[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  stats: { boards: number; components: number; wires: number; holes: number; pins: number; boxes: number; tubes: number };
}

const mm = (um: number): number => Math.round(um / 10) / 100;

/** 设计局部坐标（µm）→ 全局 mm（含元件的平移与旋转）。 */
function worldPoint(p: PointUm, t: Transform): [number, number] {
  const rad = (t.rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [mm(t.position[0] + p[0] * c - p[1] * s), mm(t.position[1] + p[0] * s + p[1] * c)];
}

/** 设计里的旋转角 → three 绕 y 轴的角（设计 y 映射到 three 的 z，手性相反）。 */
const yawOf = (rotationDeg: number): number => (-rotationDeg * Math.PI) / 180;

const rectCenter = (r: Rect): PointUm => [r.x + r.w / 2, r.y + r.h / 2];

/** 元件本体的代表色：取面积最大的那个带填充的 rect（PCB 底色）。 */
export function dominantFill(def: ComponentDefinition): string {
  let best: { area: number; fill: string } | null = null;
  for (const p of def.render) {
    if (p.t !== 'rect' || !p.fill) continue;
    const area = p.w * p.h;
    if (!best || area > best.area) best = { area, fill: p.fill };
  }
  return best?.fill ?? '#334155';
}

/** 折线每个顶点的弧长占比（0..1），用来给导线做拱形。 */
export function arcFactors(points: [number, number][]): number[] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    seg.push(d);
    total += d;
  }
  if (total <= 0) return points.map(() => 0);
  const out = [0];
  let acc = 0;
  for (const d of seg) out.push((acc += d) / total);
  return out;
}

/** 按弧长把折线打密（保留原始拐点）。 */
export function densify(points: [number, number][], stepMm = 4): [number, number][] {
  if (points.length < 2) return points;
  const out: [number, number][] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(d / stepMm));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/**
 * 导线在 3D 里的路径：两端落在板面，中间按弧长拱起来（跳线本来就该拱着）。
 *
 * 先打密再套高度包络 —— 只有两个点的直线不细分的话，拱形会塌成一条贴在板面上的
 * 零高度线，管就会埋进板子里。
 */
export function wirePath3D(pointsMm: [number, number][], heightMm: number): [number, number, number][] {
  const dense = densify(pointsMm);
  const f = arcFactors(dense);
  return dense.map((p, i) => [p[0], Math.sin(Math.PI * (f[i] ?? 0)) * heightMm, p[1]]);
}

function boardPrims(pb: PlacedBoard, holes: Hole3D[]): Prim3D[] {
  const def = pb.def;
  const out: Prim3D[] = [];
  const b = pb.bounds;
  const cx = mm(rectCenter(b)[0]);
  const cz = mm(rectCenter(b)[1]);
  const w = mm(b.w);
  const d = mm(b.h);
  const yaw = yawOf(pb.transform.rotation);
  out.push({
    kind: 'box',
    key: `board:${pb.instance.id}`,
    group: 'board',
    center: [cx, -BOARD_THICKNESS_MM / 2, cz],
    size: [w, BOARD_THICKNESS_MM, d],
    color: def.render.body_color ?? '#f3f1e9',
    rotateY: yaw
  });
  // 凹槽：贴一条比板面低一点的深色板，读起来就是中间的沟
  for (const [i, rv] of def.ravines.entries()) {
    const c = worldPoint([rv.x_um + rv.w_um / 2, rv.y_um + rv.h_um / 2], pb.transform);
    out.push({
      kind: 'box',
      key: `ravine:${pb.instance.id}:${i}`,
      group: 'ravine',
      center: [c[0], -0.6, c[1]],
      size: [mm(rv.w_um), 1.6, mm(rv.h_um)],
      color: '#cfcaba',
      rotateY: yaw
    });
  }
  // 电源轨：顶上画一条细带（红/蓝），和 2D 图里的丝印对应
  for (const rail of def.rails) {
    if (rail.marking === 'none') continue;
    const span = (i: number) => {
      const g = Math.floor((i - 1) / rail.group_size);
      const k = (i - 1) % rail.group_size;
      return { p: g * (rail.group_size + rail.gap_pitches) + k, y: rail.origin_um[1] };
    };
    const a = span(1);
    const z = span(rail.holes);
    const x0 = rail.origin_um[0] + a.p * def.pitch_um;
    const x1 = rail.origin_um[0] + z.p * def.pitch_um;
    const c = worldPoint([(x0 + x1) / 2, a.y], pb.transform);
    out.push({
      kind: 'box',
      key: `rail:${pb.instance.id}:${rail.id}`,
      group: 'rail',
      center: [c[0], 0.09, c[1]],
      size: [mm(Math.abs(x1 - x0)), 0.18, 1.6],
      color: rail.marking_color || '#dc2626',
      rotateY: yaw
    });
  }
  for (const h of pb.resolved.holes.values()) {
    const c = worldPoint(h.local_um, pb.transform);
    holes.push({ x: c[0], z: c[1], r: HOLE_RADIUS_MM });
  }
  return out;
}

function componentPrims(pc: PlacedComponent, pins: Pin3D[]): Prim3D[] {
  const def = pc.def;
  const out: Prim3D[] = [];
  const yaw = yawOf(pc.transform.rotation);
  const fill = dominantFill(def);
  const upright = pc.resolved.orientation === 'upright';
  if (upright) {
    // 立式：PCB 竖着插在排针里 —— 沿针排长边立起来，高 = 模块的短边。
    // 注意 `pc.footprint` 是**全局**矩形（`resolved.outline` 才是局部），不能再过一遍 transform。
    const f = pc.footprint;
    const long = Math.max(mm(f.w), mm(f.h));
    const stand = Math.min(mm(def.body.size_um[0]), mm(def.body.size_um[1]));
    const c = rectCenter(f);
    const alongX = f.w >= f.h;
    out.push({
      kind: 'box',
      key: `component:${pc.instance.id}`,
      group: 'component',
      center: [mm(c[0]), stand / 2, mm(c[1])],
      size: alongX ? [long, stand, UPRIGHT_PCB_MM] : [UPRIGHT_PCB_MM, stand, long],
      color: fill,
      rotateY: yaw
    });
  } else {
    const o = pc.resolved.outline;
    const c = worldPoint(rectCenter(o), pc.transform);
    const height = Math.max(0.8, mm(def.body.height_um ?? 1000));
    out.push({
      kind: 'box',
      key: `component:${pc.instance.id}`,
      group: 'component',
      center: [c[0], height / 2, c[1]],
      size: [mm(o.w), height, mm(o.h)],
      color: fill,
      rotateY: yaw
    });
    // 外观图元里的矩形贴到顶面（屏幕、按键帽之类）—— 大过整体轮廓的就跳过，免得和本体打架
    const bodyArea = o.w * o.h;
    for (const [i, p] of def.render.entries()) {
      if (p.t !== 'rect' || p.w * p.h > bodyArea * 0.8) continue;
      const rc = worldPoint([p.x + p.w / 2, p.y + p.h / 2], pc.transform);
      out.push({
        kind: 'box',
        key: `art:${pc.instance.id}:${i}`,
        group: 'art',
        center: [rc[0], height + 0.15, rc[1]],
        size: [mm(p.w), 0.3, mm(p.h)],
        color: p.fill ?? '#1f2937',
        rotateY: yaw
      });
    }
  }
  for (const pin of pc.pins) {
    pins.push({
      x: mm(pin.global_um[0]),
      z: mm(pin.global_um[1]),
      r: PIN_RADIUS_MM,
      h: PIN_HEIGHT_MM,
      color: pin.kind === 'header' ? '#d4af37' : '#c9ced6',
      component: pc.instance.id
    });
  }
  return out;
}

function wirePrim(rw: ResolvedWire): Prim3D | null {
  if (rw.points.length < 2) return null;
  const pts = rw.points.map((p) => [mm(p[0]), mm(p[1])] as [number, number]);
  const height = rw.instance.route === 'elevated' ? 5 : 2.8;
  return {
    kind: 'tube',
    key: `wire:${rw.instance.id}`,
    group: 'wire',
    points: wirePath3D(pts, height),
    radius: WIRE_RADIUS_MM,
    color: wireColor(rw.instance.color)
  };
}

export function buildScene3D(model: DesignModel): Scene3D {
  const prims: Prim3D[] = [];
  const holes: Hole3D[] = [];
  const pins: Pin3D[] = [];
  for (const pb of model.boards.values()) prims.push(...boardPrims(pb, holes));
  for (const pc of model.components.values()) prims.push(...componentPrims(pc, pins));
  for (const rw of model.wires.values()) {
    const p = wirePrim(rw);
    if (p) prims.push(p);
  }

  // 包围盒：只按"实体"算（洞和引脚在板面附近，不改变范围）
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number) => {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  };
  for (const p of prims) {
    if (p.kind === 'box') {
      grow(p.center[0] - p.size[0] / 2, p.center[1] - p.size[1] / 2, p.center[2] - p.size[2] / 2);
      grow(p.center[0] + p.size[0] / 2, p.center[1] + p.size[1] / 2, p.center[2] + p.size[2] / 2);
    } else {
      for (const q of p.points) grow(q[0] - p.radius, q[1] - p.radius, q[2] - p.radius), grow(q[0] + p.radius, q[1] + p.radius, q[2] + p.radius);
    }
  }
  if (!prims.length) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  return {
    prims,
    holes,
    pins,
    bounds: { min, max },
    stats: {
      boards: model.boards.size,
      components: model.components.size,
      wires: model.wires.size,
      holes: holes.length,
      pins: pins.length,
      boxes: prims.filter((p) => p.kind === 'box').length,
      tubes: prims.filter((p) => p.kind === 'tube').length
    }
  };
}
