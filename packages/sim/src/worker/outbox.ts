/**
 * Outbound message throttling (plan §4.6).
 *
 * The same 16 ms tick that runs a slice also drains this outbox. Each channel
 * has its own minimum interval, so a busy simulation cannot flood the main
 * thread: `visual-diff` 33 ms, `serial` 50 ms, `status` 100 ms, `io-snapshot`
 * 200 ms, `profile` 500 ms. Diagnostics are never throttled — they are rare and
 * every one of them is evidence the user needs.
 *
 * Quantisation is real and intentional: a 16 ms tick against a 33 ms threshold
 * sends every 48 ms (21 FPS), which is under the 30 FPS ceiling of spec §14.
 *
 * Two merge rules matter:
 *
 * - `visual-diff` merges by componentId, last write wins. Drivers always post
 *   *all* of their visual channels at once (plan §7.1), so overwriting one
 *   component's array can never lose a sibling channel.
 * - `serial` is never concatenated. Several lines produced in one tick go out
 *   in one `postMessage` as separate messages, so `SerialLine` granularity and
 *   the controller's 5000-line ceiling keep their meaning.
 *
 * `flush()` forces everything out regardless of interval; the session owes a
 * flush at every step end, pause, fault and program end.
 */
import type { WallClock } from '../contracts.js';
import type { DeviceVisualState, RuntimeMessage, SimEnvelope } from '../types.js';
import { SIM_PROTOCOL_VERSION } from '../types.js';

export type OutboxChannel = RuntimeMessage['type'];

/** A runtime message before the outbox stamps `protocol` / `sessionId` onto it. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, keyof SimEnvelope> : never;
/** The outbox owns the frame counter, so callers do not supply `revision`. */
type WithOwnedRevision<T> = T extends { type: 'visual-diff' } ? Omit<T, 'revision'> & { revision?: number } : T;

export type OutboxMessage = WithOwnedRevision<WithoutEnvelope<RuntimeMessage>>;

type Bare<K extends OutboxChannel> = Extract<WithoutEnvelope<RuntimeMessage>, { type: K }>;

/** Per-channel minimum interval in milliseconds (plan §4.6). */
export const OUTBOX_INTERVALS_MS: Readonly<Record<OutboxChannel, number>> = {
  'visual-diff': 33,
  serial: 50,
  status: 100,
  'io-snapshot': 200,
  profile: 500,
  // Diagnostics are queued, never coalesced and never delayed.
  diagnostic: 0
};

/** Emission order inside one batch: payload first, then the status that describes it. */
export const OUTBOX_ORDER: readonly OutboxChannel[] = ['serial', 'diagnostic', 'visual-diff', 'io-snapshot', 'status', 'profile'];

export interface OutboxOptions {
  clock: WallClock;
  /** Session id stamped on every outgoing message. */
  sessionId: string;
  /** One call per drained batch. The worker forwards it to `postMessage`. */
  emit: (messages: RuntimeMessage[]) => void;
  /** Overrides for tests; missing channels keep `OUTBOX_INTERVALS_MS`. */
  intervalsMs?: Partial<Record<OutboxChannel, number>>;
}

export class Outbox {
  private readonly clock: WallClock;
  private readonly sessionId: string;
  private readonly emitBatch: (messages: RuntimeMessage[]) => void;
  private readonly intervals: Record<OutboxChannel, number>;
  private readonly lastSentMs: Record<OutboxChannel, number>;

  private readonly visuals = new Map<string, DeviceVisualState[]>();
  private readonly serialQueue: Bare<'serial'>[] = [];
  private readonly diagnosticQueue: Bare<'diagnostic'>[] = [];
  private status: Bare<'status'> | null = null;
  private io: Bare<'io-snapshot'> | null = null;
  private profile: Bare<'profile'> | null = null;
  private revision = 0;

