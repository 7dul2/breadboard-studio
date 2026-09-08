/**
 * The shared rig for the two end-to-end suites: `session.test.ts` (M-S1/M-S2) and
 * `integration-touch-display.test.ts` (M-S3). Nothing here is a double except the
 * two things that must not be real — the wall clock and the host timer — because a
 * test that waited on actual milliseconds could not assert on determinism (§4.7).
 */
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import type { ProgramAsset } from '@breadboard-studio/schema';
import type { WallClock } from '../../src/contracts.js';
import {
  SIM_PROTOCOL_VERSION,
  type DeviceVisualState,
  type HostCommand,
  type NetRuntimeView,
  type RuntimeMessage,
  type SimDiagnostic,
  type SimulationSnapshot
} from '../../src/types.js';
import { SessionRuntime, type SessionRuntimeOptions } from '../../src/worker/session.js';
import { transform } from 'sucrase';

let quickjs: QuickJSWASMModule;

/** Load the wasm once per process; every suite awaits this in its own `beforeAll`. */
export async function loadQuickJs(): Promise<void> {
  if (!quickjs) quickjs = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
}

/**
 * A clock the test owns. `step` is how far a single `nowMs()` reading moves it,
 * which is how the interrupt handler reaches its deadline without any real
 * timer; `ms` is moved explicitly whenever a host tick fires.
 */
export class TestClock implements WallClock {
  ms = 0;
  constructor(private readonly step = 0.05) {}
  nowMs(): number {
    const value = this.ms;
    this.ms += this.step;
    return value;
  }
}

export const SESSION_ID = 'sim-1';

/** Distributive omit: a plain `Omit` over the command union would collapse the variants. */
export type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'protocol' | 'sessionId'> : never;
export type BareCommand = WithoutEnvelope<HostCommand>;

/** Drives one `SessionRuntime` by hand: no real timers, one pending tick at a time. */
export class Harness {
  readonly clock: TestClock;
  readonly messages: RuntimeMessage[] = [];
  readonly session: SessionRuntime;
  private pending: { delayMs: number; run: () => void } | null = null;

  constructor(options: Partial<SessionRuntimeOptions> & { clockStep?: number } = {}) {
    const { clockStep, ...rest } = options;
    this.clock = new TestClock(clockStep);
    this.session = new SessionRuntime({
      quickjs,
      transform,
      clock: this.clock,
      emit: (batch) => this.messages.push(...batch),
      schedule: (delayMs, run) => {
        this.pending = { delayMs, run };
        return () => {
          if (this.pending?.run === run) this.pending = null;
        };
      },
      // Every channel goes out on every tick: the throttling itself is covered
      // by outbox.test.ts, and here it would only hide messages.
      intervalsMs: { status: 0, serial: 0, 'visual-diff': 0, 'io-snapshot': 0, profile: 0 },
      ...rest
    });
  }

  send(command: BareCommand): void {
    this.session.handle({ protocol: SIM_PROTOCOL_VERSION, sessionId: SESSION_ID, ...command } as HostCommand);
  }

  /** Fire the pending host tick, moving the wall clock by the delay it asked for. */
  tick(): boolean {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = null;
    this.clock.ms += pending.delayMs;
    pending.run();
    return true;
  }

  /** Tick until `stop` says so, the session stops scheduling, or `limit` ticks. */
  run(limit: number, stop: () => boolean = () => false): number {
    for (let i = 0; i < limit; i++) {
      if (stop()) return i;
      if (!this.tick()) return i;
    }
    return limit;
  }

  diagnostics(): SimDiagnostic[] {
    return this.messages.flatMap((message) => (message.type === 'diagnostic' ? [message.diagnostic] : []));
  }

  codes(): string[] {
    return this.diagnostics().map((diagnostic) => diagnostic.code);
  }

  serialText(): string[] {
    return this.messages.flatMap((message) => (message.type === 'serial' ? [message.text] : []));
  }

  nowUsSeries(): number[] {
    return this.messages.flatMap((message) => (message.type === 'status' ? [message.nowUs] : []));
  }

  lastNowUs(): number {
    const series = this.nowUsSeries();
    return series.length === 0 ? 0 : (series[series.length - 1] as number);
  }

  statuses(): string[] {
    return this.messages.flatMap((message) => (message.type === 'status' ? [message.status] : []));
  }

  /** Every visual array published for one component, in order. */
  visualsOf(componentId: string): DeviceVisualState[][] {
    return this.messages.flatMap((message) =>
      message.type === 'visual-diff' && message.states[componentId] ? [message.states[componentId] as DeviceVisualState[]] : []
    );
  }

  /** The most recent net monitor projection, i.e. what the panel would show. */
  lastIoSnapshot(): NetRuntimeView[] {
    const snapshots = this.messages.flatMap((message) => (message.type === 'io-snapshot' ? [message.nets] : []));
    return snapshots[snapshots.length - 1] ?? [];
  }
}


/** Swap the fixture's program source, keeping its id and target. */
export function programWith(snapshot: SimulationSnapshot, source: string): ProgramAsset {
  const base = snapshot.programs[0];
  if (!base) throw new Error('fixture has no program');
  return { ...base, source };
}
