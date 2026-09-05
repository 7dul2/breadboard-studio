import type { BoardDefinition, PointUm } from '@breadboard-studio/schema';
import type { Rect } from './geometry.js';

export type HoleKind = 'terminal' | 'rail';

export interface ResolvedHole {
  name: string;
  local_um: PointUm;
  kind: HoleKind;
  /** Internal conductivity group id (board-local), e.g. `ae7` or `top_outer_s1`. */
  group: string;
  block?: string;
  row?: string;
  column?: number;
  rail?: string;
  index?: number;
}

export interface ResolvedBoard {
  def: BoardDefinition;
  holes: Map<string, ResolvedHole>;
  /** group id -> hole names in canonical order */
  groups: Map<string, string[]>;
  bounds: Rect;
  buckets: Map<string, ResolvedHole[]>;
}

const BUCKET_UM = 1270;
const cache = new WeakMap<BoardDefinition, ResolvedBoard>();

function bucketKey(x: number, y: number): string {
  return `${Math.floor(x / BUCKET_UM)}:${Math.floor(y / BUCKET_UM)}`;
}

export function resolveBoard(def: BoardDefinition): ResolvedBoard {
  const cached = cache.get(def);
  if (cached) return cached;
  const holes = new Map<string, ResolvedHole>();
  const groups = new Map<string, string[]>();
  const buckets = new Map<string, ResolvedHole[]>();
  const push = (h: ResolvedHole) => {
    holes.set(h.name, h);
    const g = groups.get(h.group) ?? [];
    g.push(h.name);
    groups.set(h.group, g);
    const k = bucketKey(h.local_um[0], h.local_um[1]);
    const b = buckets.get(k) ?? [];
    b.push(h);
    buckets.set(k, b);
  };
  for (const block of def.terminal_blocks) {
    for (let c = 0; c < block.columns; c++) {
      const column = block.first_column + c;
      for (let r = 0; r < block.rows.length; r++) {
        const row = block.rows[r]!;
        push({
          name: `${row}${column}`,
          local_um: [block.origin_um[0] + c * def.pitch_um, block.origin_um[1] + r * def.pitch_um],
          kind: 'terminal',
          group: `${block.id}${column}`,
          block: block.id,
          row,
          column
        });
      }
    }
  }
  for (const rail of def.rails) {
    for (let i = 1; i <= rail.holes; i++) {
      const g = Math.floor((i - 1) / rail.group_size);
      const k = (i - 1) % rail.group_size;
      const p = g * (rail.group_size + rail.gap_pitches) + k;
      const segIndex = rail.segments.findIndex(([s, e]) => i >= s && i <= e);
      push({
        name: `${rail.id}_${i}`,
        local_um: [rail.origin_um[0] + p * def.pitch_um, rail.origin_um[1]],
        kind: 'rail',
        group: segIndex >= 0 ? `${rail.id}_s${segIndex + 1}` : `${rail.id}_${i}`,
        rail: rail.id,
        index: i
      });
    }
  }
  const resolved: ResolvedBoard = {
    def,
    holes,
    groups,
    bounds: { x: 0, y: 0, w: def.size_um[0], h: def.size_um[1] },
    buckets
  };
  cache.set(def, resolved);
  return resolved;
}

/** Nearest hole to a board-local point within `tolerance_um`. */
export function holeAtLocal(board: ResolvedBoard, p: PointUm, tolerance_um = 300): ResolvedHole | null {
  const bx = Math.floor(p[0] / BUCKET_UM);
  const by = Math.floor(p[1] / BUCKET_UM);
  let best: ResolvedHole | null = null;
  let bestD = tolerance_um;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const list = board.buckets.get(`${bx + dx}:${by + dy}`);
      if (!list) continue;
      for (const h of list) {
        const d = Math.hypot(h.local_um[0] - p[0], h.local_um[1] - p[1]);
        if (d <= bestD) {
          bestD = d;
          best = h;
        }
      }
    }
  }
  return best;
}

export function isValidHoleName(board: ResolvedBoard, name: string): boolean {
  return board.holes.has(name);
}

/** Human readable description of a hole's internal group, e.g. "a7–e7" or "top_outer 1–25". */
export function describeGroup(board: ResolvedBoard, group: string): string {
  const names = board.groups.get(group) ?? [];
  if (!names.length) return group;
  const first = board.holes.get(names[0]!)!;
  const last = board.holes.get(names[names.length - 1]!)!;
  if (first.kind === 'terminal') return `${first.name}–${last.name}`;
  return `${first.rail} ${first.index}–${last.index}`;
}
