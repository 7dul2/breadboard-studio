import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ComponentInstance, PointUm } from '@breadboard-studio/schema';
import { applyOps, buildModel, catalogForDesign, loadDesign, toGlobal } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { anchorPointUm, leadPin, snapPlacement } from './placement';

const FIXTURE = fileURLToPath(new URL('../../../examples/touch_display.breadboard.json', import.meta.url));
const design = loadDesign(readFileSync(FIXTURE, 'utf8')).design!;
const catalog = catalogForDesign(design, builtinCatalog());
const model = buildModel(design, catalog);

/** Absolute position of one hole, which is what a paste target really is. */
function holeUm(boardId: string, hole: string): PointUm {
  const pb = model.boards.get(boardId)!;
  return toGlobal(pb.resolved.holes.get(hole)!.local_um, pb.transform);
}

describe('placement snapping', () => {
  it('leaves a placed component exactly where it is for a zero move', () => {
    const before = design.components.find((c) => c.id === 'touch')!.placement;
    expect(snapPlacement(model, design, 'touch', [0, 0])).toEqual(before);
  });

  it('reports the anchor pin position that a paste puts under the cursor', () => {
    const inst = design.components.find((c) => c.id === 'touch')!;
    expect(inst.placement.kind).toBe('board');
    const anchorHole = inst.placement.kind === 'board' ? inst.placement.anchor_hole : '';
    const board = inst.placement.kind === 'board' ? inst.placement.board_id : '';
    // the anchor pin sits in its anchor hole, so the two points coincide
    expect(anchorPointUm(model, design, 'touch')).toEqual(holeUm(board, anchorHole));
  });

  it('falls into whatever hole the anchor lands nearest, and back again', () => {
    const inst = design.components.find((c) => c.id === 'touch')!;
    const from = anchorPointUm(model, design, 'touch')!;
    const target = holeUm('bb', 'e14');
    const delta: PointUm = [target[0] - from[0], target[1] - from[1]];

    const moved = snapPlacement(model, design, 'touch', delta);
    expect(moved).toMatchObject({ kind: 'board', board_id: 'bb', anchor_hole: 'e14', rotation_deg: inst.placement.rotation_deg });

    // reversing the same delta against the moved document returns the original hole
    const after = applyOps(design, [{ op: 'move_component', id: 'touch', placement: moved! }], { catalog, allow_blocking: true });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const back = snapPlacement(buildModel(after.design, catalog), after.design, 'touch', [-delta[0], -delta[1]]);
    expect(back).toEqual(inst.placement);
  });

  it('stays loose when the anchor lands nowhere near a board', () => {
    const pc = model.components.get('touch')!;
    const far: PointUm = [500000, 500000];
    expect(snapPlacement(model, design, 'touch', far)).toEqual({
      kind: 'off_board',
      position_um: [pc.transform.position[0] + far[0], pc.transform.position[1] + far[1]],
      rotation_deg: design.components.find((c) => c.id === 'touch')!.placement.rotation_deg
    });
  });

  it('drops a pasted copy into the hole under the pointer, the way a drag would', () => {
    // exactly the paste algorithm: add the copy loose at posUm + delta, then snap it
    const source = design.components.find((c) => c.id === 'touch')!;
    const pc = model.components.get('touch')!;
    const refUm = anchorPointUm(model, design, 'touch')!;
    const target = holeUm('bb', 'e18');
    const delta: PointUm = [target[0] - refUm[0], target[1] - refUm[1]];

    const copy: ComponentInstance = {
      ...JSON.parse(JSON.stringify(source)),
      id: 'touch_copy',
      placement: { kind: 'off_board', position_um: [pc.transform.position[0] + delta[0], pc.transform.position[1] + delta[1]], rotation_deg: source.placement.rotation_deg }
    };
    const staged = applyOps(design, [{ op: 'add_component', component: copy }], { catalog, allow_blocking: true });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const placement = snapPlacement(buildModel(staged.design, catalog), staged.design, 'touch_copy', [0, 0]);
    expect(placement).toMatchObject({ kind: 'board', board_id: 'bb', anchor_hole: 'e18' });
    // and the copy keeps its own identity, not the original's
    expect(staged.design.components.find((c) => c.id === 'touch_copy')!.model).toBe(source.model);
    expect(staged.design.components.filter((c) => c.model === source.model)).toHaveLength(2);
  });

  it('anchors a loose component by its top-left header pin, after rotation', () => {
    const pins = [
      { name: 'A', local_um: [0, 0] as PointUm, kind: 'header' },
      { name: 'B', local_um: [2540, 0] as PointUm, kind: 'header' },
      { name: 'C', local_um: [0, 2540] as PointUm, kind: 'header' },
      { name: 'PAD', local_um: [-5000, -5000] as PointUm, kind: 'pad' }
    ];
    // "top-left after rotation": smallest y, ties broken by smallest x
    expect(leadPin(pins, 0)?.name).toBe('A');
    expect(leadPin(pins, 90)?.name).toBe('C');
    expect(leadPin(pins, 180)?.name).toBe('C');
    expect(leadPin(pins, 270)?.name).toBe('B');
    expect(leadPin([{ name: 'PAD', local_um: [0, 0] as PointUm, kind: 'pad' }], 0), 'a part with no header pin has no anchor').toBeUndefined();
  });
});
