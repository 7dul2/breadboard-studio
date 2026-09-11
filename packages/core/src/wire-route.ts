import type { PointUm } from '@breadboard-studio/schema';
import { rectExpand, type Rect } from './geometry.js';

export interface RouteEnd {
  point: PointUm;
  /** Outward direction stub for cable terminals (µm vector). */
  exit?: PointUm | null;
  /** Body bounds of the terminal's component, used to detour around it. */
  bounds?: Rect | null;
  /** Index of the terminal on its component; staggers parallel cables so they do not overlap. */
  lane?: number;
}

const DETOUR_UM = 3000;
const FLAT_CLEARANCE_UM = 900;

function portPoints(end: RouteEnd, target: PointUm): PointUm[] {
  if (!end.exit) return [];
  const lane = end.lane ?? 0;
  const stretch = 1 + lane * 0.3;
  const p1: PointUm = [end.point[0] + Math.round(end.exit[0] * stretch), end.point[1] + Math.round(end.exit[1] * stretch)];
  const pts: PointUm[] = [p1];
  const behind = end.exit[0] * (target[0] - p1[0]) + end.exit[1] * (target[1] - p1[1]) < 0;
  if (behind && end.bounds) {
    const b = end.bounds;
    const d = DETOUR_UM + lane * 1500;
    if (end.exit[1] !== 0) {
      const edgeX = target[0] < b.x + b.w / 2 ? b.x - d : b.x + b.w + d;
      pts.push([edgeX, p1[1]]);
    } else {
      const edgeY = target[1] < b.y + b.h / 2 ? b.y - d : b.y + b.h + d;
      pts.push([p1[0], edgeY]);
    }
  }
  return pts;
}

/**
 * Default orthogonal route between two endpoints. Hole-to-hole wires get a
 * Z-shaped polyline; cable terminals first leave their module outward and, when
 * the target lies behind the module, detour around its edge. Returns
 * intermediate waypoints only (endpoints are implied).
 */
function oldOrthogonalRoute(from: PointUm | RouteEnd, to: PointUm | RouteEnd): PointUm[] {
  const f: RouteEnd = Array.isArray(from) ? { point: from } : from;
  const t: RouteEnd = Array.isArray(to) ? { point: to } : to;
  const a = portPoints(f, t.point);
  const b = portPoints(t, f.point);
  const A = a.length ? a[a.length - 1]! : f.point;
  const B = b.length ? b[b.length - 1]! : t.point;
  const mid: PointUm[] = [];
  if (A[0] !== B[0] && A[1] !== B[1]) {
    if (a.length || b.length) {
      mid.push([A[0], B[1]]);
    } else {
      const midY = Math.round((A[1] + B[1]) / 2);
      mid.push([A[0], midY], [B[0], midY]);
    }
  }
  const pts = [...a, ...mid, ...b.reverse()];
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
}

function inside(r: Rect, p: PointUm): boolean {
  return p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h;
}

/** A zero-width/height rect is the segment of an earlier hard jumper, not a body. */
function isLine(r: Rect): boolean {
  return r.w === 0 || r.h === 0;
}

/**
 * Whether an axis-aligned segment stays clear of every obstacle: component
 * footprints must not be entered at all, while earlier hard jumpers (line
 * rects) only forbid sharing a collinear segment — perpendicular crossings
 * are physically fine on a real board and keep corridors open.
 */
function segmentClear(a: PointUm, b: PointUm, obstacles: Rect[]): boolean {
  if (a[0] !== b[0] && a[1] !== b[1]) return false;
  for (const r of obstacles) {
    if (isLine(r)) {
      if (segmentOverlapsOccupiedLine(a, b, r)) return false;
      continue;
    }
    if (a[0] === b[0]) {
      if (a[0] <= r.x || a[0] >= r.x + r.w) continue;
      const lo = Math.min(a[1], b[1]);
      const hi = Math.max(a[1], b[1]);
      if (Math.max(lo, r.y) < Math.min(hi, r.y + r.h)) return false;
    } else {
      if (a[1] <= r.y || a[1] >= r.y + r.h) continue;
      const lo = Math.min(a[0], b[0]);
      const hi = Math.max(a[0], b[0]);
      if (Math.max(lo, r.x) < Math.min(hi, r.x + r.w)) return false;
    }
  }
  return true;
}

