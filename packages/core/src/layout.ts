import type { BoardDefinition, PointUm, RotationDeg } from '@breadboard-studio/schema';
import { resolveBoard } from './board.js';
import { PITCH_UM, rectToGlobal, toGlobal, type Rect, type Transform } from './geometry.js';
import type { DesignModel, PlacedBoard } from './model.js';

export type AttachSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * Position for a new board attached edge-to-edge to an existing one. With
 * `grid_align` the gap is widened (by less than one pitch) so the terminal hole
 * grids of both boards line up, which is what lets a wide module straddle them.
 * Attaching is purely geometric: it never creates an electrical connection.
 */
export function attachBoardPosition(existing: PlacedBoard, def: BoardDefinition, rotation: RotationDeg, side: AttachSide, gap_um = 0, gridAlign = true): PointUm {
  const rb = resolveBoard(def);
  const localBounds = rb.bounds;
  const probe: Transform = { position: [0, 0], rotation };
  const newBounds = rectToGlobal(localBounds, probe); // bounds relative to origin at (0,0)
  const eb = existing.bounds;
  let x: number;
  let y: number;
  switch (side) {
    case 'right':
      x = eb.x + eb.w + gap_um - newBounds.x;
      y = eb.y - newBounds.y;
      break;
    case 'left':
      x = eb.x - gap_um - newBounds.w - newBounds.x;
      y = eb.y - newBounds.y;
      break;
    case 'bottom':
      x = eb.x - newBounds.x;
      y = eb.y + eb.h + gap_um - newBounds.y;
      break;
    case 'top':
      x = eb.x - newBounds.x;
      y = eb.y - gap_um - newBounds.h - newBounds.y;
      break;
  }
  if (gridAlign) {
    const exHole = firstTerminalHoleGlobal(existing.resolved.def, existing.transform);
    const newHole = firstTerminalHoleGlobal(def, { position: [x, y], rotation });
    if (exHole && newHole) {
      const dx = mod(newHole[0] - exHole[0], PITCH_UM);
      const dy = mod(newHole[1] - exHole[1], PITCH_UM);
      const fixX = dx === 0 ? 0 : PITCH_UM - dx;
      const fixY = dy === 0 ? 0 : PITCH_UM - dy;
      if (side === 'right') x += fixX;
      else if (side === 'left') x -= dx;
      else if (side === 'bottom') y += fixY;
      else y -= dy;
      // the perpendicular axis is aligned by construction (same edge origin)
      if (side === 'right' || side === 'left') y += fixY === PITCH_UM ? 0 : fixY;
      else x += fixX === PITCH_UM ? 0 : fixX;
    }
  }
  return [Math.round(x), Math.round(y)];
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function firstTerminalHoleGlobal(def: BoardDefinition, t: Transform): PointUm | null {
  const block = def.terminal_blocks[0];
  if (!block) return null;
  return toGlobal(block.origin_um, t);
}

/** Bounds of everything in the model (or a default area when empty). */
export function sceneBounds(model: DesignModel): Rect {
  return model.bounds ?? { x: 0, y: 0, w: 100000, h: 60000 };
}

/** A free spot to the right of the current scene for an off-board component or a new board. */
export function nextFreePosition(model: DesignModel, size: PointUm, margin = 10000): PointUm {
  if (!model.bounds) return [0, 0];
  const b = model.bounds;
  void size;
  return [Math.round(b.x + b.w + margin), Math.round(b.y)];
}
