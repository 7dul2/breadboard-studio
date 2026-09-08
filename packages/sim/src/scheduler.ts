/**
 * Deterministic event queue and virtual clock (plan §4.1).
 *
 * The scheduler is the only writer of virtual time: `advance()` pops the head
 * of a binary min-heap, moves `nowUs` to that event's `atUs` and fires its
 * callback. Everything else in the kernel reads `nowUs` and schedules more
 * events; nothing may set the clock directly.
 *
 * Two properties make replays reproducible:
 *
 * - the heap is ordered by `(atUs, seq)`, and `seq` is globally monotonic and
 *   never reused, so events queued at the same instant fire in insertion order;
 * - cancellation is a tombstone, never an in-heap removal, so cancelling one
 *   timer cannot reshuffle the order of its neighbours. `queueDepth` drops
 *   immediately; the dead entry is dropped when it surfaces.
 *
 * A guest promise resolving is just another event callback: the deferred is
 * resolved *inside* the callback, and the scheduler knows nothing about it
 * (plan §1.4).
 */
import type { SimEvent, TimerHandle } from './contracts.js';

/** Queue ceiling from spec §14. Reaching it is unrecoverable and faults the session. */
export const DEFAULT_MAX_QUEUE = 100_000;

/** Thrown by `at()` / `after()` / `every()` when the queue is full. */
export class SchedulerOverflow extends Error {
  /** Number of live (non-cancelled) entries at the moment the push was refused. */
  readonly queueDepth: number;

  constructor(queueDepth: number, maxQueue: number) {
    super(`事件队列已满：待处理事件 ${queueDepth} 个，已达上限 ${maxQueue} 个，无法再排入新事件`);
    this.name = 'SchedulerOverflow';
    this.queueDepth = queueDepth;
  }
}

interface Entry {
  atUs: number;
  seq: number;
  source: string;
  type: string;
  payload: unknown;
  run: (event: SimEvent) => void;
  /** Reused across every reschedule of a periodic entry, so `cancel()` from inside the callback works. */
  handle: ScheduledHandle;
  /** Repeat interval for `every()`, null for one-shots. */
  periodUs: number | null;
  /** Tombstone: the entry stays in the heap but is skipped when it surfaces. */
  cancelled: boolean;
  /** False while the callback runs, so a self-cancel does not double-count `queueDepth`. */
  queued: boolean;
}

class ScheduledHandle implements TimerHandle {
  /** The one entry this handle owns. A periodic task keeps the same object forever. */
  entry: Entry | null = null;
  private done = false;

  constructor(private readonly onCancel: (handle: ScheduledHandle) => void) {}

  get cancelled(): boolean {
    return this.done;
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onCancel(this);
  }
}

function before(a: Entry, b: Entry): boolean {
  return a.atUs !== b.atUs ? a.atUs < b.atUs : a.seq < b.seq;
}

export class Scheduler {
  private readonly heap: Entry[] = [];
  private readonly limit: number;
  private readonly cancelEntry = (handle: ScheduledHandle): void => this.tombstone(handle);
  private now = 0;
  private seq = 0;
  /** Live (non-cancelled) entries in the heap. Tombstones are excluded the moment they are cancelled. */
  private live = 0;