function simplify(points: PointUm[]): PointUm[] {
  const out: PointUm[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function segmentOverlapsOccupiedLine(a: PointUm, b: PointUm, line: Rect): boolean {
  if (line.h === 0 && a[1] === b[1] && a[1] === line.y) {
    return Math.max(Math.min(a[0], b[0]), line.x) < Math.min(Math.max(a[0], b[0]), line.x + line.w);
  }
  if (line.w === 0 && a[0] === b[0] && a[0] === line.x) {
    return Math.max(Math.min(a[1], b[1]), line.y) < Math.min(Math.max(a[1], b[1]), line.y + line.h);
  }
  return false;
}

function pointOnOccupiedLine(p: PointUm, line: Rect): boolean {
  if (line.h === 0) return p[1] === line.y && p[0] >= line.x && p[0] <= line.x + line.w;
  if (line.w === 0) return p[0] === line.x && p[1] >= line.y && p[1] <= line.y + line.h;
  return false;
}

/** Fallback that permits perpendicular crossings but never shares a segment. */
function nonOverlappingLane(start: PointUm, end: PointUm, lines: Rect[]): PointUm[] | null {
  const candidates: PointUm[][] = [];
  const ys = new Set<number>([start[1], end[1], Math.round((start[1] + end[1]) / 2)]);
  const xs = new Set<number>([start[0], end[0], Math.round((start[0] + end[0]) / 2)]);
  for (const line of lines) {
    if (line.h === 0) {
      ys.add(line.y - 600);
      ys.add(line.y + 600);
    }
    if (line.w === 0) {
      xs.add(line.x - 600);
      xs.add(line.x + 600);
    }
  }
  for (const y of ys) candidates.push(simplify([start, [start[0], y], [end[0], y], end]));
  for (const x of xs) candidates.push(simplify([start, [x, start[1]], [x, end[1]], end]));
  const clear = candidates.filter((path) => path.every((p, i) => i === 0 || lines.every((line) => !segmentOverlapsOccupiedLine(path[i - 1]!, p, line))));
  clear.sort((a, b) => {
    const length = (path: PointUm[]) => path.slice(1).reduce((n, p, i) => n + Math.abs(p[0] - path[i]![0]) + Math.abs(p[1] - path[i]![1]), 0);
    return length(a) - length(b) || a.length - b.length;
  });
  return clear[0] ?? null;
}

/**
 * Shortest rectilinear path on the board plane. A sparse visibility grid is
 * formed from endpoint coordinates and expanded component edges. The search
 * slightly penalises bends so a simple L/Z route wins over a jagged route of
 * the same length.
 */
function avoidRects(start: PointUm, end: PointUm, rects: Rect[]): PointUm[] | null {
  if (segmentClear(start, end, rects)) return [start, end];
  const xs = [...new Set([start[0], end[0], ...rects.flatMap((r) => [r.x, r.x + r.w])])].sort((a, b) => a - b);
  const ys = [...new Set([start[1], end[1], ...rects.flatMap((r) => [r.y, r.y + r.h])])].sort((a, b) => a - b);
  const points: PointUm[] = [];
  const at = new Map<string, number>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const y of ys) {
    for (const x of xs) {
      const p: PointUm = [x, y];
      if (rects.some((r) => inside(r, p))) continue;
      at.set(key(x, y), points.length);
      points.push(p);
    }
  }
  const startIndex = at.get(key(start[0], start[1]));
  const endIndex = at.get(key(end[0], end[1]));
  if (startIndex === undefined || endIndex === undefined) return null;

  const neighbours: { index: number; dir: 1 | 2; distance: number }[][] = points.map(() => []);
  const linkLine = (indices: number[], dir: 1 | 2) => {
    for (let i = 1; i < indices.length; i++) {
      const a = indices[i - 1]!;
      const b = indices[i]!;
      if (!segmentClear(points[a]!, points[b]!, rects)) continue;
      const distance = Math.abs(points[a]![0] - points[b]![0]) + Math.abs(points[a]![1] - points[b]![1]);
      neighbours[a]!.push({ index: b, dir, distance });
      neighbours[b]!.push({ index: a, dir, distance });
    }
  };
  for (const y of ys) linkLine(xs.map((x) => at.get(key(x, y))).filter((i): i is number => i !== undefined), 1);
  for (const x of xs) linkLine(ys.map((y) => at.get(key(x, y))).filter((i): i is number => i !== undefined), 2);

  // State is node × incoming direction (0=start, 1=horizontal, 2=vertical).
  const total = points.length * 3;
  const dist = new Array<number>(total).fill(Infinity);
  const prev = new Array<number>(total).fill(-1);
  const heap: { state: number; cost: number }[] = [];
  const push = (item: { state: number; cost: number }) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (heap[parent]!.cost <= item.cost) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = item;
  };
  const pop = () => {
    const root = heap[0];
    const last = heap.pop();
    if (!root || !last || !heap.length) return root;
    let i = 0;
    while (true) {
      const left = i * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && heap[right]!.cost < heap[left]!.cost ? right : left;
      if (heap[child]!.cost >= last.cost) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = last;
    return root;
  };
  const startState = startIndex * 3;
  dist[startState] = 0;
  push({ state: startState, cost: 0 });
  while (heap.length) {
    const item = pop()!;
    const cur = item.state;
    if (item.cost !== dist[cur]) continue;
    const best = item.cost;
    const node = Math.floor(cur / 3);
    const incoming = (cur % 3) as 0 | 1 | 2;
    if (node === endIndex) {
      const path: PointUm[] = [];
      let s = cur;
      while (s >= 0) {
        path.push(points[Math.floor(s / 3)]!);
        s = prev[s]!;
      }
      return simplify(path.reverse());
    }
    for (const edge of neighbours[node]!) {
      const next = edge.index * 3 + edge.dir;
      const bend = incoming !== 0 && incoming !== edge.dir ? 1200 : 0;
      const candidate = best + edge.distance + bend;
      if (candidate < dist[next]!) {
        dist[next] = candidate;
        prev[next] = cur;
        push({ state: next, cost: candidate });
      }
    }
  }
  return null;
}

/**
 * Auto route for a hard jumper: horizontal/vertical segments on the board,
 * avoiding component bodies. Returned points exclude the two endpoints.
 */
export function autoRoute(from: PointUm | RouteEnd, to: PointUm | RouteEnd, obstacles: Rect[] = []): PointUm[] {
  const f: RouteEnd = Array.isArray(from) ? { point: from } : from;
  const t: RouteEnd = Array.isArray(to) ? { point: to } : to;
  const a = portPoints(f, t.point);
  const b = portPoints(t, f.point);
  const A = a.length ? a[a.length - 1]! : f.point;
  const B = b.length ? b[b.length - 1]! : t.point;
  const lines = obstacles.filter((r) => isLine(r));
  const areas = obstacles.filter((r) => !isLine(r));
  // If an older route passes over this insertion point, leave it
  // perpendicularly instead of following the same segment.
  if (lines.some((line) => pointOnOccupiedLine(A, line) || pointOnOccupiedLine(B, line))) {
    const lane = nonOverlappingLane(A, B, lines);
    if (lane) {
      const all = simplify([f.point, ...a, ...lane.slice(1, -1), ...b.reverse(), t.point]);
      return all.slice(1, -1);
    }
  }
  const expanded = areas.map((r) => {
    const padded = rectExpand(r, FLAT_CLEARANCE_UM);
    // A valid hole can sit very close to a neighbouring footprint. Do not let
    // safety padding trap an endpoint; the original body remains forbidden.
    return inside(padded, A) || inside(padded, B) ? r : padded;
  });
  // Start with an empty visibility grid, then add only obstacles actually hit
  // by the candidate path. This keeps dense designs fast while converging to
  // a path checked against every component and previously placed jumper.
  // Line obstacles (earlier hard jumpers) take part in every round: crossing
  // them perpendicularly is allowed, sharing a collinear segment is not.
  const relevant: Rect[] = [];
  let middle: PointUm[] | null = null;
  for (;;) {
    middle = avoidRects(A, B, [...lines, ...relevant]);
    if (!middle) {
      // Dense endpoint keep-outs can occasionally disconnect the strict
      // visibility graph. Preserve the hard-jumper contract first: choose a
      // separate lane around already occupied board-plane wire segments.
      middle = nonOverlappingLane(A, B, lines);
      if (!middle) return oldOrthogonalRoute(from, to);
      break;
    }
    const added = expanded.filter((r) => !relevant.includes(r) && middle!.some((p, i) => i > 0 && !segmentClear(middle![i - 1]!, p, [r])));
    if (!added.length) break;
    relevant.push(...added);
  }
  const all = simplify([f.point, ...a, ...middle.slice(1, -1), ...b.reverse(), t.point]);
  return all.slice(1, -1);
}