  constructor(options: OutboxOptions) {
    this.clock = options.clock;
    this.sessionId = options.sessionId;
    this.emitBatch = options.emit;
    this.intervals = { ...OUTBOX_INTERVALS_MS, ...options.intervalsMs };
    // -Infinity so every channel is due on the very first tick.
    this.lastSentMs = { 'visual-diff': -Infinity, serial: -Infinity, status: -Infinity, 'io-snapshot': -Infinity, profile: -Infinity, diagnostic: -Infinity };
  }

  /** Number of messages that would go out on a `flush()` right now. */
  get pending(): number {
    return this.serialQueue.length + this.diagnosticQueue.length + (this.visuals.size > 0 ? 1 : 0) + (this.status === null ? 0 : 1) + (this.io === null ? 0 : 1) + (this.profile === null ? 0 : 1);
  }

  /** Frame counter of the last `visual-diff` that went out. Diagnostics only. */
  get lastRevision(): number {
    return this.revision;
  }

  post(message: OutboxMessage): void {
    switch (message.type) {
      case 'visual-diff':
        for (const componentId of Object.keys(message.states)) this.visuals.set(componentId, message.states[componentId]);
        return;
      case 'serial':
        this.serialQueue.push(message);
        return;
      case 'diagnostic':
        this.diagnosticQueue.push(message);
        return;
      case 'status':
        // Only the newest status matters; real transitions are followed by a
        // forced flush, so coalescing here cannot swallow one.
        this.status = message;
        return;
      case 'io-snapshot':
        this.io = message;
        return;
      case 'profile':
        this.profile = message;
        return;
    }
  }

  /** Send every channel whose minimum interval has elapsed. Called from the 16 ms tick. */
  tick(): void {
    this.drain(false);
  }

  /** Send everything pending now, ignoring the intervals. */
  flush(): void {
    this.drain(true);
  }

  /** Drop everything pending without sending it (session reset). */
  clear(): void {
    this.visuals.clear();
    this.serialQueue.length = 0;
    this.diagnosticQueue.length = 0;
    this.status = null;
    this.io = null;
    this.profile = null;
  }

  // ---------------------------------------------------------------- internals

  private drain(force: boolean): void {
    const nowMs = this.clock.nowMs();
    const batch: RuntimeMessage[] = [];
    for (const channel of OUTBOX_ORDER) {
      if (!force && nowMs - this.lastSentMs[channel] < this.intervals[channel]) continue;
      if (this.take(channel, batch)) this.lastSentMs[channel] = nowMs;
    }
    if (batch.length > 0) this.emitBatch(batch);
  }

  /** Move one channel's pending content into `batch`; false when it had none. */
  private take(channel: OutboxChannel, batch: RuntimeMessage[]): boolean {
    switch (channel) {
      case 'serial': {
        if (this.serialQueue.length === 0) return false;
        for (const message of this.serialQueue) batch.push(this.stamp(message));
        this.serialQueue.length = 0;
        return true;
      }
      case 'diagnostic': {
        if (this.diagnosticQueue.length === 0) return false;
        for (const message of this.diagnosticQueue) batch.push(this.stamp(message));
        this.diagnosticQueue.length = 0;
        return true;
      }
      case 'visual-diff': {
        if (this.visuals.size === 0) return false;
        const states: Record<string, DeviceVisualState[]> = {};
        for (const [componentId, value] of this.visuals) states[componentId] = value;
        this.visuals.clear();
        this.revision += 1;
        batch.push(this.stamp({ type: 'visual-diff', revision: this.revision, states }));
        return true;
      }
      case 'status': {
        if (this.status === null) return false;
        batch.push(this.stamp(this.status));
        this.status = null;
        return true;
      }
      case 'io-snapshot': {
        if (this.io === null) return false;
        batch.push(this.stamp(this.io));
        this.io = null;
        return true;
      }
      case 'profile': {
        if (this.profile === null) return false;
        batch.push(this.stamp(this.profile));
        this.profile = null;
        return true;
      }
    }
  }

  private stamp(message: WithoutEnvelope<RuntimeMessage>): RuntimeMessage {
    return { protocol: SIM_PROTOCOL_VERSION, sessionId: this.sessionId, ...message } as RuntimeMessage;
  }
}
