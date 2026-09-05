import type { PointUm } from '@breadboard-studio/schema';
import type { Rect } from './geometry.js';

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
export function autoRoute(from: PointUm | RouteEnd, to: PointUm | RouteEnd): PointUm[] {
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
