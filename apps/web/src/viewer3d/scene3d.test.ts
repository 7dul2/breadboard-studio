import { describe, it, expect } from 'vitest';
import { applyOps, buildModel, createEmptyDesign, type Op } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { BOARD_THICKNESS_MM, HOLE_RADIUS_MM, buildScene3D, arcFactors, wirePath3D } from './scene3d';

const catalog = builtinCatalog();

function build(ops: Op[]) {
  const r = applyOps(createEmptyDesign('3d'), ops, { catalog });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return buildModel(r.design, catalog);
}

const oneBoard: Op[] = [{ op: 'add_board', board: { id: 'bb', model: 'breadboard_830@1', position_um: [0, 0] } }];

describe('3D 预览的几何生成', () => {
  it('面包板是一块实体：顶面在 y=0，厚度固定，孔全部实例化', () => {
    const model = build(oneBoard);
    const scene = buildScene3D(model);
    const board = scene.prims.find((p) => p.key === 'board:bb');
    expect(board).toBeTruthy();
    if (board?.kind !== 'box') throw new Error('board 应该是 box');
    expect(board.size[1]).toBe(BOARD_THICKNESS_MM);
    // 中心在 -t/2，所以顶面正好落在 y=0（元件和导线都以板面为基准）
    expect(board.center[1]).toBeCloseTo(-BOARD_THICKNESS_MM / 2, 9);
    expect(board.size[0]).toBeCloseTo(165.1, 1);
    expect(board.size[2]).toBeCloseTo(54.6, 1);
    expect(scene.holes.length).toBe(model.boards.get('bb')!.resolved.holes.size);
    expect(scene.holes.every((h) => h.r === HOLE_RADIUS_MM)).toBe(true);
  });

  it('立式元件用全局 footprint 定位（不能把坐标加两遍）', () => {
    const ops: Op[] = [
      ...oneBoard,
      { op: 'add_component', component: { id: 'sw1', model: 'tactile_6x6@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j60', anchor_pin: 'A', rotation_deg: 0 } } }
    ];
    const model = build(ops);
    const pc = model.components.get('sw1')!;
    expect(pc.resolved.orientation).toBe('upright');
    const scene = buildScene3D(model);
    const box = scene.prims.find((p) => p.key === 'component:sw1');
    if (box?.kind !== 'box') throw new Error('应该有本体 box');
    // 本体中心必须落在元件自己的全局位置附近（曾经错成两倍）
    const f = pc.footprint;
    expect(box.center[0]).toBeCloseTo((f.x + f.w / 2) / 1000, 1);
    expect(box.center[2]).toBeCloseTo((f.y + f.h / 2) / 1000, 1);
    // 立起来：站着的高度是模块的短边，不是 0
    expect(box.center[1]).toBeGreaterThan(1);
    expect(box.size[1]).toBeGreaterThan(1);
  });

  it('平放元件的高度取 body.height_um，外观矩形贴到顶面', () => {
    const ops: Op[] = [...oneBoard, { op: 'add_component', component: { id: 'tft', model: 'tft_1_77_st7735_spi@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j6', anchor_pin: 'GND', rotation_deg: 0 } } }];
    const model = build(ops);
    const pc = model.components.get('tft')!;
    const scene = buildScene3D(model);
    const box = scene.prims.find((p) => p.key === 'component:tft');
    if (box?.kind !== 'box') throw new Error('应该有本体 box');
    expect(box.size[1]).toBeCloseTo(pc.def.body.height_um / 1000, 6);
    // 外观块贴在顶面之上
    const art = scene.prims.filter((p) => p.key.startsWith('art:tft'));
    expect(art.length).toBeGreaterThan(0);
    for (const a of art) {
      if (a.kind !== 'box') throw new Error('art 应该是 box');
      expect(a.center[1]).toBeGreaterThan(box.size[1]);
    }
  });

  it('排针按引脚位置生成，数量对得上', () => {
    const ops: Op[] = [
      ...oneBoard,
      { op: 'add_component', component: { id: 'sw1', model: 'tactile_6x6@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j60', anchor_pin: 'A', rotation_deg: 0 } } }
    ];
    const model = build(ops);
    const scene = buildScene3D(model);
    expect(scene.pins.length).toBe(model.components.get('sw1')!.pins.length);
    expect(scene.pins[0]!.component).toBe('sw1');
  });

  it('导线是管：两端落在板面，中间拱起来', () => {
    const ops: Op[] = [...oneBoard, { op: 'add_wire', wire: { from: { hole: 'bb.a30' }, to: { hole: 'bb.a40' }, color: 'red', route: 'flat' } }];
    const model = build(ops);
    const scene = buildScene3D(model);
    const tube = scene.prims.find((p) => p.kind === 'tube');
    if (tube?.kind !== 'tube') throw new Error('应该有导线 tube');
    const ys = tube.points.map((p) => p[1]);
    expect(ys[0]).toBeCloseTo(0, 6);
    expect(ys[ys.length - 1]).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeGreaterThan(2);
    expect(scene.prims.filter((p) => p.kind === 'tube').length).toBe(1);
  });

  it('架空走的线更高', () => {
    const flat = wirePath3D(
      [
        [0, 0],
        [20, 0]
      ],
      2.8
    );
    const elevated = wirePath3D(
      [
        [0, 0],
        [20, 0]
      ],
      5
    );
    expect(Math.max(...elevated.map((p) => p[1]))).toBeGreaterThan(Math.max(...flat.map((p) => p[1])));
  });

  it('弧长参数端点固定 0/1 且单调', () => {
    const f = arcFactors([
      [0, 0],
      [10, 0],
      [10, 10]
    ]);
    expect(f[0]).toBe(0);
    expect(f[f.length - 1]).toBe(1);
    expect(f[1]).toBeCloseTo(0.5, 9);
  });

  it('包围盒罩住所有实体，统计数对得上', () => {
    const ops: Op[] = [
      ...oneBoard,
      { op: 'add_component', component: { id: 'sw1', model: 'tactile_6x6@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j60', anchor_pin: 'A', rotation_deg: 0 } } },
      { op: 'add_wire', wire: { from: { hole: 'bb.a30' }, to: { hole: 'bb.a40' }, color: 'red', route: 'elevated' } }
    ];
    const model = build(ops);
    const scene = buildScene3D(model);
    expect(scene.stats).toMatchObject({ boards: 1, components: 1, wires: 1, tubes: 1 });
    expect(scene.stats.boxes).toBe(scene.prims.filter((p) => p.kind === 'box').length);
    for (const p of scene.prims) {
      const pts: [number, number, number][] = p.kind === 'box' ? [p.center] : p.points;
      for (const [x, y, z] of pts) {
        expect(x).toBeGreaterThanOrEqual(scene.bounds.min[0] - 0.001);
        expect(x).toBeLessThanOrEqual(scene.bounds.max[0] + 0.001);
        expect(y).toBeGreaterThanOrEqual(scene.bounds.min[1] - 0.001);
        expect(y).toBeLessThanOrEqual(scene.bounds.max[1] + 0.001);
        expect(z).toBeGreaterThanOrEqual(scene.bounds.min[2] - 0.001);
        expect(z).toBeLessThanOrEqual(scene.bounds.max[2] + 0.001);
      }
    }
  });

  it('空设计不会炸：包围盒退化到原点', () => {
    const scene = buildScene3D(build([]));
    expect(scene.prims).toEqual([]);
    expect(scene.bounds.min).toEqual([0, 0, 0]);
    expect(scene.bounds.max).toEqual([0, 0, 0]);
  });
});
