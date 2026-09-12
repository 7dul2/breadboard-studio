import { describe, it, expect } from 'vitest';
import type { ResolvedWire } from '@breadboard-studio/core';
import { wireScene } from '../src/index.js';

/**
 * 聚焦模式（dimUnhighlighted）只该影响"没被高亮也没被选中"的导线。
 * 这里用一根最小化导线锁定行为，免得以后改渲染时把压暗规则弄丢。
 */
function fixture(id: string): ResolvedWire {
  return {
    instance: { id, name: `wire ${id}`, color: 'red', route: 'flat', path_mode: 'auto', notes: '', locked: false },
    from: { kind: 'hole', address: 'bb.a1' },
    to: { kind: 'hole', address: 'bb.a2' },
    points: [
      [0, 0],
      [10000, 0]
    ],
    waypoints_um: [],
    length_um: 10000,
    conducts: true
  } as unknown as ResolvedWire;
}

const dimmed = (node: ReturnType<typeof wireScene>): boolean =>
  (node as { opacity?: number; cls?: string }).opacity !== undefined ||
  Boolean((node as { cls?: string }).cls?.includes('wire-dimmed'));

describe('wire focus dimming', () => {
  it('does not dim anything when the option is off', () => {
    expect(dimmed(wireScene(fixture('w1'), 1, {}))).toBe(false);
  });

  it('dims an unrelated wire when focus mode is on', () => {
    expect(dimmed(wireScene(fixture('w1'), 1, { dimUnhighlighted: true }))).toBe(true);
  });

  it('keeps a highlighted wire bright', () => {
    const node = wireScene(fixture('w1'), 1, { dimUnhighlighted: true, highlightWires: new Set(['w1']) });
    expect(dimmed(node)).toBe(false);
  });

  it('keeps the selected wire bright even if it is not in the highlight set', () => {
    const node = wireScene(fixture('w1'), 1, { dimUnhighlighted: true, selectedIds: new Set(['w1']) });
    expect(dimmed(node)).toBe(false);
  });
});
