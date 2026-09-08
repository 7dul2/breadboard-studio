import { describe, it, expect } from 'vitest';
import { SIMULATION_SPEEDS } from '@breadboard-studio/schema';
import { SUPPORTED_SPEEDS, SpeedPacer } from '../src/worker/pacer.js';
import type { WallClock } from '../src/contracts.js';

/** Hand-advanced wall clock: no `vi.useFakeTimers()`, no real time anywhere. */
class TestClock implements WallClock {
  private ms = 0;
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

describe('SpeedPacer', () => {
  it('⑪ scales the wait by speed and re-anchors on setSpeed and reanchor', () => {
    const clock = new TestClock();
    let virtualUs = 0;
    const pacer = new SpeedPacer({ clock, nowUs: () => virtualUs });

    // 1×: one millisecond of wall clock per 1000 µs of virtual time.
    expect(pacer.speed).toBe(1);
    expect(pacer.waitMsFor(0)).toBe(0);
    expect(pacer.waitMsFor(1000)).toBe(1);
    expect(pacer.waitMsFor(2400000)).toBe(2400);
    clock.advance(1);
    expect(pacer.waitMsFor(1000)).toBe(0);
    expect(pacer.waitMsFor(2000)).toBe(1);
    // Timestamps already in the past never produce a negative wait.
    expect(pacer.waitMsFor(0)).toBe(0);

    // 10×: the same virtual span costs a tenth of the wall clock.
    virtualUs = 1000;
    pacer.setSpeed(10);
    expect(pacer.speed).toBe(10);
    expect(pacer.waitMsFor(1000)).toBe(0);
    expect(pacer.waitMsFor(2000)).toBeCloseTo(0.1, 10);
    expect(pacer.waitMsFor(2400000)).toBeCloseTo(239.9, 10);

    // 0.1×: ten times more wall clock for the same virtual span.
    pacer.setSpeed(0.1);
    expect(pacer.waitMsFor(2000)).toBeCloseTo(10, 10);
    expect(pacer.waitMsFor(2400000)).toBeCloseTo(23990, 10);

    // setSpeed re-anchored to (virtualUs=1000, wall=1): after 5 ms of wall
    // clock at 0.1× only 500 µs of virtual time are due.
    clock.advance(5);
    expect(pacer.waitMsFor(1500)).toBe(0);
    expect(pacer.waitMsFor(1600)).toBeCloseTo(1, 10);

    // An explicit re-anchor (resume from pause) forgets the debt built up
    // while the pump was not running.
    clock.advance(3000);
    virtualUs = 1500;
    expect(pacer.waitMsFor(1600)).toBe(0);
    pacer.reanchor(virtualUs);
    expect(pacer.waitMsFor(1600)).toBeCloseTo(1, 10);
  });

  it('mirrors the schema speed list and refuses anything else', () => {
    // The value list is copied into the worker-safe module on purpose (a value
    // import from the schema package would drag ajv into the worker chunk).
    expect([...SUPPORTED_SPEEDS]).toEqual([...SIMULATION_SPEEDS]);
    const clock = new TestClock();
    for (const speed of SIMULATION_SPEEDS) {
      const pacer = new SpeedPacer({ clock, nowUs: () => 0, speed });
      expect(pacer.speed).toBe(speed);
    }
    const pacer = new SpeedPacer({ clock, nowUs: () => 0 });
    expect(() => pacer.setSpeed(3 as (typeof SIMULATION_SPEEDS)[number])).toThrow(/不支持的仿真倍速/);
    expect(pacer.speed).toBe(1);
  });

  it('anchors on construction so the first event is never held back', () => {
    const clock = new TestClock();
    clock.advance(12345);
    const pacer = new SpeedPacer({ clock, nowUs: () => 900, speed: 2 });
    expect(pacer.waitMsFor(900)).toBe(0);
    expect(pacer.waitMsFor(1900)).toBeCloseTo(0.5, 10);
  });
});
