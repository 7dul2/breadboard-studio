/**
 * Where a component or board lands when it is dropped — shared by canvas dragging
 * and by paste, because both answer the same question: given an absolute µm target,
 * does this thing snap onto a board hole, or stay loose?
 *
 * It was inlined in `Canvas.tsx` while dragging was the only caller. Paste needs the
 * identical rule (a pasted module must sit in holes exactly like a dragged one), and
 * duplicating it would let the two drift apart. Nothing here touches the DOM or the
 * store, so it is unit-testable under `environment: 'node'`.
 */
import type { DesignDocument, Placement, PointUm } from '@breadboard-studio/schema';
import { attachBoardPosition, holeAtLocal, rotateVec, toLocal, type DesignModel } from '@breadboard-studio/core';

/** How close an anchor pin must come to a hole to fall into it. */
export const SNAP_UM = 1600;
/** How close two boards must come before they clip together edge to edge. */
export const BOARD_SNAP_UM = 5000;

/**
 * The pin a loose component hangs from: the top-left header pin *after* rotation, so
 * the same physical lead stays the anchor however the part is turned.
 */
export function leadPin(
  pins: { name: string; local_um: PointUm; kind: string }[],
  rotation: 0 | 90 | 180 | 270
): { name: string; local_um: PointUm; x: number; y: number } | undefined {
  let best: { name: string; local_um: PointUm; x: number; y: number } | undefined;
  for (const p of pins) {
    if (p.kind !== 'header') continue;
    const [x, y] = rotateVec(p.local_um, rotation);
    if (!best || y < best.y - 1 || (Math.abs(y - best.y) <= 1 && x < best.x)) best = { name: p.name, local_um: p.local_um, x, y };
  }
  return best;
}

/** Absolute position of the pin a component is anchored by, or null when it has no header pin. */
export function anchorPointUm(model: DesignModel, base: DesignDocument, id: string): PointUm | null {
  const pc = model.components.get(id);
  const inst = base.components.find((c) => c.id === id);
  if (!pc || !inst) return null;
  const anchorName = inst.placement.kind === 'board' ? inst.placement.anchor_pin : leadPin(pc.pins, inst.placement.rotation_deg)?.name;
  const pin = pc.pins.find((p) => p.name === anchorName) ?? pc.pins.find((p) => p.kind === 'header');
  return pin ? [pin.global_um[0], pin.global_um[1]] : null;
}

/**
 * Placement for `id` after moving it by `deltaUm`. Returns a `board` placement when
 * the anchor pin lands within `SNAP_UM` of a hole on any board, otherwise `off_board`
 * at the moved position — a move never fails, it just may not be in holes.
 */
export function snapPlacement(model: DesignModel, base: DesignDocument, id: string, deltaUm: PointUm): Placement | null {
  const pc = model.components.get(id);
  if (!pc) return null;
  const inst = base.components.find((c) => c.id === id);
  if (!inst) return null;
  const rotation = inst.placement.rotation_deg;
  const anchorName = inst.placement.kind === 'board' ? inst.placement.anchor_pin : leadPin(pc.pins, rotation)?.name;
  const anchorPin = pc.pins.find((p) => p.name === anchorName) ?? pc.pins.find((p) => p.kind === 'header');
  if (anchorPin && anchorPin.kind === 'header') {
    const target: PointUm = [anchorPin.global_um[0] + deltaUm[0], anchorPin.global_um[1] + deltaUm[1]];
    for (const pb of model.boards.values()) {
      const local = toLocal(target, pb.transform);
      const h = holeAtLocal(pb.resolved, local, SNAP_UM);
      if (h) return { kind: 'board', board_id: pb.instance.id, anchor_hole: h.name, anchor_pin: anchorPin.name, rotation_deg: rotation };
    }
  }
  return { kind: 'off_board', position_um: [pc.transform.position[0] + deltaUm[0], pc.transform.position[1] + deltaUm[1]], rotation_deg: rotation };
}

/** Position for a moved board, clipped to a neighbouring board's edge when it comes close enough. */
export function snapBoardPosition(model: DesignModel, id: string, deltaUm: PointUm): PointUm {
  const pb = model.boards.get(id)!;
  let pos: PointUm = [pb.transform.position[0] + deltaUm[0], pb.transform.position[1] + deltaUm[1]];
  let best: { pos: PointUm; d: number } | null = null;
  for (const other of model.boards.values()) {
    if (other.instance.id === id) continue;
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const cand = attachBoardPosition(other, pb.def, pb.transform.rotation, side, 0, true);
      const d = Math.hypot(cand[0] - pos[0], cand[1] - pos[1]);
      if (d < BOARD_SNAP_UM && (!best || d < best.d)) best = { pos: cand, d };
    }
  }
  if (best) pos = best.pos;
  return [Math.round(pos[0]), Math.round(pos[1])];
}
