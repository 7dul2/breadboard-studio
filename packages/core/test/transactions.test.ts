import { describe, it, expect } from 'vitest';
import { analyzeDesign, applyOps, designHash, loadDesign, serializeDesign } from '../src/index.js';
import { build, loadExample, oneBoard } from './helpers.js';

describe('transactions', () => {
  it('a batch is atomic: one bad op means nothing is applied', () => {
    const base = build(oneBoard);
    const r = applyOps(base, [
      { op: 'add_wire', wire: { id: 'w1', from: { hole: 'bb.a1' }, to: { hole: 'bb.a2' }, color: 'red' } },
      { op: 'add_wire', wire: { id: 'w2', from: { hole: 'bb.zz' }, to: { hole: 'bb.a3' }, color: 'red' } }
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('blocking_errors');
    expect(base.wires.length).toBe(0);
    expect(base.metadata.revision).toBe(1);
    const r2 = applyOps(base, [{ op: 'remove_wire', id: 'nope' }]);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('op_failed');
      expect(r2.error.op_index).toBe(0);
    }
  });

  it('revision and hash guard against concurrent edits', () => {
    const base = build(oneBoard);
    const h = designHash(base);
    const ok = applyOps(base, [{ op: 'set_metadata', patch: { name: 'x' } }], { expected_revision: base.metadata.revision, expected_hash: h });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.revision).toBe(base.metadata.revision + 1);
      expect(ok.previous_hash).toBe(h);
      expect(ok.hash).not.toBe(h);
    }
    const stale = applyOps(base, [{ op: 'set_metadata', patch: { name: 'y' } }], { expected_revision: 99 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('revision_conflict');
    const staleHash = applyOps(base, [{ op: 'set_metadata', patch: { name: 'y' } }], { expected_hash: 'deadbeef' });
    expect(staleHash.ok).toBe(false);
  });

  it('electrical problems do not block a commit but are reported', () => {
    const base = build([...oneBoard, { op: 'add_component', component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } } }]);
    const r = applyOps(base, [{ op: 'add_wire', wire: { id: 'w', from: { pin: 'mcu.3V3' }, to: { pin: 'mcu.GND' }, color: 'red' } }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results.some((x) => x.code === 'power_ground_short')).toBe(true);
  });

  it('locked objects refuse edits until unlocked', () => {
    const base = build(oneBoard);
    const locked = build([{ op: 'update_property', id: 'bb', path: 'locked', value: true }], base);
    const r = applyOps(locked, [{ op: 'move_board', id: 'bb', position_um: [1000, 0] }]);
    expect(r.ok).toBe(false);
    const unlocked = build([{ op: 'update_property', id: 'bb', path: 'locked', value: false }], locked);
    expect(applyOps(unlocked, [{ op: 'move_board', id: 'bb', position_um: [1000, 0] }]).ok).toBe(true);
  });

  it('removing a board with dependents requires cascade', () => {
    const d = loadExample('environment_node.breadboard.json');
    const r = applyOps(d, [{ op: 'remove_board', id: 'bb_b' }]);
    expect(r.ok).toBe(false);
    const c = applyOps(d, [{ op: 'remove_board', id: 'bb_b', cascade: true }]);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.design.boards.map((b) => b.id)).toEqual(['bb_a']);
      expect(c.design.wires.some((w) => w.to?.hole?.startsWith('bb_b.'))).toBe(false);
      // wires to off-board terminals that also touched bb_b are gone too
      expect(c.design.wires.find((w) => w.id === 'w22')).toBeUndefined();
    }
  });

  it('update_property only accepts whitelisted paths and re-validates the schema', () => {
    const base = build(oneBoard);
    expect(applyOps(base, [{ op: 'update_property', id: 'bb', path: 'model', value: 'x@1' }]).ok).toBe(false);
    const bad = applyOps(base, [{ op: 'update_property', id: 'bb', path: 'rotation_deg', value: 45 }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('schema_invalid');
  });
});

describe('file round trip', () => {
  it('serialize → load keeps ids, coordinates, endpoints and catalog versions', () => {
    const d = loadExample('environment_node.breadboard.json');
    const text = serializeDesign(d);
    const back = loadDesign(text);
    expect(back.ok).toBe(true);
    expect(back.design).toEqual(d);
    expect(designHash(back.design!)).toBe(designHash(d));
    expect(back.design!.catalog_versions.builtin).toBeDefined();
    expect(back.design!.wires.find((w) => w.id === 'w15')!.to).toEqual({ hole: 'bb_b.a3' });
  });

  it('rejects malformed JSON, unknown schema versions and structural mistakes explicitly', () => {
    expect(loadDesign('{"schema_version": "1.0", "boards": [}').ok).toBe(false);
    const future = loadDesign(JSON.stringify({ ...loadExample('environment_node.breadboard.json'), schema_version: '9.0' }));
    expect(future.ok).toBe(false);
    expect(future.errors[0]!.message).toContain('9.0');
    const noWires = loadDesign(JSON.stringify({ ...loadExample('environment_node.breadboard.json'), wires: undefined }));
    expect(noWires.ok).toBe(false);
    const badHole = loadDesign(JSON.stringify({ ...loadExample('environment_node.breadboard.json'), wires: [{ id: 'w', from: { hole: 'nodot' }, color: 'red', route: 'flat', path_mode: 'auto', waypoints_um: [] }] }));
    expect(badHole.ok).toBe(false);
  });

  it('counter-examples with bad references are blocking', () => {
    for (const [name, code] of [
      ['invalid/invalid_hole.breadboard.json', 'invalid_hole'],
      ['invalid/duplicate_id.breadboard.json', 'duplicate_id'],
      ['invalid/hole_conflict.breadboard.json', 'hole_conflict']
    ] as const) {
      const a = analyzeDesign(loadExample(name));
      expect(a.hasBlocking, name).toBe(true);
      expect(a.results.some((r) => r.code === code), name).toBe(true);
    }
  });
});
