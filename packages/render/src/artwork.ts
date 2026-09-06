/**
 * Artwork helpers for the definition drawing editor: group a flat list of
 * render primitives into movable "parts", and move / rotate / copy them.
 * Pure functions in definition-local micrometres; no DOM.
 */
import type { PointUm, RenderPrimitiveDef } from '@breadboard-studio/schema';

export interface ArtBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArtGroup {
  id: string;
  /** Indices into the render array, ascending. */
  indices: number[];
  bounds: ArtBounds;
  /** True when the group is a large background/body primitive that should not be merged with parts. */
  large: boolean;
}

function pathPoints(d: string): PointUm[] {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const pts: PointUm[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  return pts;
}

/** Axis-aligned bounds of one primitive (text is approximated from its size and length). */
export function primitiveBounds(p: RenderPrimitiveDef): ArtBounds {
  switch (p.t) {
    case 'rect':
      return { x: p.x, y: p.y, w: p.w, h: p.h };
    case 'circle':
      return { x: p.cx - p.r, y: p.cy - p.r, w: p.r * 2, h: p.r * 2 };
    case 'line': {
      const x = Math.min(p.x1, p.x2);
      const y = Math.min(p.y1, p.y2);
      return { x, y, w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1) };
    }
    case 'text': {
      const len = Math.max(1, p.text.length) * p.size * 0.6;
      const rotated = ((p.rotate ?? 0) % 180) !== 0;
      const w = rotated ? p.size : len;
      const h = rotated ? len : p.size;
      let x = p.x;
      if (!rotated) x = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
      else x = p.x - w / 2;
      let y = rotated ? (p.anchor === 'middle' ? p.y - h / 2 : p.anchor === 'end' ? p.y : p.y - h) : p.y - p.size * 0.8;
      if (rotated && (p.rotate ?? 0) < 0 && p.anchor === 'end') y = p.y;
      return { x, y, w, h };
    }
    case 'path': {
      const pts = pathPoints(p.d);
      if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

export function boundsUnion(a: ArtBounds, b: ArtBounds): ArtBounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function overlaps(a: ArtBounds, b: ArtBounds, tol: number): boolean {
  return a.x - tol < b.x + b.w && b.x - tol < a.x + a.w && a.y - tol < b.y + b.h && b.y - tol < a.y + a.h;
}

/**
 * Group primitives into parts. Primitives tagged with the same `g` form one
 * part. Untagged primitives are merged when their bounds touch, except
 * "large" ones (board body, module can, big areas) which always stay alone so
 * they do not swallow everything drawn on top of them.
 */
export function groupPrimitives(render: RenderPrimitiveDef[], bodySize: PointUm, tol = 50): ArtGroup[] {
  const n = render.length;
  const bounds = render.map(primitiveBounds);
  const bodyArea = Math.max(1, bodySize[0] * bodySize[1]);
  const large = bounds.map((b) => b.w * b.h > bodyArea * 0.08 || b.w > bodySize[0] * 0.7 || b.h > bodySize[1] * 0.7);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const tagged = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const g = render[i]!.g;
    if (!g) continue;
    const first = tagged.get(g);
    if (first === undefined) tagged.set(g, i);
    else union(first, i);
  }
  for (let i = 0; i < n; i++) {
    if (render[i]!.g || large[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (render[j]!.g || large[j]) continue;
      if (overlaps(bounds[i]!, bounds[j]!, tol)) union(i, j);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), i]);
  const groups: ArtGroup[] = [];
  for (const indices of byRoot.values()) {
    indices.sort((a, b) => a - b);
    let b = bounds[indices[0]!]!;
    for (const i of indices.slice(1)) b = boundsUnion(b, bounds[i]!);
    const tag = render[indices[0]!]!.g;
    groups.push({ id: tag ?? `p${indices[0]}`, indices, bounds: b, large: indices.some((i) => large[i]) });
  }
  groups.sort((a, b) => a.indices[0]! - b.indices[0]!);
  return groups;
}

export function movePrimitive(p: RenderPrimitiveDef, dx: number, dy: number): RenderPrimitiveDef {
  switch (p.t) {
    case 'rect':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'circle':
      return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    case 'line':
      return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
    case 'text':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'path':
      return { ...p, d: mapPath(p.d, (x, y) => [x + dx, y + dy]) };
  }
}

function mapPath(d: string, f: (x: number, y: number) => [number, number]): string {
  // Only absolute M/L/H/V-free coordinate pairs are transformed; commands are kept as-is.
  const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: string[] = [];
  let pending: number | null = null;
  for (const t of tokens) {
    if (/[A-Za-z]/.test(t)) {
      out.push(t);
      continue;
    }
    const v = Number(t);
    if (pending === null) pending = v;
    else {
      const [x, y] = f(pending, v);
      out.push(String(Math.round(x)), String(Math.round(y)));
      pending = null;
    }
  }
  return out.join(' ');
}

/** Rotate one primitive 90° clockwise (screen) about (cx, cy). */
export function rotatePrimitive(p: RenderPrimitiveDef, cx: number, cy: number): RenderPrimitiveDef {
  const rot = (x: number, y: number): [number, number] => [Math.round(cx - (y - cy)), Math.round(cy + (x - cx))];
  switch (p.t) {
    case 'rect': {
      const [nx, ny] = rot(p.x, p.y + p.h); // bottom-left corner becomes the new top-left
      return { ...p, x: nx, y: ny, w: p.h, h: p.w };
    }
    case 'circle': {
      const [nx, ny] = rot(p.cx, p.cy);
      return { ...p, cx: nx, cy: ny };
    }
    case 'line': {
      const [ax, ay] = rot(p.x1, p.y1);
      const [bx, by] = rot(p.x2, p.y2);
      return { ...p, x1: ax, y1: ay, x2: bx, y2: by };
    }
    case 'text': {
      const [nx, ny] = rot(p.x, p.y);
      const nr = (((p.rotate ?? 0) + 90) % 360 + 360) % 360;
      return { ...p, x: nx, y: ny, rotate: nr > 180 ? nr - 360 : nr };
    }
    case 'path':
      return { ...p, d: mapPath(p.d, rot) };
  }
}

/** Duplicate the primitives of a group, offset by (dx, dy), tagged as a new part. */
export function duplicateGroup(render: RenderPrimitiveDef[], group: ArtGroup, dx: number, dy: number, tag: string): RenderPrimitiveDef[] {
  return group.indices.map((i) => ({ ...movePrimitive(render[i]!, dx, dy), g: tag }));
}

/** Tag every group so the parts survive a round trip through the JSON file. */
export function tagGroups(render: RenderPrimitiveDef[], groups: ArtGroup[]): RenderPrimitiveDef[] {
  const out = render.map((p) => ({ ...p }));
  for (const g of groups) for (const i of g.indices) out[i]!.g = g.id;
  return out;
}

/** A free part tag not used by any primitive. */
export function nextTag(render: RenderPrimitiveDef[]): string {
  const used = new Set(render.map((p) => p.g).filter((g): g is string => !!g));
  let n = 1;
  while (used.has(`n${n}`)) n++;
  return `n${n}`;
}
