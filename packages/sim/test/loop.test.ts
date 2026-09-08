import { describe, it, expect } from 'vitest';
import type { SimulationSpeed } from '@breadboard-studio/schema';
import { DEFAULT_EVENT_BUDGET, DEFAULT_SLICE_MS, SimLoop } from '../src/worker/loop.js';
import { Scheduler, SchedulerOverflow } from '../src/scheduler.js';
import type { GuestBridge, WallClock } from '../src/contracts.js';

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

/**
 * Scriptable stand-in for `StudioTsSandbox`. No QuickJS is loaded here: the
 * pump only ever sees this four-method seam.
 */
class FakeGuest implements GuestBridge {
  readonly armed: number[] = [];
  drainCalls = 0;
  state: 'pending' | 'fulfilled' | { error: unknown } = 'pending';
  /** Remaining `drainJobs()` calls that report pending microtasks. */
  pendingJobs = 0;
  alwaysPending = false;
  jobError: unknown = undefined;
  onDrain: ((call: number) => void) | null = null;
  private trippedFlag = false;

  armDeadline(untilMs: number): void {
    this.armed.push(untilMs);
  }

  drainJobs(): { hasPending: boolean; error?: unknown } {
    this.drainCalls += 1;
    if (this.onDrain !== null) this.onDrain(this.drainCalls);
    const hasPending = this.alwaysPending || this.pendingJobs > 0;
    if (this.pendingJobs > 0) this.pendingJobs -= 1;
    const error = this.jobError;
    this.jobError = undefined;
    return { hasPending, error };
  }

  drivenState(): 'pending' | 'fulfilled' | { error: unknown } {
    return this.state;
  }

  takeTripped(): 'time_slice' | null {
    const tripped = this.trippedFlag;
    this.trippedFlag = false;
    return tripped ? 'time_slice' : null;
  }

  /** The host's own interrupt flag, set from inside the VM. */
  trip(): void {
    this.trippedFlag = true;
  }
}

function harness(
  options: { hasInputSources?: boolean; sliceMs?: number; eventBudget?: number; maxQueue?: number; speed?: SimulationSpeed; flush?: () => void; warmMs?: number } = {}
): {
  clock: TestClock;
  scheduler: Scheduler;
  guest: FakeGuest;
  loop: SimLoop;
} {
  const clock = new TestClock();
  const scheduler = new Scheduler({ maxQueue: options.maxQueue });
  const guest = new FakeGuest();
  const loop = new SimLoop({
    scheduler,
    guest,
    clock,
    hasInputSources: options.hasInputSources ?? false,
    sliceMs: options.sliceMs,
    eventBudget: options.eventBudget,
    speed: options.speed,
    flush: options.flush
  });
  // Moving the wall clock past the pacer's anchor makes every event due, so a
  // test about the slice shape is not also a test about pacing.
  clock.advance(options.warmMs ?? 0);
  return { clock, scheduler, guest, loop };
}

