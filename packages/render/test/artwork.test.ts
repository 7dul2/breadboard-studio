import { describe, it, expect } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import type { RenderPrimitiveDef } from '@breadboard-studio/schema';
import { duplicateGroup, groupPrimitives, movePrimitive, primitiveBounds, rotatePrimitive, tagGroups } from '../src/index.js';

describe('artwork grouping', () => {
  it('merges the primitives of one small part and keeps the board body and module can apart', () => {
    const def = builtinCatalog().getComponent('esp32s3_n16r8_dual_usb@1')!;
    const groups = groupPrimitives(def.render, def.body.size_um);
    // Every primitive belongs to exactly one group.
    const all = groups.flatMap((g) => g.indices).sort((a, b) => a - b);
    expect(all).toEqual(def.render.map((_, i) => i));
    // The PCB background is alone and large.
    const background = groups.find((g) => g.indices.includes(0))!;
    expect(background.indices).toEqual([0]);
    expect(background.large).toBe(true);
    // A framed capacitor (frame + body + two end caps) is one part.
    const frameIndex = def.render.findIndex((p) => p.t === 'rect' && p.fill === 'none' && p.stroke === '#e4e7e3');
    expect(frameIndex).toBeGreaterThan(0);
    const cap = groups.find((g) => g.indices.includes(frameIndex))!;
    expect(cap.indices.length).toBe(4);
    expect(cap.large).toBe(false);
    // A button (outer + inner rect + two circles) is one part and the two buttons are different parts.
    const bootLabel = def.render.findIndex((p) => p.t === 'text' && p.text === 'BOOT');
    const rstLabel = def.render.findIndex((p) => p.t === 'text' && p.text === 'RST');
    const boot = groups.find((g) => g.indices.includes(bootLabel - 4))!;
    const rst = groups.find((g) => g.indices.includes(rstLabel - 4))!;
    expect(boot).not.toBe(rst);
    expect(boot.indices.length).toBeGreaterThanOrEqual(4);
    // Tagged primitives group by tag regardless of geometry.
    const tagged = tagGroups(def.render, groups);
    const again = groupPrimitives(tagged, def.body.size_um);
    expect(again.map((g) => g.indices)).toEqual(groups.map((g) => g.indices));
    const far: RenderPrimitiveDef[] = [
      { t: 'rect', x: 0, y: 0, w: 100, h: 100, g: 'a' },
      { t: 'rect', x: 5000, y: 5000, w: 100, h: 100, g: 'a' },
      { t: 'rect', x: 0, y: 5000, w: 100, h: 100 }
    ];
    expect(groupPrimitives(far, [10000, 10000]).map((g) => g.indices)).toEqual([[0, 1], [2]]);
  });

  it('move, rotate and duplicate keep shapes consistent', () => {
    const rect: RenderPrimitiveDef = { t: 'rect', x: 1000, y: 2000, w: 400, h: 200 };
    expect(movePrimitive(rect, 10, -20)).toEqual({ t: 'rect', x: 1010, y: 1980, w: 400, h: 200 });
    const line: RenderPrimitiveDef = { t: 'line', x1: 0, y1: 0, x2: 100, y2: 0 };
    expect(movePrimitive(line, 5, 5)).toEqual({ t: 'line', x1: 5, y1: 5, x2: 105, y2: 5 });
    const path: RenderPrimitiveDef = { t: 'path', d: 'M 100 200 L 300 400' };
    expect((movePrimitive(path, 10, 10) as { d: string }).d).toBe('M 110 210 L 310 410');
    // Four quarter turns about a point return the original rect.
    let r: RenderPrimitiveDef = rect;
    for (let i = 0; i < 4; i++) r = rotatePrimitive(r, 1200, 2100);
    expect(r).toEqual(rect);
    const once = rotatePrimitive(rect, 1200, 2100);
    expect(once.t === 'rect' ? [once.w, once.h] : null).toEqual([200, 400]);
    // Rotation keeps the centre.
    const b = primitiveBounds(once);
    expect([b.x + b.w / 2, b.y + b.h / 2]).toEqual([1200, 2100]);
    const t: RenderPrimitiveDef = { t: 'text', x: 0, y: 0, text: 'RGB', size: 600, rotate: 90 };
    expect((rotatePrimitive(t, 0, 0) as { rotate: number }).rotate).toBe(180);
    const group = groupPrimitives([rect, { t: 'circle', cx: 1200, cy: 2100, r: 50 }], [10000, 10000])[0]!;
    const copy = duplicateGroup([rect, { t: 'circle', cx: 1200, cy: 2100, r: 50 }], group, 1000, 0, 'n1');
    expect(copy.length).toBe(2);
    expect(copy.every((p) => p.g === 'n1')).toBe(true);
    expect((copy[0] as { x: number }).x).toBe(2000);
  });
});
