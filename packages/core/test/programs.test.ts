import { describe, it, expect } from 'vitest';
import { activeProgram, analyzeDesign, applyOps, designHash, loadDesign, nextProgramId, programsForComponent, serializeDesign, type Op } from '../src/index.js';
import { build, loadExample, oneBoard } from './helpers.js';

const withMcu = [
  ...oneBoard,
  { op: 'add_component' as const, component: { id: 'mcu', model: 'esp32s3_n16r8_dual_usb@1', placement: { kind: 'board' as const, board_id: 'bb', anchor_hole: 'a9', anchor_pin: 'GND_3', rotation_deg: 90 as const } } },
  { op: 'add_component' as const, component: { id: 'touch', model: 'ttp223_module@1', placement: { kind: 'off_board' as const, position_um: [120000, 0] as [number, number], rotation_deg: 0 as const } } }
];

const SOURCE = "import { gpio, Serial, sleep } from '@bbs/runtime';\nexport async function setup() { Serial.println('ready'); }\nexport async function loop() { await sleep(500); }\n";

describe('programs and simulation config (schema 1.1)', () => {
  it('add_program stores design content that is hashed, serialized and re-loaded', () => {
    const base = build(withMcu);
    const h0 = designHash(base);
    const r = applyOps(base, [{ op: 'add_program', program: { id: 'program_main', name: '主程序', target_component_id: 'mcu', source: SOURCE } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.design.programs).toEqual([{ id: 'program_main', name: '主程序', target_component_id: 'mcu', language: 'studio-ts', source: SOURCE }]);
    expect(r.changed).toContain('program_main');
    expect(r.hash).not.toBe(h0);
    expect(r.results.some((x) => x.severity === 'error')).toBe(false);
    const back = loadDesign(serializeDesign(r.design));
    expect(back.ok).toBe(true);
    expect(back.design).toEqual(r.design);
    expect(designHash(back.design!)).toBe(r.hash);
    expect(programsForComponent(r.design, 'mcu').map((p) => p.id)).toEqual(['program_main']);
    expect(programsForComponent(r.design, 'touch')).toEqual([]);
    expect(activeProgram(r.design)?.id).toBe('program_main');
    expect(nextProgramId(r.design)).toBe('program_1');
  });

  it('refuses programs with unknown targets, duplicate ids or unsupported languages', () => {
    const base = build(withMcu);
    expect(applyOps(base, [{ op: 'add_program', program: { id: 'p', name: 'x', target_component_id: 'ghost', source: '' } }]).ok).toBe(false);
    expect(applyOps(base, [{ op: 'add_program', program: { id: 'mcu', name: 'x', target_component_id: 'mcu', source: '' } }]).ok).toBe(false);
    expect(applyOps(base, [{ op: 'add_program', program: { id: 'p', name: 'x', target_component_id: 'mcu', source: '', language: 'python' as never } }]).ok).toBe(false);
    expect(applyOps(base, [{ op: 'update_program', id: 'nope', patch: { name: 'y' } }]).ok).toBe(false);
    expect(applyOps(base, [{ op: 'remove_program', id: 'nope' }]).ok).toBe(false);
    expect(base.programs).toBeUndefined();
  });

  it('update_program edits source/name/target; source edits change the hash and bump the revision', () => {
    const d = build([...withMcu, { op: 'add_program', program: { id: 'p1', name: 'x', target_component_id: 'mcu', source: 'a' } }]);
    const r = applyOps(d, [{ op: 'update_program', id: 'p1', patch: { source: 'b', name: 'y', entry: 'main.ts' } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.design.programs![0]).toEqual({ id: 'p1', name: 'y', target_component_id: 'mcu', language: 'studio-ts', source: 'b', entry: 'main.ts' });
    expect(r.revision).toBe(d.metadata.revision + 1);
    expect(r.hash).not.toBe(designHash(d));
    expect(applyOps(d, [{ op: 'update_program', id: 'p1', patch: { target_component_id: 'ghost' } }]).ok).toBe(false);
    const retarget = applyOps(d, [{ op: 'update_program', id: 'p1', patch: { target_component_id: 'touch' } }]);
    expect(retarget.ok).toBe(true);
    if (retarget.ok) expect(retarget.results.some((x) => x.code === 'program_target_not_controller' || x.code === 'program_target_unsupported')).toBe(true);
  });

  it('set_simulation_config merges, validates references and clears keys with null', () => {
    const d = build([...withMcu, { op: 'add_program', program: { id: 'p1', name: 'x', target_component_id: 'mcu', source: '' } }]);
    const r = applyOps(d, [{ op: 'set_simulation_config', patch: { active_program_id: 'p1', speed: 2, random_seed: 42, usb_powered_components: ['mcu'] } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.design.simulation).toEqual({ active_program_id: 'p1', speed: 2, random_seed: 42, usb_powered_components: ['mcu'] });
    const cleared = applyOps(r.design, [{ op: 'set_simulation_config', patch: { speed: null, random_seed: null } }]);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.design.simulation).toEqual({ active_program_id: 'p1', usb_powered_components: ['mcu'] });
    expect(applyOps(d, [{ op: 'set_simulation_config', patch: { active_program_id: 'ghost' } }]).ok).toBe(false);
    expect(applyOps(d, [{ op: 'set_simulation_config', patch: { speed: 3 as never } }]).ok).toBe(false);
    expect(applyOps(d, [{ op: 'set_simulation_config', patch: { usb_powered_components: ['ghost'] } }]).ok).toBe(false);
    const empty = applyOps(r.design, [{ op: 'set_simulation_config', patch: { active_program_id: null, speed: null, random_seed: null, usb_powered_components: null } }]);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.design.simulation).toBeUndefined();
  });

  it('remove_program clears the active program; removing the target component cascades to its programs', () => {
    const d = build([
      ...withMcu,
      { op: 'add_program', program: { id: 'p1', name: 'x', target_component_id: 'mcu', source: '' } },
      { op: 'add_program', program: { id: 'p2', name: 'y', target_component_id: 'touch', source: '' } },
      { op: 'set_simulation_config', patch: { active_program_id: 'p1', usb_powered_components: ['mcu'] } }
    ]);
    const removed = applyOps(d, [{ op: 'remove_program', id: 'p1' }]);
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.design.programs!.map((p) => p.id)).toEqual(['p2']);
      expect(removed.design.simulation).toEqual({ usb_powered_components: ['mcu'] });
    }
    const refused = applyOps(d, [{ op: 'remove_component', id: 'mcu' }]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('程序 p1');
    const cascade = applyOps(d, [{ op: 'remove_component', id: 'mcu', cascade: true }]);
    expect(cascade.ok).toBe(true);
    if (cascade.ok) {
      expect(cascade.design.programs!.map((p) => p.id)).toEqual(['p2']);
      expect(cascade.design.simulation).toBeUndefined();
      expect(cascade.changed).toContain('p1');
      expect(cascade.results.some((x) => x.blocking)).toBe(false);
    }
    const board = applyOps(d, [{ op: 'remove_board', id: 'bb', cascade: true }]);
    expect(board.ok).toBe(true);
    if (board.ok) expect(board.design.programs!.map((p) => p.id)).toEqual(['p2']);
    const both = applyOps(d, [{ op: 'remove_component', id: 'mcu', cascade: true }, { op: 'remove_component', id: 'touch', cascade: true }]);
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.design.programs).toBeUndefined();
  });

  it('dangling program references in hand-edited files are blocking; missing drivers only warn', () => {
    const d = build([...withMcu, { op: 'add_program', program: { id: 'p1', name: 'x', target_component_id: 'mcu', source: '' } }]);
    const broken = JSON.parse(serializeDesign(d)) as typeof d;
    broken.programs![0]!.target_component_id = 'ghost';
    broken.simulation = { active_program_id: 'nope', usb_powered_components: ['ghost'] };
    const a = analyzeDesign(broken);
    expect(a.hasBlocking).toBe(true);
    expect(a.results.map((r) => r.code)).toEqual(expect.arrayContaining(['program_target_missing', 'simulation_program_missing', 'unknown_reference']));
    expect(applyOps(broken, [{ op: 'set_metadata', patch: { name: 'x' } }]).ok).toBe(false);
    const generic = build([...oneBoard, { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'off_board', position_um: [0, 0], rotation_deg: 0 } } }, { op: 'add_program', program: { id: 'p', name: 'x', target_component_id: 'led', source: '' } }]);
    const w = analyzeDesign(generic).results.find((r) => r.code === 'program_target_unsupported' || r.code === 'program_target_not_controller');
    expect(w?.severity).toBe('warning');
    expect(w?.blocking).toBe(false);
    const dup = JSON.parse(serializeDesign(d)) as typeof d;
    dup.programs!.push({ ...dup.programs![0]!, id: 'mcu' });
    expect(analyzeDesign(dup).results.some((r) => r.code === 'duplicate_id')).toBe(true);
  });

  it('replace_design migrates a 1.0 document and carries programs/simulation through', () => {
    const d = build([...withMcu, { op: 'add_program', program: { id: 'p1', name: 'x', target_component_id: 'mcu', source: 'src' } }, { op: 'set_simulation_config', patch: { active_program_id: 'p1' } }]);
    const old = JSON.parse(serializeDesign(build(withMcu))) as Record<string, unknown>;
    old.schema_version = '1.0';
    const r = applyOps(d, [{ op: 'replace_design', design: old as never }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.design.schema_version).toBe('1.1');
      expect(r.design.programs).toBeUndefined();
      expect(r.design.simulation).toBeUndefined();
    }
    const withPrograms = applyOps(build(withMcu), [{ op: 'replace_design', design: d }]);
    expect(withPrograms.ok).toBe(true);
    if (withPrograms.ok) {
      expect(withPrograms.design.programs).toEqual(d.programs);
      expect(withPrograms.design.simulation).toEqual({ active_program_id: 'p1' });
    }
    expect(applyOps(d, [{ op: 'replace_design', design: { ...old, schema_version: '9.0' } as never }]).ok).toBe(false);
  });

  it('old 1.0 example files load unchanged apart from the version stamp', () => {
    const example = loadExample('environment_node.breadboard.json');
    const legacy = { ...JSON.parse(serializeDesign(example)), schema_version: '1.0' };
    const r = loadDesign(JSON.stringify(legacy));
    expect(r.ok).toBe(true);
    expect(r.design!.schema_version).toBe('1.1');
    expect({ ...r.design, schema_version: '1.0' }).toEqual(legacy);
    expect(analyzeDesign(r.design!).summary.error).toBe(0);
  });
});

