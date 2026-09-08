import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_QUEUE, Scheduler, SchedulerOverflow } from '../src/scheduler.js';
import type { SimEvent } from '../src/contracts.js';

/** Records `type` of every event that fires, in firing order. */
function recorder(): { trace: string[]; run: (event: SimEvent) => void } {
  const trace: string[] = [];
  return { trace, run: (event) => trace.push(event.type) };
}

describe('Scheduler', () => {
  it('① fires out-of-order inserts by (atUs, seq)', () => {
    const s = new Scheduler();
    const { trace, run } = recorder();
    // The prototype's reference case: insert at 1000, 500, 1000, 1000.
    s.at(1000, 'test', 't1000#0', null, run);
    s.at(500, 'test', 't500#1', null, run);
    s.at(1000, 'test', 't1000#2', null, run);
    s.at(1000, 'test', 't1000#3', null, run);
    expect(s.queueDepth).toBe(4);

    const stamps: number[] = [];
    for (;;) {
      const event = s.advance();
      if (event === null) break;
      stamps.push(event.atUs);
    }
    expect(trace).toEqual(['t500#1', 't1000#0', 't1000#2', 't1000#3']);
    expect(stamps).toEqual([500, 1000, 1000, 1000]);
    expect(s.nowUs).toBe(1000);
    expect(s.queueDepth).toBe(0);
  });

  it('② keeps insertion order for 200 events at the same instant', () => {
    const s = new Scheduler();
    const { trace, run } = recorder();
    const expected: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      expected.push(`e${i}`);
      s.at(4242, 'test', `e${i}`, i, run);
    }
    const seqs: number[] = [];
    while (s.advance() !== null) seqs.push(s.queueDepth);
    expect(trace).toEqual(expected);
    // seq is monotonic, so the queue drains one entry at a time, never reordered.
    expect(seqs[0]).toBe(199);
    expect(s.nowUs).toBe(4242);
  });

  it('③ drops queueDepth immediately on cancel and never fires the entry', () => {
    const s = new Scheduler();
    const { trace, run } = recorder();
    s.at(100, 'test', 'keep', null, run);
    const doomed = s.at(50, 'test', 'doomed', null, run);
    expect(s.queueDepth).toBe(2);

    doomed.cancel();
    expect(doomed.cancelled).toBe(true);
    expect(s.queueDepth).toBe(1);
    // The tombstone is still physically at the head, but is invisible.
    expect(s.nextAtUs()).toBe(100);

    const event = s.advance();
    expect(event?.type).toBe('keep');
    expect(trace).toEqual(['keep']);
    expect(s.nowUs).toBe(100);
    expect(s.advance()).toBeNull();

    // Cancelling twice, or after firing, is a no-op.
    doomed.cancel();
    expect(s.queueDepth).toBe(0);
  });

  it('④ lets a periodic task cancel itself from inside its own callback', () => {
    const s = new Scheduler();
    const stamps: number[] = [];
    // The handle must survive every reschedule, otherwise this `cancel()` would
    // target an object the scheduler has already replaced.
    const handle = s.every(100, 'test', 'tick', null, (event) => {
      stamps.push(event.atUs);
      if (stamps.length === 3) handle.cancel();
    });
    while (s.advance() !== null) {
      /* drain */
    }
    expect(stamps).toEqual([100, 200, 300]);
    expect(handle.cancelled).toBe(true);
    expect(s.queueDepth).toBe(0);
    expect(s.nextAtUs()).toBeNull();
    expect(s.nowUs).toBe(300);
  });

  it('⑤ throws SchedulerOverflow once the queue ceiling is reached', () => {
    const s = new Scheduler({ maxQueue: 8 });
    const { trace, run } = recorder();
    const handles = [];
    for (let i = 0; i < 8; i += 1) handles.push(s.at(1000 + i, 'test', `e${i}`, null, run));
    expect(s.queueDepth).toBe(8);

    let thrown: unknown;
    try {
      s.at(2000, 'test', 'overflow', null, run);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchedulerOverflow);
    expect((thrown as SchedulerOverflow).queueDepth).toBe(8);
    expect((thrown as SchedulerOverflow).message).toContain('8');
    // The refused push left no trace.
    expect(s.queueDepth).toBe(8);

    // Cancelling one entry makes room again, and the refused event never fired.
    handles[3].cancel();
    expect(s.queueDepth).toBe(7);
    s.at(2000, 'test', 'accepted', null, run);
    expect(s.queueDepth).toBe(8);
    while (s.advance() !== null) {
      /* drain */
    }
    expect(trace).toEqual(['e0', 'e1', 'e2', 'e4', 'e5', 'e6', 'e7', 'accepted']);
    expect(DEFAULT_MAX_QUEUE).toBe(100_000);
  });

  it('⑥ rejects timestamps that are not integers or lie in the past', () => {
    const s = new Scheduler();
    const { run } = recorder();
    s.at(1000, 'test', 'e', null, run);
    s.advance();
    expect(s.nowUs).toBe(1000);

    expect(() => s.at(999, 'test', 'past', null, run)).toThrow(/早于当前虚拟时间/);
    expect(() => s.at(1000.5, 'test', 'fractional', null, run)).toThrow(/整数微秒/);
    expect(() => s.at(Number.NaN, 'test', 'nan', null, run)).toThrow(/整数微秒/);
    expect(() => s.at(Number.POSITIVE_INFINITY, 'test', 'inf', null, run)).toThrow(/整数微秒/);
    // The current instant is still allowed.
    expect(() => s.at(1000, 'test', 'now', null, run)).not.toThrow();
    expect(() => s.after(-1, 'test', 'back', null, run)).toThrow(/非负整数微秒/);
    expect(() => s.after(0.5, 'test', 'fractional', null, run)).toThrow(/非负整数微秒/);
    expect(() => s.every(0, 'test', 'zero', null, run)).toThrow(/正整数微秒/);
    expect(s.queueDepth).toBe(1);
  });

  it('advances virtual time only through advance(), and only forward', () => {
    const s = new Scheduler();
    const seen: number[] = [];
    s.after(0, 'test', 'immediate', null, () => seen.push(s.nowUs));
    s.after(250, 'test', 'later', null, () => seen.push(s.nowUs));
    expect(s.nowUs).toBe(0);
    expect(s.nextAtUs()).toBe(0);
    s.advance();
    expect(s.nowUs).toBe(0);
    s.advance();
    expect(s.nowUs).toBe(250);
    expect(seen).toEqual([0, 250]);
    expect(s.advance()).toBeNull();
    expect(s.nowUs).toBe(250);
  });

  it('carries source, type, payload and a never-reused seq on every event', () => {
    const s = new Scheduler();
    const events: SimEvent[] = [];
    const run = (event: SimEvent): void => void events.push(event);
    s.at(10, 'guest:sleep', 'wake', { token: 7 }, run);
    s.every(10, 'device:oled', 'refresh', 'payload', run);
    for (let i = 0; i < 3; i += 1) s.advance();
    expect(events[0]).toMatchObject({ atUs: 10, source: 'guest:sleep', type: 'wake', payload: { token: 7 } });
    expect(events[1]).toMatchObject({ atUs: 10, source: 'device:oled', type: 'refresh', payload: 'payload' });
    expect(events[2]).toMatchObject({ atUs: 20, source: 'device:oled', type: 'refresh' });
    const seqs = events.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('produces the same trace for the same insertion sequence', () => {
    const build = (): string[] => {
      const s = new Scheduler();
      const trace: string[] = [];
      const run = (event: SimEvent): void => {
        trace.push(`${event.atUs}:${event.type}`);
        if (event.type === 'seed') {
          s.after(30, 'test', 'child-a', null, run);
          s.after(30, 'test', 'child-b', null, run);
        }
      };
      s.at(0, 'test', 'seed', null, run);
      s.at(30, 'test', 'sibling', null, run);
      while (s.advance() !== null) {
        /* drain */
      }
      return trace;
    };
    expect(build()).toEqual(build());
    expect(build()).toEqual(['0:seed', '30:sibling', '30:child-a', '30:child-b']);
  });
});
