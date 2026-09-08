/**
 * The pump (plan §4.2 / §4.3 / §4.4).
 *
 * `SimLoop` is the *only* pump in the system. It owns the three budgets (wall
 * clock slice, advances per slice, queue ceiling) and the speed pacer; the
 * sandbox only implements `GuestBridge` and never advances virtual time.
 *
 * One iteration of `runSlice()` has a fixed shape, and the order is load
 * bearing:
 *
 *   armDeadline → drainJobs → takeTripped → pending jobs? keep draining
 *     → guest finished/failed? → queue empty? → budgets → speed → advance
 *
 * - the interrupt deadline is re-armed before *every* entry into the VM: once a
 *   deadline has expired, any later call returns `InternalError: interrupted`;
 * - the host's own trip flag beats whatever `drainJobs()` returned, because
 *   guest code can `.catch()` the interrupt exception;
 * - virtual time may only move when the guest is suspended, i.e. no microtask
 *   is pending and the driven promise is still `pending`.
 *
 * "Nothing to do" has two flavours and they must stay distinct: with an input
 * source (any device declaring `simulation.controls`) an empty queue means the
 * program is waiting for the user, which is `idle`; without one nothing can
 * ever wake it, which is `deadlock`.
 */
import type { SimulationSpeed } from '@breadboard-studio/schema';
import type { GuestBridge, Pacer, PumpOutcome, WallClock } from '../contracts.js';
import { SchedulerOverflow, type Scheduler } from '../scheduler.js';
import { SpeedPacer } from './pacer.js';

/** Wall-clock budget for one slice, in milliseconds (spec §14). */
export const DEFAULT_SLICE_MS = 5;
/** Maximum `scheduler.advance()` calls in one slice (spec §14). */
export const DEFAULT_EVENT_BUDGET = 10_000;

export interface SimLoopOptions {
  scheduler: Scheduler;
  guest: GuestBridge;
  clock: WallClock;
  /** True when any device declares `simulation.controls`; decides idle vs deadlock. */
  hasInputSources: boolean;
  sliceMs?: number;
  eventBudget?: number;
  speed?: SimulationSpeed;
  /**
   * Called exactly once before `stepOnce()` returns. The worker session passes
   * `() => outbox.flush()`: a step that leaves the UI unchanged looks like a
   * hang (plan §4.4).
   */
  flush?: () => void;
}

export class SimLoop {
  /** Exposed so the session can size its `setTimeout` from `waitMsFor(nextAtUs)`. */
  readonly pacer: Pacer;

  private readonly scheduler: Scheduler;
  private readonly guest: GuestBridge;
  private readonly clock: WallClock;
  private readonly hasInputSources: boolean;
  private readonly sliceMs: number;
  private readonly eventBudget: number;
  private readonly flushOutbox: (() => void) | null;

  constructor(options: SimLoopOptions) {
    this.scheduler = options.scheduler;
    this.guest = options.guest;
    this.clock = options.clock;
    this.hasInputSources = options.hasInputSources;
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    this.eventBudget = options.eventBudget ?? DEFAULT_EVENT_BUDGET;
    this.flushOutbox = options.flush ?? null;
    this.pacer = new SpeedPacer({ clock: options.clock, nowUs: () => this.scheduler.nowUs, speed: options.speed });
  }

  get speed(): SimulationSpeed {
    return this.pacer.speed;
  }

  /** Change speed; the pacer re-anchors itself to the current virtual time. */
  setSpeed(speed: SimulationSpeed): void {
    this.pacer.setSpeed(speed);
  }

  /** Re-anchor the pacer, e.g. when resuming from `paused` (plan §4.5). */
  reanchor(): void {
    this.pacer.reanchor(this.scheduler.nowUs);
  }

  /** Run until the slice, a budget, the speed pacer or the guest stops us. */
  runSlice(): PumpOutcome {
    const deadlineMs = this.clock.nowMs() + this.sliceMs;
    let advances = 0;
    for (;;) {
      const settled = this.drainToSuspend(deadlineMs);
      if (settled !== null) return settled;
      const nextAtUs = this.scheduler.nextAtUs();
      if (nextAtUs === null) return this.hasInputSources ? { kind: 'idle' } : { kind: 'deadlock' };
      // Checked before the wall clock: a `while (true) await sleep(0)` flood
      // burns advances without moving `nowUs`, and must fault rather than yield
      // forever.
      if (advances >= this.eventBudget) return { kind: 'budget', reason: 'event_budget' };
      if (this.clock.nowMs() >= deadlineMs) return { kind: 'yield' };
      if (this.pacer.waitMsFor(nextAtUs) > 0) return { kind: 'yield' };
      const failed = this.advanceOnce();
      if (failed !== null) return failed;
      advances += 1;
    }
  }

  /**
   * One user-visible step: drain, advance exactly once, drain again.
   *
   * Boundaries (plan §4.4): an already fulfilled guest does not move virtual
   * time; an empty queue leaves `nowUs` untouched and is never reported as a
   * deadlock, because the user asked for one step, not for a verdict.
   */
  stepOnce(): PumpOutcome {
    try {
      const deadlineMs = this.clock.nowMs() + this.sliceMs;
      const settled = this.drainToSuspend(deadlineMs);
      if (settled !== null) return settled;
      if (this.scheduler.nextAtUs() === null) return { kind: 'idle' };
      const failed = this.advanceOnce();
      if (failed !== null) return failed;
      // Event budget for a step is fixed at 1, so no second advance here.
      return this.drainToSuspend(deadlineMs) ?? { kind: 'yield' };
    } finally {
      this.reanchor();
      if (this.flushOutbox !== null) this.flushOutbox();
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * Drive the guest until it is suspended. Returns null when suspended (the
   * caller may move virtual time), or the outcome that ends the slice.
   */
  private drainToSuspend(deadlineMs: number): PumpOutcome | null {
    for (;;) {
      this.guest.armDeadline(deadlineMs);
      const jobs = this.guest.drainJobs();
      // The host flag first: the guest may have swallowed the interrupt.
      if (this.guest.takeTripped() !== null) return { kind: 'budget', reason: 'time_slice' };
      if (jobs.error !== undefined) return this.failureFor(jobs.error);
      if (jobs.hasPending) {
        // Backstop for a guest whose own interrupt handler never fires; never
        // advances virtual time while microtasks are pending.
        if (this.clock.nowMs() >= deadlineMs) return { kind: 'budget', reason: 'time_slice' };
        continue;
      }
      const state = this.guest.drivenState();
      if (state === 'fulfilled') return { kind: 'finished' };
      if (state !== 'pending') return this.failureFor(state.error);
      return null;
    }
  }

  private advanceOnce(): PumpOutcome | null {
    try {
      this.scheduler.advance();
      return null;
    } catch (error) {
      return this.failureFor(error);
    }
  }

  private failureFor(error: unknown): PumpOutcome {
    if (error instanceof SchedulerOverflow) return { kind: 'budget', reason: 'queue_overflow' };
    return { kind: 'fault', error };
  }
}