describe('SimLoop budgets', () => {
  it('⑦ stops on the event budget without moving virtual time', () => {
    // `while (true) await sleep(0)`: every event re-arms itself at the current
    // instant, so the wall clock and `nowUs` both stand still.
    const { scheduler, loop } = harness();
    let fires = 0;
    const refire = (): void => {
      fires += 1;
      scheduler.at(scheduler.nowUs, 'guest:sleep', 'sleep0', null, refire);
    };
    scheduler.at(0, 'guest:sleep', 'sleep0', null, refire);

    expect(loop.runSlice()).toEqual({ kind: 'budget', reason: 'event_budget' });
    expect(fires).toBe(DEFAULT_EVENT_BUDGET);
    expect(DEFAULT_EVENT_BUDGET).toBe(10_000);
    expect(scheduler.nowUs).toBe(0);
    expect(scheduler.queueDepth).toBe(1);
  });

  it('⑧ trusts the host trip flag over whatever the guest returned', () => {
    // The guest swallowed the interrupt: it claims it still has microtasks and
    // never reports an error, but the host flag fired.
    const swallowed = harness();
    swallowed.guest.alwaysPending = true;
    swallowed.guest.onDrain = () => swallowed.guest.trip();
    swallowed.scheduler.at(1000, 'device:test', 'later', null, () => undefined);

    expect(swallowed.loop.runSlice()).toEqual({ kind: 'budget', reason: 'time_slice' });
    expect(swallowed.guest.drainCalls).toBe(1);
    expect(swallowed.scheduler.nowUs).toBe(0);
    expect(swallowed.guest.armed[0]).toBe(DEFAULT_SLICE_MS);

    // Even a guest that reports "finished" loses to the flag.
    const finished = harness();
    finished.guest.state = 'fulfilled';
    finished.guest.onDrain = () => finished.guest.trip();
    expect(finished.loop.runSlice()).toEqual({ kind: 'budget', reason: 'time_slice' });

    // And a guest whose own interrupt handler never fires is still cut off by
    // the host's wall-clock backstop once the slice is spent.
    const starved = harness();
    starved.guest.alwaysPending = true;
    starved.guest.onDrain = () => starved.clock.advance(2);
    expect(starved.loop.runSlice()).toEqual({ kind: 'budget', reason: 'time_slice' });
    expect(starved.guest.drainCalls).toBe(3);
    expect(starved.scheduler.nowUs).toBe(0);
    expect(DEFAULT_SLICE_MS).toBe(5);
  });

  it('⑨ tells an idle wait apart from a deadlock by the presence of input sources', () => {
    const waiting = harness({ hasInputSources: true });
    expect(waiting.loop.runSlice()).toEqual({ kind: 'idle' });
    expect(waiting.scheduler.nowUs).toBe(0);

    const stuck = harness({ hasInputSources: false });
    expect(stuck.loop.runSlice()).toEqual({ kind: 'deadlock' });
    expect(stuck.scheduler.nowUs).toBe(0);

    // A queue that still holds work is neither.
    const busy = harness({ hasInputSources: false, warmMs: 1_000_000 });
    busy.scheduler.at(1000, 'device:test', 'later', null, () => undefined);
    expect(busy.loop.runSlice()).toEqual({ kind: 'deadlock' });
    expect(busy.scheduler.nowUs).toBe(1000);
  });

  it('reports a queue overflow as a budget outcome, not a fault', () => {
    const { scheduler, loop } = harness({ maxQueue: 4, warmMs: 1_000_000 });
    const explode = (): void => {
      scheduler.after(1, 'device:test', 'a', null, explode);
      scheduler.after(1, 'device:test', 'b', null, explode);
    };
    scheduler.at(0, 'device:test', 'seed', null, explode);
    expect(loop.runSlice()).toEqual({ kind: 'budget', reason: 'queue_overflow' });

    // Same verdict when the overflow escapes through a host bridge function
    // and comes back as the guest's job error.
    const viaGuest = harness({ maxQueue: 1 });
    viaGuest.guest.jobError = new SchedulerOverflow(1, 1);
    expect(viaGuest.loop.runSlice()).toEqual({ kind: 'budget', reason: 'queue_overflow' });
  });
});

