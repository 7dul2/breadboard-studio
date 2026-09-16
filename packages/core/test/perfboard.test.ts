import { describe, expect, it } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { analyzeDesign, applyOps, boardShape, buildModel, groupHoles, loadDesign, resizeBoardDefinition, serializeDesign } from '../src/index.js';
import { build } from './helpers.js';

const perfboard = [{ op: 'add_board' as const, board: { id: 'pb', model: 'perfboard_5x7@1', position_um: [0, 0] as [number, number], rotation_deg: 0 as const } }];

describe('perfboard', () => {
  it('keeps neighbouring pads electrically independent', () => {
    const design = build(perfboard);
    const analysis = analyzeDesign(design);
    expect(groupHoles(analysis.model, 'pb.A1')).toEqual(['pb.A1']);
    expect(analysis.connectivity.full.connected('pb.A1', 'pb.A2')).toBe(false);
    expect(analysis.connectivity.full.connected('pb.A1', 'pb.B1')).toBe(false);
  });

  it('allows a wire to use an occupied solder pad and quotes stable hole ids', () => {
    const placed = build([
      ...perfboard,
      { op: 'add_component', component: { id: 'led', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'pb', anchor_hole: 'A1', anchor_pin: 'A', rotation_deg: 0 } } }
    ]);
    const result = applyOps(placed, [{ op: 'add_wire', wire: { id: 'w1', from: { pin: 'led.A' }, to: { hole: 'pb.B1' }, color: 'red' } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design.wires[0]?.from).toEqual({ hole: 'pb.A1' });
    const analysis = analyzeDesign(result.design);
    expect(analysis.results.filter((r) => r.blocking)).toEqual([]);
    expect(analysis.connectivity.full.connected('led.A', 'pb.B1')).toBe(true);
    expect(analysis.connectivity.full.connected('pb.A1', 'pb.A2')).toBe(false);
  });

  it('mixes with a breadboard without changing either board mechanism', () => {
    const design = build([
      ...perfboard,
      { op: 'add_board', board: { id: 'bb', model: 'breadboard_400@1', position_um: [100000, 0], rotation_deg: 0 } },
      { op: 'add_wire', wire: { id: 'bridge', from: { hole: 'pb.A1' }, to: { hole: 'bb.a1' }, color: 'red' } }
    ]);
    const analysis = analyzeDesign(design);
    expect(analysis.connectivity.full.connected('pb.A1', 'bb.a1')).toBe(true);
    expect(analysis.connectivity.full.connected('pb.A2', 'pb.A1')).toBe(false);
    expect(analysis.results.filter((r) => r.blocking)).toEqual([]);
  });

  it('lets auto-wire use occupied pads directly when no rail exists', () => {
    const design = build([
      { op: 'add_board', board: { id: 'pb', model: 'perfboard_7x9@1', position_um: [0, 0] as [number, number], rotation_deg: 0 as const } },
      { op: 'add_component', component: { id: 'host', model: 'xiao_esp32s3_sense@1', placement: { kind: 'off_board', position_um: [150000, 0], rotation_deg: 90 } } },
      { op: 'add_component', component: { id: 'touch', model: 'ttp224_module@1', placement: { kind: 'board', board_id: 'pb', anchor_hole: 'A14', anchor_pin: 'VCC', rotation_deg: 0 } } }
    ]);
    const result = applyOps(design, [{ op: 'auto_wire', host: 'host', components: ['touch'], options: { power_distribution: 'direct', route: 'elevated', require_all: true } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.reports[0]!.plan;
    expect(plan.unresolved).toEqual([]);
    expect(plan.connections.some((connection) => connection.from.startsWith('pb.') || connection.to.startsWith('pb.'))).toBe(true);
    expect(analyzeDesign(result.design).results.filter((r) => r.blocking)).toEqual([]);
  });

  it('resizes by whole-board rows while preserving multi-letter row ids', () => {
    const source = builtinCatalog().getBoard('perfboard_7x9@1')!;
    expect(boardShape(source)).toEqual({ columns: 27, rows: 35 });
    const derived = resizeBoardDefinition(source, { columns: 30, rows: 33 }, 'perfboard_7x9_custom');
    expect(derived.render.style).toBe('perfboard');
    expect(derived.terminal_blocks).toHaveLength(33);
    expect(derived.terminal_blocks.at(-1)?.rows).toEqual(['AG']);
    expect(derived.terminal_blocks.every((block) => block.columns === 30 && block.rows.length === 1)).toBe(true);
    const model = buildModel(build(perfboard), builtinCatalog());
    expect(model.boards.get('pb')?.def.render.style).toBe('perfboard');
    const reloaded = loadDesign(serializeDesign(build([{ op: 'add_board', board: { id: 'pb', model: 'perfboard_7x9@1', position_um: [0, 0], rotation_deg: 0 } }, { op: 'add_wire', wire: { id: 'w', from: { hole: 'pb.AA1' }, to: { hole: 'pb.AB1' }, color: 'red' } }])));
    expect(reloaded.ok).toBe(true);
    expect(reloaded.design?.wires[0]).toMatchObject({ from: { hole: 'pb.AA1' }, to: { hole: 'pb.AB1' } });
  });
});
