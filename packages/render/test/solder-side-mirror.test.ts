import { describe, expect, it } from 'vitest';
import { applyOps, analyzeDesign, createEmptyDesign, type Op } from '@breadboard-studio/core';
import { boardMirrorPoint, buildScene, type SceneNode } from '../src/index.js';

/**
 * 焊接面（R2.4/R2.3）：翻面后该板上的元件/导线/文字必须跟着板自己的镜像轴走。
 * 这里不测像素，只测"落点是否仍然对得上"——这正是这轮改动最容易错的地方：
 * 镜像轴用错（元件自己的轮廓中心 / 全局 bounds 中心），元件就会离开它焊的那排孔。
 */

function design(ops: Op[], allowBlocking = false) {
  const r = applyOps(createEmptyDesign('t'), ops, { allow_blocking: allowBlocking });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.design;
}

const boardAt = (rotation_deg: 0 | 90 | 180 | 270 = 0): Op => ({
  op: 'add_board',
  board: { id: 'pb', model: 'perfboard_5x7@1', position_um: [0, 0], rotation_deg }
});

const moduleOnD5: Op = {
  op: 'add_component',
  component: {
    id: 'touch',
    model: 'ttp224_module@1',
    placement: { kind: 'board', board_id: 'pb', anchor_hole: 'D5', anchor_pin: 'VCC', rotation_deg: 0 }
  }
};

type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** 解析 scene 里出现过的 transform 原语（与 SceneView.tsx / svg.ts 的写法一致）。 */
function parseTransform(t: string | undefined): Mat {
  if (!t) return I;
  let m: Mat = I;
  const re = /(translate|rotate|scale)\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(t))) {
    const args = hit[2]!.trim().split(/[\s,]+/).map(Number);
    if (hit[1] === 'translate') m = mul(m, [1, 0, 0, 1, args[0]!, args[1] ?? 0]);
    else if (hit[1] === 'scale') m = mul(m, [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0]);
    else {
      const r = ((args[0] ?? 0) * Math.PI) / 180;
      const rot: Mat = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
      // rotate(a cx cy) 绕自身锚点；rotate(a) 绕原点
      m = args.length >= 3 ? mul(m, mul([1, 0, 0, 1, args[1]!, args[2]!], mul(rot, [1, 0, 0, 1, -args[1]!, -args[2]!]))) : mul(m, rot);
    }
  }
  return m;
}

type TextNode = Extract<SceneNode, { t: 'text' }>;

interface Entry {
  node: SceneNode;
  cls: string;
  m: Mat;
  center: [number, number];
}

function nodeTransform(n: SceneNode): string | undefined {
  if (n.t === 'text') {
    const parts: string[] = [];
    if (n.rotate) parts.push(`rotate(${n.rotate} ${n.x} ${n.y})`);
    if (n.unmirrorX) parts.push(`translate(${n.x} ${n.y}) scale(-1 1) translate(${-n.x} ${-n.y})`);
    return parts.length ? parts.join(' ') : undefined;
  }
  return n.t === 'group' ? n.transform : undefined;
}

function walkScene(scene: ReturnType<typeof buildScene>): Entry[] {
  const out: Entry[] = [];
  const walk = (n: SceneNode, parent: Mat, prefix: string) => {
    const m = mul(parent, parseTransform(nodeTransform(n)));
    const cls = [prefix, n.cls].filter(Boolean).join(' ');
    const center: [number, number] =
      n.t === 'text' ? apply(m, n.x, n.y)
      : n.t === 'circle' ? apply(m, n.cx, n.cy)
      : n.t === 'rect' ? apply(m, n.x + n.w / 2, n.y + n.h / 2)
      : apply(m, 0, 0);
    out.push({ node: { ...n, cls } as SceneNode, cls, m, center });
    if (n.t === 'group') for (const c of n.children) walk(c, m, cls);
  };
  for (const n of scene.nodes) walk(n, I, '');
  return out;
}

const has = (e: Entry, cls: string) => e.cls.split(' ').includes(cls);
const pick = (entries: Entry[], cls: string, data?: Record<string, string>) =>
  entries.find((e) => has(e, cls) && (!data || Object.entries(data).every(([k, v]) => (e.node.data as Record<string, string> | undefined)?.[k] === v)));
const texts = (entries: Entry[]) => entries.filter((e) => e.node.t === 'text') as Array<Entry & { node: TextNode }>;
const hole = (entries: Entry[], address: string) => pick(entries, 'hole', { hole: address })!;
const pad = (entries: Entry[], address: string) => pick(entries, 'pad', { hole: address })!;