describe('SimLoop slice shape', () => {
  it('re-arms the interrupt deadline before every entry into the VM', () => {
    const { clock, scheduler, guest, loop } = harness({ warmMs: 1_000_000 });
    for (const at of [100, 200, 300]) scheduler.at(at, 'device:test', 'tick', null, () => undefined);
    const deadline = clock.nowMs() + DEFAULT_SLICE_MS;
    expect(loop.runSlice()).toEqual({ kind: 'deadlock' });
    // One arm per drain, and one drain per suspension.
    expect(guest.armed).toHaveLength(guest.drainCalls);
    expect(guest.drainCalls).toBe(4);
    expect(guest.armed.every((armed) => armed === deadline)).toBe(true);
    expect(scheduler.nowUs).toBe(300);
  });

  it('never advances virtual time while microtasks are pending', () => {
    const { scheduler, guest, loop } = harness({ warmMs: 1_000_000 });
    guest.pendingJobs = 3;
    const seen: number[] = [];
    scheduler.at(50, 'device:test', 'tick', null, () => seen.push(guest.drainCalls));
    expect(loop.runSlice()).toEqual({ kind: 'deadlock' });
    // Three drains reported pending work, the fourth suspended; only then did
    // the event fire.
    expect(seen).toEqual([4]);
    expect(scheduler.nowUs).toBe(50);
  });

  it('finishes when the driven call resolves and faults when it rejects', () => {
    const done = harness();
    done.guest.state = 'fulfilled';
    done.scheduler.at(10, 'device:test', 'unused', null, () => undefined);
    expect(done.loop.runSlice()).toEqual({ kind: 'finished' });
    expect(done.scheduler.nowUs).toBe(0);

    const failed = harness();
    const boom = new Error('boom');
    failed.guest.state = { error: boom };
    expect(failed.loop.runSlice()).toEqual({ kind: 'fault', error: boom });

    const jobFailed = harness();
    jobFailed.guest.jobError = boom;
    expect(jobFailed.loop.runSlice()).toEqual({ kind: 'fault', error: boom });
  });

  it('yields on speed throttling and on a spent slice, with work still queued', () => {
    const throttled = harness({ speed: 1 });
    throttled.scheduler.at(0, 'device:test', 'now', null, () => undefined);
    throttled.scheduler.at(1_000_000, 'device:test', 'in-one-second', null, () => undefined);
    expect(throttled.loop.runSlice()).toEqual({ kind: 'yield' });
    // The due event ran, the one a second away did not.
    expect(throttled.scheduler.nowUs).toBe(0);
    expect(throttled.scheduler.queueDepth).toBe(1);
    // After a second of wall clock it is due.
    throttled.clock.advance(1000);
    expect(throttled.loop.runSlice()).toEqual({ kind: 'deadlock' });
    expect(throttled.scheduler.nowUs).toBe(1_000_000);

    const spent = harness({ warmMs: 1_000_000 });
    spent.guest.onDrain = () => spent.clock.advance(3);
    for (const at of [10, 20, 30]) spent.scheduler.at(at, 'device:test', 'tick', null, () => undefined);
    // Two drains cost 6 ms of wall clock, so the slice ends between events —
    // a yield, not the fault the interrupt flag would have caused.
    expect(spent.loop.runSlice()).toEqual({ kind: 'yield' });
    expect(spent.scheduler.nowUs).toBe(10);
    expect(spent.scheduler.queueDepth).toBe(2);
  });
});

describe('SimLoop.stepOnce', () => {
  it('⑩ advances exactly one event, holds still at the boundaries and always flushes', () => {
    // (a) the guest already finished: no event may fire.
    let flushes = 0;
    const finished = harness({ flush: () => void (flushes += 1) });
    finished.guest.state = 'fulfilled';
    finished.scheduler.at(100, 'device:test', 'tick', null, () => undefined);
    expect(finished.loop.stepOnce()).toEqual({ kind: 'finished' });
    expect(finished.scheduler.nowUs).toBe(0);
    expect(finished.scheduler.queueDepth).toBe(1);
    expect(flushes).toBe(1);

    // (b) empty queue: virtual time stands still and this is NOT a deadlock,
    // even without input sources — the user asked for one step, not a verdict.
    flushes = 0;
    const empty = harness({ hasInputSources: false, flush: () => void (flushes += 1) });
    expect(empty.loop.stepOnce()).toEqual({ kind: 'idle' });
    expect(empty.scheduler.nowUs).toBe(0);
    expect(flushes).toBe(1);

    // (c) the normal case: exactly one advance, even when more work is due at
    // the same instant (the step event budget is fixed at 1).
    flushes = 0;
    const stepping = harness({ flush: () => void (flushes += 1) });
    const fired: string[] = [];
    stepping.scheduler.at(100, 'device:test', 'first', null, (event) => fired.push(event.type));
    stepping.scheduler.at(100, 'device:test', 'second', null, (event) => fired.push(event.type));
    stepping.scheduler.at(200, 'device:test', 'third', null, (event) => fired.push(event.type));
    expect(stepping.loop.stepOnce()).toEqual({ kind: 'yield' });
    expect(fired).toEqual(['first']);
    expect(stepping.scheduler.nowUs).toBe(100);
    expect(stepping.scheduler.queueDepth).toBe(2);
    expect(flushes).toBe(1);
    // The time slice stays armed across both drain phases.
    expect(stepping.guest.armed).toHaveLength(2);
    expect(stepping.guest.armed).toEqual([DEFAULT_SLICE_MS, DEFAULT_SLICE_MS]);

    expect(stepping.loop.stepOnce()).toEqual({ kind: 'yield' });
    expect(fired).toEqual(['first', 'second']);
    expect(flushes).toBe(2);

    // A step also re-anchors the pacer, so the wall clock spent while paused is
    // not paid back as a burst.
    stepping.clock.advance(5_000);
    stepping.loop.stepOnce();
    expect(stepping.scheduler.nowUs).toBe(200);
    expect(stepping.loop.pacer.waitMsFor(1_200)).toBe(1);
    expect(flushes).toBe(3);
  });

  it('flushes once even when the step ends in a fault', () => {
    let flushes = 0;
    const { guest, loop } = harness({ flush: () => void (flushes += 1) });
    const boom = new Error('boom');
    guest.state = { error: boom };
    expect(loop.stepOnce()).toEqual({ kind: 'fault', error: boom });
    expect(flushes).toBe(1);
  });
});

