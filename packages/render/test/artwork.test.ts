import { describe, it, expect } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import type { RenderPrimitiveDef } from '@breadboard-studio/schema';
import { duplicateGroup, groupPrimitives, movePrimitive, primitiveBounds, rotatePrimitive, tagGroups } from '../src/index.js';

describe('artwork grouping', () => {
  /**
   * The geometric merging rules, on a fixture this test owns. They used to be pinned
   * to the ESP32 artwork by colour and by index arithmetic (`bootLabel - 4`), which
   * made a perfectly legitimate redraw of that board look like a code regression —
   * and now that the drawing ships fully tagged, grouping there is by tag anyway, so
   * those assertions no longer exercised the geometry at all.
   */
  it('merges overlapping small primitives into one part and leaves large ones alone', () => {
    const body: [number, number] = [10000, 10000];
    const framedCap: RenderPrimitiveDef[] = [
      { t: 'rect', x: 1000, y: 1000, w: 900, h: 600, fill: 'none', stroke: '#e4e7e3' }, // frame
      { t: 'rect', x: 1100, y: 1100, w: 700, h: 400 }, // body
      { t: 'rect', x: 1000, y: 1200, w: 120, h: 200 }, // end cap
      { t: 'rect', x: 1780, y: 1200, w: 120, h: 200 } // end cap
    ];
    const button = (x: number): RenderPrimitiveDef[] => [
      { t: 'rect', x, y: 6000, w: 800, h: 800 },
      { t: 'rect', x: x + 100, y: 6100, w: 600, h: 600 },
      { t: 'circle', cx: x + 400, cy: 6400, r: 200 }
    ];
    const pcb: RenderPrimitiveDef = { t: 'rect', x: 0, y: 0, w: 10000, h: 10000, fill: '#1f2937' };
    const render = [pcb, ...framedCap, ...button(1000), ...button(8000)];

    const groups = groupPrimitives(render, body);
    expect(groups.flatMap((g) => g.indices).sort((a, b) => a - b)).toEqual(render.map((_, i) => i));

    const background = groups.find((g) => g.indices.includes(0))!;
    expect(background.indices, 'the PCB is its own part').toEqual([0]);
    expect(background.large).toBe(true);

    const cap = groups.find((g) => g.indices.includes(1))!;
    expect(cap.indices, 'frame + body + two end caps are one part').toEqual([1, 2, 3, 4]);
    expect(cap.large).toBe(false);

    const left = groups.find((g) => g.indices.includes(5))!;
    const right = groups.find((g) => g.indices.includes(8))!;
    expect(left).not.toBe(right);
    expect(left.indices).toEqual([5, 6, 7]);
    expect(right.indices).toEqual([8, 9, 10]);

    // An explicit tag groups primitives that geometry would never have merged.
    const far: RenderPrimitiveDef[] = [
      { t: 'rect', x: 0, y: 0, w: 100, h: 100, g: 'a' },
      { t: 'rect', x: 5000, y: 5000, w: 100, h: 100, g: 'a' },
      { t: 'rect', x: 0, y: 5000, w: 100, h: 100 }
    ];
    expect(groupPrimitives(far, body).map((g) => g.indices)).toEqual([[0, 1], [2]]);
  });

  /** Invariants that must hold for the shipped drawing however it is redrawn. */
  it('partitions a real definition and stays stable once tagged', () => {
    const def = builtinCatalog().getComponent('esp32s3_n16r8_dual_usb@1')!;
    const groups = groupPrimitives(def.render, def.body.size_um);
    expect(groups.flatMap((g) => g.indices).sort((a, b) => a - b), 'every primitive is in exactly one part').toEqual(def.render.map((_, i) => i));

    const background = groups.find((g) => g.indices.includes(0))!;
    expect(background.indices).toEqual([0]);
    expect(background.large).toBe(true);

    // Tagging is what the artwork editor saves; re-reading it must produce the same parts.
    const tagged = tagGroups(def.render, groups);
    expect(tagged.every((p) => typeof p.g === 'string')).toBe(true);
    expect(groupPrimitives(tagged, def.body.size_um).map((g) => g.indices)).toEqual(groups.map((g) => g.indices));
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
