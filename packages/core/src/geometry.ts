import type { PointUm, RotationDeg } from '@breadboard-studio/schema';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Transform {
  position: PointUm;
  rotation: RotationDeg;
}

export const PITCH_UM = 2540;

export function normalizeRotation(deg: number): RotationDeg {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as RotationDeg;
}

/** Rotate a local vector clockwise on screen (y down) by a multiple of 90°. */
export function rotateVec(p: PointUm, rotation: RotationDeg): PointUm {
  const [x, y] = p;
  switch (normalizeRotation(rotation)) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}

export function toGlobal(local: PointUm, t: Transform): PointUm {
  const [rx, ry] = rotateVec(local, t.rotation);
  return [t.position[0] + rx, t.position[1] + ry];
}

export function toLocal(global: PointUm, t: Transform): PointUm {
  const inv = normalizeRotation(360 - t.rotation);
  return rotateVec([global[0] - t.position[0], global[1] - t.position[1]], inv);
}

export function rectToGlobal(r: Rect, t: Transform): Rect {
  const corners: PointUm[] = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h]
  ].map((c) => toGlobal(c as PointUm, t));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function rectContains(r: Rect, p: PointUm, margin = 0): boolean {
  return p[0] >= r.x + margin && p[0] <= r.x + r.w - margin && p[1] >= r.y + margin && p[1] <= r.y + r.h - margin;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x + margin < b.x + b.w && b.x + margin < a.x + a.w && a.y + margin < b.y + b.h && b.y + margin < a.y + a.h;
}

export function rectUnion(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rectExpand(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

export function distance(a: PointUm, b: PointUm): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(points: PointUm[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distance(points[i - 1]!, points[i]!);
  return Math.round(len);
}

export function segmentIntersectsRect(a: PointUm, b: PointUm, r: Rect): boolean {
  // Liang–Barsky clipping for axis-aligned rect.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: [number, number][] = [
    [-dx, a[0] - r.x],
    [dx, r.x + r.w - a[0]],
    [-dy, a[1] - r.y],
    [dy, r.y + r.h - a[1]]
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}

export function umToMm(um: number, digits = 2): string {
  return (um / 1000).toFixed(digits);
}

export function pointsEqual(a: PointUm, b: PointUm): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
