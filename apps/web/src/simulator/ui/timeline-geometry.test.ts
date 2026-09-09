import { describe, expect, it } from 'vitest';
import type { NetTransition } from '@breadboard-studio/sim';
import { fractionOf, isIndeterminate, levelOf, netsInTrace, segmentsFor, timelineWindow, valueBefore } from './timeline-geometry';

const trace: NetTransition[] = [
  { netId: 'a', atUs: 100, value: 1 },
  { netId: 'b', atUs: 150, value: 0 },
  { netId: 'a', atUs: 300, value: 0 },
  { netId: 'a', atUs: 500, value: 1 },
  { netId: 'b', atUs: 900, value: 'Z' }
];

describe('timeline geometry', () => {
  it('ends at now and never opens before the oldest edge we hold', () => {
    expect(timelineWindow(trace, 1000, 400), 'a wide window is clipped by the span').toEqual({ startUs: 600, endUs: 1000 });
    // A young session must not be drawn as a long silent run.
    expect(timelineWindow(trace, 1000, 5000)).toEqual({ startUs: 100, endUs: 1000 });
    expect(timelineWindow([], 0, 1000), 'never zero-width').toEqual({ startUs: 0, endUs: 1 });
  });

  it('lists the nets that moved, most recent first', () => {
    expect(netsInTrace(trace, 10)).toEqual(['b', 'a']);
    expect(netsInTrace(trace, 1)).toEqual(['b']);
    expect(netsInTrace([], 5)).toEqual([]);
  });

  it('knows what a net was doing before the window opened', () => {
    // The whole point: a net high for a minute is drawn high, not blank.
    expect(valueBefore(trace, 'a', 400)).toBe(0);
    expect(valueBefore(trace, 'a', 100)).toBe(1);
    expect(valueBefore(trace, 'a', 50), 'nothing yet is floating').toBe('Z');
  });

  it('covers the window with gapless segments', () => {
    const segments = segmentsFor(trace, 'a', { startUs: 0, endUs: 1000 });
    expect(segments).toEqual([
      { fromUs: 0, toUs: 100, value: 'Z' },
      { fromUs: 100, toUs: 300, value: 1 },
      { fromUs: 300, toUs: 500, value: 0 },
      { fromUs: 500, toUs: 1000, value: 1 }
    ]);
    // no gaps and no overlaps, whatever the window
    for (const start of [0, 120, 400, 999]) {
      const parts = segmentsFor(trace, 'a', { startUs: start, endUs: 1000 });
      expect(parts[0]!.fromUs).toBe(start);
      expect(parts[parts.length - 1]!.toUs).toBe(1000);
      for (let i = 1; i < parts.length; i++) expect(parts[i]!.fromUs).toBe(parts[i - 1]!.toUs);
    }
  });

  it('draws a net with no edges as one flat stretch', () => {
    expect(segmentsFor(trace, 'ghost', { startUs: 0, endUs: 100 })).toEqual([{ fromUs: 0, toUs: 100, value: 'Z' }]);
  });

  it('maps time and value onto the strip', () => {
    const window = { startUs: 100, endUs: 500 };
    expect(fractionOf(100, window)).toBe(0);
    expect(fractionOf(300, window)).toBe(0.5);
    expect(fractionOf(9999, window), 'clamped').toBe(1);
    expect(fractionOf(0, window)).toBe(0);
    expect(fractionOf(50, { startUs: 0, endUs: 0 }), 'no division by zero').toBe(0);

    expect(levelOf(1)).toBe(1);
    expect(levelOf(0)).toBe(0);
    expect(levelOf('Z'), 'indeterminate sits where it cannot be misread').toBe(0.5);
    expect(levelOf('X')).toBe(0.5);
    expect(isIndeterminate('Z')).toBe(true);
    expect(isIndeterminate('X')).toBe(true);
    expect(isIndeterminate(1)).toBe(false);
  });
});