describe('program ops · hand-written patches and normalization', () => {
  const base = () => build([...withMcu, { op: 'add_program', program: { id: 'p1', name: 'x', target_component_id: 'mcu', source: 'a' } }]);

  it('rejects a malformed simulation patch as an operation failure, not a crash', () => {
    const d = base();
    for (const patch of [null, 'speed=2', [1, 2]] as never[]) {
      const r = applyOps(d, [{ op: 'set_simulation_config', patch }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('op_failed');
    }
  });

  it('ignores an `id` key in an update_program patch instead of renaming the program', () => {
    const d = base();
    const r = applyOps(d, [{ op: 'update_program', id: 'p1', patch: { id: 'mcu', name: 'y' } as never }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.design.programs!.map((p) => p.id)).toEqual(['p1']);
      expect(r.design.programs![0]!.name).toBe('y');
    }
  });

  it('stores one spelling of "nothing": empty programs/simulation/usb lists are dropped', () => {
    const d = base();
    const emptied = applyOps(d, [{ op: 'set_simulation_config', patch: { usb_powered_components: [] } }]);
    expect(emptied.ok).toBe(true);
    if (emptied.ok) expect(emptied.design.simulation).toBeUndefined();
    // A hand-written file may spell "no programs" as an empty array; after any transaction both spellings hash alike.
    const start = build(withMcu);
    const handWritten = JSON.parse(serializeDesign(start)) as Record<string, unknown>;
    handWritten.programs = [];
    handWritten.simulation = {};
    const loaded = loadDesign(JSON.stringify(handWritten));
    expect(loaded.ok).toBe(true);
    const rename: Op[] = [{ op: 'set_metadata', patch: { name: 'x' } }];
    const cleaned = applyOps(loaded.design!, rename);
    const plain = applyOps(start, rename);
    expect(cleaned.ok && plain.ok).toBe(true);
    if (cleaned.ok && plain.ok) {
      expect(cleaned.design.programs).toBeUndefined();
      expect(cleaned.design.simulation).toBeUndefined();
      expect(designHash(cleaned.design)).toBe(designHash(plain.design));
    }
  });

  it('reports the missing driver and the non-controller target independently', () => {
    const d = build([
      ...oneBoard,
      { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'off_board', position_um: [0, 0], rotation_deg: 0 } } },
      { op: 'add_component', component: { id: 'sen', model: 'power_module_3v3@1', placement: { kind: 'off_board', position_um: [60000, 0], rotation_deg: 0 } } },
      { op: 'add_program', program: { id: 'p_led', name: 'led', target_component_id: 'led', source: '' } },
      { op: 'add_program', program: { id: 'p_sen', name: 'sen', target_component_id: 'sen', source: '' } }
    ]);
    const results = analyzeDesign(d).results;
    const codesFor = (id: string) => results.filter((r) => r.objects.includes(id)).map((r) => r.code);
    // led_5mm has a driver but is not a controller
    expect(codesFor('p_led')).toContain('program_target_not_controller');
    expect(codesFor('p_led')).not.toContain('program_target_unsupported');
    // the power module has neither a driver nor controller status: both warnings apply
    expect(codesFor('p_sen')).toContain('program_target_unsupported');
    expect(codesFor('p_sen')).toContain('program_target_not_controller');
    expect(results.filter((r) => r.code.startsWith('program_target')).every((r) => r.severity === 'warning' && !r.blocking)).toBe(true);
  });
});
