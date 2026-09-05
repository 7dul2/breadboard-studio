import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesignDocument } from '@breadboard-studio/schema';
import { applyOps, createEmptyDesign, loadDesign, type Op } from '../src/index.js';

export const examplesDir = join(import.meta.dirname, '..', '..', '..', 'examples');

export function loadExample(name: string): DesignDocument {
  const r = loadDesign(readFileSync(join(examplesDir, name), 'utf8'));
  if (!r.ok || !r.design) throw new Error(`example ${name} failed to load: ${JSON.stringify(r.errors)}`);
  return r.design;
}

export function build(ops: Op[], base = createEmptyDesign('test'), allowBlocking = false): DesignDocument {
  const r = applyOps(base, ops, { allow_blocking: allowBlocking });
  if (!r.ok) throw new Error(`apply failed: ${JSON.stringify(r.error)}`);
  return r.design;
}

export const oneBoard: Op[] = [{ op: 'add_board', board: { id: 'bb', model: 'breadboard_400@1', position_um: [0, 0], rotation_deg: 0 } }];
export const twoBoards: Op[] = [
  { op: 'add_board', board: { id: 'bb_a', model: 'breadboard_400@1', position_um: [0, 0], rotation_deg: 0 } },
  { op: 'add_board', board: { id: 'bb_b', model: 'breadboard_400@1', attach_to: { board_id: 'bb_a', side: 'right', grid_align: true } } }
];