const build = (ops: Op[], mirrored: string[], allowBlocking = false) => {
  const model = analyzeDesign(design(ops, allowBlocking)).model;
  const pb = model.boards.get('pb')!;
  const front = walkScene(buildScene(model, {}));
  const solder = walkScene(buildScene(model, { mirroredBoards: new Set(mirrored) }));
  return { model, pb, front, solder };
};

describe('焊接面镜像（R2.4）', () => {
  it('元件跟着它焊的那块板镜像：引脚仍落在同一个焊盘上', () => {
    const { front, solder } = build([boardAt(), moduleOnD5], ['pb']);
    const padFront = pad(front, 'pb.D5').center;
    const padSolder = pad(solder, 'pb.D5').center;
    // 孔跟着板走了（板体镜像本身没坏）
    expect(padSolder[0]).not.toBeCloseTo(padFront[0], 2);

    const pinFront = pick(front, 'pin', { pin: 'touch.VCC' })!;
    const pinSolder = pick(solder, 'pin', { pin: 'touch.VCC' })!;
    // 元件面：引脚就在焊盘上
    expect(pinFront.center[0]).toBeCloseTo(padFront[0], 1);
    expect(pinFront.center[1]).toBeCloseTo(padFront[1], 1);
    // 焊接面：元件整体镜像之后，引脚必须还落在同一个焊盘上（不是留在原地）
    expect(pinSolder.center[0]).toBeCloseTo(padSolder[0], 1);
    expect(pinSolder.center[1]).toBeCloseTo(padSolder[1], 1);
  });

  it('元件镜像轴 = 所属板局部 x = w/2（板旋转 90° 也成立）', () => {
    for (const rotation of [0, 90] as const) {
      // 板转 90° 后元件排针未必还落在孔里，这里只关心几何，允许 blocking
      const { pb, front, solder } = build([boardAt(rotation), moduleOnD5], ['pb'], true);
      const padFront = pad(front, 'pb.D5').center;
      const expected = boardMirrorPoint(pb, padFront);
      const padSolder = pad(solder, 'pb.D5').center;
      // 板体自身的镜像与 boardMirrorPoint 必须是同一个变换（顶层对象靠它对齐）
      expect(padSolder[0]).toBeCloseTo(expected[0], 1);
      expect(padSolder[1]).toBeCloseTo(expected[1], 1);
      const pinSolder = pick(solder, 'pin', { pin: 'touch.VCC' })!;
      expect(pinSolder.center[0]).toBeCloseTo(padSolder[0], 1);
      expect(pinSolder.center[1]).toBeCloseTo(padSolder[1], 1);
    }
  });

  it('焊接面文字正着读，但位置跟着板走（R2.3）', () => {
    const { front, solder } = build([boardAt(), moduleOnD5], ['pb']);
    // 行列标签：镜像后 "1" 跑到右边，但仍标注同一列（位置跟着孔）
    const labelFront = (c: string) => texts(front).find((e) => has(e, 'board-label') && e.node.text === c)!;
    const labelSolder = (c: string) => texts(solder).find((e) => has(e, 'board-label') && e.node.text === c)!;
    expect(labelFront('1').center[0]).toBeLessThan(labelFront('18').center[0]);
    expect(labelSolder('1').center[0]).toBeGreaterThan(labelSolder('18').center[0]);

    // 所有文字都不许是镜像字：线性部分行列式必须为正（旋转/平移到哪都行，反射不行）
    const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];
    for (const e of texts(solder)) expect(det(e.m), `${e.node.text} 不该被镜像`).toBeGreaterThan(0);
    // 元件名也一样（它是元件组里的文字，跟着元件一起翻）
    expect(det(texts(solder).find((e) => e.node.text === 'touch')!.m)).toBeGreaterThan(0);
  });

  it('逐板独立：翻 A 不影响 B（R2.1）', () => {
    const ops: Op[] = [
      boardAt(),
      { op: 'add_board', board: { id: 'pb2', model: 'perfboard_5x7@1', position_um: [80000, 0], rotation_deg: 0 } },
      moduleOnD5
    ];
    const model = analyzeDesign(design(ops)).model;
    const front = walkScene(buildScene(model, {}));
    const solder = walkScene(buildScene(model, { mirroredBoards: new Set(['pb']) }));
    const b2 = (list: Entry[]) => hole(list, 'pb2.A1').center;
    expect(b2(solder)[0]).toBeCloseTo(b2(front)[0], 3);
    expect(b2(solder)[1]).toBeCloseTo(b2(front)[1], 3);
    expect(hole(solder, 'pb.A1').center[0]).not.toBeCloseTo(hole(front, 'pb.A1').center[0], 2);
  });

  it('同板导线整根跟着板走，跨板导线只镜像板内那一端', () => {
    const ops: Op[] = [
      boardAt(),
      { op: 'add_board', board: { id: 'bb', model: 'breadboard_400@1', position_um: [120000, 0], rotation_deg: 0 } },
      { op: 'add_wire', wire: { id: 'w1', from: { hole: 'pb.A1' }, to: { hole: 'pb.X18' }, color: 'red' } },
      { op: 'add_wire', wire: { id: 'w2', from: { hole: 'pb.A3' }, to: { hole: 'bb.a1' }, color: 'blue' } }
    ];
    const { front, solder, pb } = build(ops, ['pb']);
    // 端点按 data-end 认（镜像后左右顺序会互换，不能靠排序对号）
    const endOf = (list: Entry[], id: string, end: string) =>
      list.find((e) => has(e, 'wire-end') && (e.node.data as Record<string, string>).wire === id && (e.node.data as Record<string, string>).end === end)!.center;

    // 同板导线：两端都跟着板镜像
    for (const end of ['from', 'to']) {
      const expected = boardMirrorPoint(pb, endOf(front, 'w1', end));
      expect(endOf(solder, 'w1', end)[0]).toBeCloseTo(expected[0], 1);
      expect(endOf(solder, 'w1', end)[1]).toBeCloseTo(expected[1], 1);
    }

    // 跨板导线：板内那端镜像了，面包板那端待在原地（板外对象完全不动）
    const fromFront = endOf(front, 'w2', 'from');
    expect(endOf(solder, 'w2', 'from')[0]).toBeCloseTo(boardMirrorPoint(pb, fromFront)[0], 1);
    expect(endOf(solder, 'w2', 'to')[0]).toBeCloseTo(endOf(front, 'w2', 'to')[0], 3);
    expect(endOf(solder, 'w2', 'to')[1]).toBeCloseTo(endOf(front, 'w2', 'to')[1], 3);
  });

  it('焊接面：该板元件压暗、穿孔引脚高亮（R3.1/R3.2）', () => {
    const { front, solder } = build([boardAt(), moduleOnD5], ['pb']);
    const compFront = front.find((e) => (e.node as { id?: string }).id === 'component:touch')!;
    const compSolder = solder.find((e) => (e.node as { id?: string }).id === 'component:touch')!;
    expect((compFront.node as { opacity?: number }).opacity).toBeUndefined();
    expect((compSolder.node as { opacity?: number }).opacity).toBeCloseTo(0.28, 3);
    // 元器件面不画高亮圈，焊接面画（画在焊盘之上：元件组排在板组之后）
    expect(front.filter((e) => has(e, 'pin-highlight'))).toHaveLength(0);
    const solderHl = solder.filter((e) => has(e, 'pin-highlight'));
    expect(solderHl.length).toBeGreaterThan(0);
    expect(solder.findIndex((e) => has(e, 'pin-highlight'))).toBeGreaterThan(solder.findIndex((e) => has(e, 'pad')));
    // 悬停/选中要恢复不透明（R3.4）
    const model = analyzeDesign(design([boardAt(), moduleOnD5])).model;
    const hl = walkScene(buildScene(model, { mirroredBoards: new Set(['pb']), highlightComponents: new Set(['touch']) }));
    expect((hl.find((e) => (e.node as { id?: string }).id === 'component:touch')!.node as { opacity?: number }).opacity).toBeUndefined();
  });

  it('无效焊桥不渲染（手改文件里的坏桥）', () => {
    const base = design([boardAt(), { op: 'add_board', board: { id: 'bb', model: 'breadboard_400@1', position_um: [120000, 0], rotation_deg: 0 } }]);
    const broken = { ...base, solder_bridges: [{ id: 'sb1', a: 'bb.a1', b: 'bb.a2' }] };
    const model = analyzeDesign(broken).model;
    expect(model.bridges.get('sb1')!.valid).toBe(false);
    const nodes = walkScene(buildScene(model, {}));
    expect(nodes.filter((e) => has(e, 'bridge-copper') || has(e, 'solder-bridge'))).toHaveLength(0);
  });
});