describe('SimLoop speed', () => {
  it('⑬ produces the same event trace at every speed, only the wall clock differs', () => {
    // `sliceMs: Infinity` is the precondition for this invariant to hold: the
    // 5 ms time slice is itself wall-clock dependent, so at 0.1× a finite slice
    // would cut the run at different events than at 10×. Speed must only move
    // real time — never the event order or the `nowUs` sequence.
    function run(speed: SimulationSpeed): { trace: string[]; wallMs: number } {
      const clock = new TestClock();
      const scheduler = new Scheduler();
      const guest = new FakeGuest();
      const trace: string[] = [];
      const record = (event: { atUs: number; type: string }): void => void trace.push(`${event.atUs}:${event.type}`);
      for (let i = 0; i < 20; i += 1) scheduler.at(i * 1000, 'device:test', `e${i}`, null, record);
      const loop = new SimLoop({ scheduler, guest, clock, hasInputSources: false, sliceMs: Infinity, speed });

      for (let guard = 0; guard < 1000; guard += 1) {
        const outcome = loop.runSlice();
        if (outcome.kind === 'deadlock') return { trace, wallMs: clock.nowMs() };
        expect(outcome).toEqual({ kind: 'yield' });
        const nextAtUs = scheduler.nextAtUs();
        expect(nextAtUs).not.toBeNull();
        // Stand in for the worker's `setTimeout(min(16, waitMsFor(next)))`.
        clock.advance(loop.pacer.waitMsFor(nextAtUs as number));
      }
      throw new Error('the run never settled');
    }

    const base = run(1);
    const fast = run(10);
    const slow = run(0.1);

    expect(base.trace).toHaveLength(20);
    expect(fast.trace).toEqual(base.trace);
    expect(slow.trace).toEqual(base.trace);
    expect(base.wallMs).toBeCloseTo(19, 6);
    expect(fast.wallMs).toBeCloseTo(1.9, 6);
    expect(slow.wallMs).toBeCloseTo(190, 6);
    expect(base.wallMs / fast.wallMs).toBeCloseTo(10, 6);
    expect(slow.wallMs / base.wallMs).toBeCloseTo(10, 6);
  });

  it('setSpeed re-anchors so the switch is not paid back as a burst', () => {
    const { clock, scheduler, loop } = harness({ speed: 1 });
    scheduler.at(0, 'device:test', 'seed', null, () => undefined);
    scheduler.at(10_000, 'device:test', 'later', null, () => undefined);
    expect(loop.runSlice()).toEqual({ kind: 'yield' });
    expect(loop.pacer.waitMsFor(10_000)).toBe(10);

    clock.advance(4);
    loop.setSpeed(10);
    expect(loop.speed).toBe(10);
    // Re-anchored at (nowUs=0, wall=4): the remaining 10 ms of virtual time now
    // costs 1 ms, and the 4 ms already spent are not credited back.
    expect(loop.pacer.waitMsFor(10_000)).toBeCloseTo(1, 10);
    clock.advance(1);
    expect(loop.runSlice()).toEqual({ kind: 'deadlock' });
    expect(scheduler.nowUs).toBe(10_000);
  });
});