  constructor(options: { maxQueue?: number } = {}) {
    const max = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isInteger(max) || max <= 0) throw new Error(`事件队列上限必须是正整数，收到 ${String(max)}`);
    this.limit = max;
  }

  /** Virtual time in integer microseconds. Only `advance()` moves it. */
  get nowUs(): number {
    return this.now;
  }

  /** Number of queued events that have not been cancelled. */
  get queueDepth(): number {
    return this.live;
  }

  get maxQueue(): number {
    return this.limit;
  }

  /** Schedule one event at an absolute virtual timestamp. `atUs === nowUs` is allowed. */
  at(atUs: number, source: string, type: string, payload: unknown, run: (event: SimEvent) => void): TimerHandle {
    if (!Number.isInteger(atUs)) throw new Error(`事件时间必须是整数微秒，收到 ${String(atUs)}`);
    if (atUs < this.now) throw new Error(`不能把事件排到过去：${atUs} µs 早于当前虚拟时间 ${this.now} µs`);
    return this.schedule(atUs, source, type, payload, run, null);
  }

  /** Schedule one event `delayUs` from now. `delayUs === 0` fires at the current instant. */
  after(delayUs: number, source: string, type: string, payload: unknown, run: (event: SimEvent) => void): TimerHandle {
    if (!Number.isInteger(delayUs) || delayUs < 0) throw new Error(`延时必须是非负整数微秒，收到 ${String(delayUs)}`);
    return this.at(this.now + delayUs, source, type, payload, run);
  }

  /**
   * Schedule a repeating event, first firing at `nowUs + periodUs`. The handle
   * is reused across reschedules, so cancelling from inside the callback stops
   * the timer instead of cancelling an object that has already been replaced.
   */
  every(periodUs: number, source: string, type: string, payload: unknown, run: (event: SimEvent) => void): TimerHandle {
    if (!Number.isInteger(periodUs) || periodUs <= 0) throw new Error(`周期必须是正整数微秒，收到 ${String(periodUs)}`);
    return this.schedule(this.now + periodUs, source, type, payload, run, periodUs);
  }

  /** Timestamp of the next live event, after discarding tombstones at the head. */
  nextAtUs(): number | null {
    this.dropCancelledHead();
    const head = this.heap[0];
    return head === undefined ? null : head.atUs;
  }

  /**
   * Pop the head, move `nowUs` to it and fire its callback. Returns the event
   * that fired, or null when the queue holds nothing live.
   */
  advance(): SimEvent | null {
    this.dropCancelledHead();
    const entry = this.pop();
    if (entry === undefined) return null;
    this.live -= 1;
    this.now = entry.atUs;
    const event: SimEvent = { atUs: entry.atUs, seq: entry.seq, source: entry.source, type: entry.type, payload: entry.payload };
    // Re-arm before running so an exception in the callback cannot silently
    // stop a periodic timer; a `cancel()` inside the callback still wins,
    // because the handle points at this very entry.
    if (entry.periodUs !== null && !entry.handle.cancelled) {
      entry.atUs += entry.periodUs;
      entry.seq = this.seq++;
      this.push(entry);
    }
    entry.run(event);
    return event;
  }

  // ---------------------------------------------------------------- internals

  private schedule(atUs: number, source: string, type: string, payload: unknown, run: (event: SimEvent) => void, periodUs: number | null): TimerHandle {
    const handle = new ScheduledHandle(this.cancelEntry);
    const entry: Entry = { atUs, seq: this.seq++, source, type, payload, run, handle, periodUs, cancelled: false, queued: false };
    handle.entry = entry;
    this.push(entry);
    return handle;
  }

  private tombstone(handle: ScheduledHandle): void {
    const entry = handle.entry;
    if (entry === null) return;
    // Stops a periodic entry that is currently executing its callback.
    entry.periodUs = null;
    if (!entry.queued || entry.cancelled) return;
    entry.cancelled = true;
    this.live -= 1;
  }

  private push(entry: Entry): void {
    if (this.live >= this.limit) throw new SchedulerOverflow(this.live, this.limit);
    entry.queued = true;
    this.live += 1;
    const heap = this.heap;
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(heap[index], heap[parent])) break;
      const swap = heap[parent];
      heap[parent] = heap[index];
      heap[index] = swap;
      index = parent;
    }
  }

  private pop(): Entry | undefined {
    const heap = this.heap;
    const head = heap[0];
    if (head === undefined) return undefined;
    const last = heap.pop() as Entry;
    if (heap.length > 0) {
      heap[0] = last;
      this.siftDown();
    }
    head.queued = false;
    return head;
  }

  private siftDown(): void {
    const heap = this.heap;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) return;
      const swap = heap[smallest];
      heap[smallest] = heap[index];
      heap[index] = swap;
      index = smallest;
    }
  }

  private dropCancelledHead(): void {
    for (;;) {
      const head = this.heap[0];
      if (head === undefined || !head.cancelled) return;
      this.pop();
    }
  }
}
