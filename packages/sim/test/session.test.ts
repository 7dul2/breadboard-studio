/**
 * The M-S1 vertical slice, end to end and for real: the fixture snapshot, a
 * real QuickJS runtime, real sucrase, the real kernel and the real worker
 * session. Nothing here is a double except the two things that must not be
 * real — the wall clock and the host timer — because a test that waited on
 * actual milliseconds could not assert on determinism (plan §4.7).
 *
 * These cases are the machine evidence for M-S1 acceptance ①, ③ and ④.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { transform } from 'sucrase';
import type { ProgramAsset } from '@breadboard-studio/schema';
import type { WallClock } from '../src/contracts.js';
import { SIM_PROTOCOL_VERSION, type DeviceVisualState, type HostCommand, type RuntimeMessage, type SimDiagnostic, type SimulationSnapshot } from '../src/types.js';
import { SessionRuntime, type SessionRuntimeOptions } from '../src/worker/session.js';
import { fixtureSnapshot } from './devices/harness.js';

let quickjs: QuickJSWASMModule;

beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
}, 60_000);

/**
 * A clock the test owns. `step` is how far a single `nowMs()` reading moves it,
 * which is how the interrupt handler reaches its deadline without any real
 * timer; `ms` is moved explicitly whenever a host tick fires.
 */
class TestClock implements WallClock {
  ms = 0;
  constructor(private readonly step = 0.05) {}
  nowMs(): number {
    const value = this.ms;
    this.ms += this.step;
    return value;
  }
}

const SESSION_ID = 'sim-1';

/** Distributive omit: a plain `Omit` over the command union would collapse the variants. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'protocol' | 'sessionId'> : never;
type BareCommand = WithoutEnvelope<HostCommand>;

/** Drives one `SessionRuntime` by hand: no real timers, one pending tick at a time. */
class Harness {
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
}

function programWith(snapshot: SimulationSnapshot, source: string): ProgramAsset {
  const base = snapshot.programs[0];
  if (!base) throw new Error('fixture has no program');
  return { ...base, source };
}

// ---------------------------------------------------------------------------
// Programs under test. Line numbers matter for the budget case, so the sources
// are written out in full rather than assembled.
// ---------------------------------------------------------------------------

const BLINK_SOURCE = `import { gpio, Serial, sleep, micros, OUTPUT } from '@bbs/runtime';

const LED = 48;
let on = false;
let count = 0;

export async function setup(): Promise<void> {
  gpio.pinMode(LED, OUTPUT);
  Serial.begin(115200);
  Serial.println('ready');
}

export async function loop(): Promise<void> {
  on = !on;
  gpio.digitalWrite(LED, on ? 1 : 0);
  count = count + 1;
  Serial.println('tick ' + count + ' @' + micros() + ' r' + Math.round(Math.random() * 1000));
  await sleep(500);
}
`;

const SPIN_SOURCE = `import { Serial } from '@bbs/runtime';

export async function setup(): Promise<void> {
  Serial.begin(115200);
}

export async function loop(): Promise<void> {
  let spins = 0;
  while (true) {
    spins = spins + 1;
  }
}
`;
/**
 * Where the interrupt sampler lands for this program: the `loop` declaration.
 *
 * Measured, and not what plan §6.7 predicted: QuickJS reports an *async*
 * frame at the function's declaration line, so a `while (true)` directly
 * inside `loop()` is localised to the function rather than to the statement.
 * A synchronous frame does resolve to the hot line — SPIN_HELPER_SOURCE below
 * pins that, so the difference stays documented instead of surprising.
 */
const SPIN_ASYNC_LINE = 7;

const SPIN_HELPER_SOURCE = `import { Serial } from '@bbs/runtime';

function spin(): void {
  let spins = 0;
  while (true) {
    spins = spins + 1;
  }
}

export async function setup(): Promise<void> {
  Serial.begin(115200);
}

export async function loop(): Promise<void> {
  spin();
}
`;
/** `spins = spins + 1;` — the hot line inside the synchronous helper. */
const SPIN_HELPER_HOT_LINE = 6;

const DEADLOCK_SOURCE = `import { Serial } from '@bbs/runtime';

export async function setup(): Promise<void> {
  Serial.begin(115200);
}

export async function loop(): Promise<void> {
  await new Promise<void>(() => {});
}
`;

function blinkHarness(): Harness {
  const snapshot = fixtureSnapshot();
  const harness = new Harness();
  harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK_SOURCE) });
  harness.send({ type: 'run' });
  harness.run(600, () => harness.lastNowUs() >= 2_000_000);
  return harness;
}

// ---------------------------------------------------------------------------

describe('SessionRuntime', () => {
  describe('the blinking RGB vertical slice', () => {
    it('(a) prints setup output on the serial channel', () => {
      const harness = blinkHarness();
      expect(harness.serialText()).toContain('ready');
      // The session never faulted on the way there.
      expect(harness.diagnostics().filter((d) => d.severity === 'error')).toEqual([]);
      harness.send({ type: 'dispose' });
    });

    it('(b) toggles the on-board RGB between two values', () => {
      const harness = blinkHarness();
      const leds = harness
        .visualsOf('mcu')
        .map((states) => states.find((state) => state.kind === 'led'))
        .filter((state): state is Extract<DeviceVisualState, { kind: 'led' }> => state !== undefined)
        .map((state) => state.rgb.join(','));
      // The driver publishes its initial (dark) state, then one array per write.
      expect(leds.length).toBeGreaterThanOrEqual(4);
      expect(new Set(leds)).toEqual(new Set(['0,0,0', '255,255,255']));
      const changes = leds.filter((value, index) => index === 0 || value !== leds[index - 1]);
      expect(changes.length).toBeGreaterThanOrEqual(4);
      // Every device visual array carries all of that device's channels.
      for (const states of harness.visualsOf('mcu')) {
        expect(states.map((state) => `${state.kind}:${state.feature}`)).toEqual(['led:RGB', 'pressed:BOOT', 'pressed:RST']);
      }
      harness.send({ type: 'dispose' });
    });

    it('(c) advances virtual time monotonically', () => {
      const harness = blinkHarness();
      const series = harness.nowUsSeries();
      expect(series.length).toBeGreaterThan(3);
      expect(series[series.length - 1]).toBeGreaterThanOrEqual(2_000_000);
      for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] as number);
      // Virtual time only ever moves in the scheduler, so the 500 ms sleeps
      // land on exact multiples.
      expect(series[series.length - 1]! % 500_000).toBe(0);
      harness.send({ type: 'dispose' });
    });

    it('(f) replays byte-for-byte with the same seed', () => {
      const first = blinkHarness();
      const second = blinkHarness();
      expect(first.serialText().join('\n')).toBe(second.serialText().join('\n'));
      expect(first.serialText().length).toBeGreaterThan(3);
      expect(first.nowUsSeries()).toEqual(second.nowUsSeries());
      first.send({ type: 'dispose' });
      second.send({ type: 'dispose' });
    });

    it('reports the unimplemented devices once each, as info', () => {
      const harness = blinkHarness();
      const unsupported = harness.diagnostics().filter((d) => d.code === 'unsupported_device');
      expect(unsupported.map((d) => d.componentIds?.[0]).sort()).toEqual(['oled', 'touch']);
      for (const diagnostic of unsupported) expect(diagnostic.severity).toBe('info');
      harness.send({ type: 'dispose' });
    });

    it('pauses on command and stops moving virtual time', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK_SOURCE) });
      harness.send({ type: 'run' });
      harness.run(200, () => harness.lastNowUs() >= 1_000_000);
      harness.send({ type: 'pause' });
      const frozen = harness.lastNowUs();
      expect(harness.tick()).toBe(false);
      expect(harness.statuses()).toContain('paused');
      expect(harness.lastNowUs()).toBe(frozen);
      harness.send({ type: 'dispose' });
    });
  });

  describe('failure modes', () => {
    it('(d) faults a runaway loop with execution_budget_exceeded and a source line', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness({ clockStep: 0.25 });
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, SPIN_SOURCE) });
      harness.send({ type: 'run' });
      harness.run(20, () => harness.codes().includes('execution_budget_exceeded'));

      const budget = harness.diagnostics().find((d) => d.code === 'execution_budget_exceeded');
      expect(budget).toBeDefined();
      expect(budget!.severity).toBe('error');
      expect(budget!.source?.programId).toBe(snapshot.programs[0]!.id);
      expect(budget!.source?.line).toBe(SPIN_ASYNC_LINE);
      // The session stops driving itself; the controller turns the error into `faulted`.
      expect(harness.tick()).toBe(false);
      harness.send({ type: 'dispose' });
    });

    it('(d) locates the hot line itself when the loop runs in a synchronous frame', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness({ clockStep: 0.25 });
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, SPIN_HELPER_SOURCE) });
      harness.send({ type: 'run' });
      harness.run(20, () => harness.codes().includes('execution_budget_exceeded'));

      const budget = harness.diagnostics().find((d) => d.code === 'execution_budget_exceeded');
      expect(budget?.source?.line).toBe(SPIN_HELPER_HOT_LINE);
      harness.send({ type: 'dispose' });
    });

    it('(e) reports a permanently suspended program as simulation_deadlock', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, DEADLOCK_SOURCE) });
      harness.send({ type: 'run' });
      harness.run(20, () => harness.codes().includes('simulation_deadlock'));

      const deadlock = harness.diagnostics().find((d) => d.code === 'simulation_deadlock');
      expect(deadlock).toBeDefined();
      expect(deadlock!.severity).toBe('error');
      expect(deadlock!.atUs).toBeDefined();
      expect(harness.codes()).not.toContain('execution_budget_exceeded');
      harness.send({ type: 'dispose' });
    });

    it('waits for input instead of deadlocking when the session has an input source', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness({ hasInputSources: true });
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, DEADLOCK_SOURCE) });
      harness.send({ type: 'run' });
      harness.run(20, () => harness.codes().includes('waiting_for_input'));

      const waiting = harness.diagnostics().find((d) => d.code === 'waiting_for_input');
      expect(waiting?.severity).toBe('info');
      expect(harness.codes()).not.toContain('simulation_deadlock');
      expect(harness.statuses()[harness.statuses().length - 1]).toBe('paused');
      harness.send({ type: 'dispose' });
    });

    it('reports a compile error with a source location and never reaches prepared', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, "import fs from 'node:fs';\nexport async function loop() {}\n") });
      const compile = harness.diagnostics().find((d) => d.code === 'program_compile_error');
      expect(compile?.severity).toBe('error');
      expect(compile?.source?.line).toBe(1);
      expect(compile?.componentIds).toEqual(['mcu']);
      expect(harness.statuses()).not.toContain('prepared');
      harness.send({ type: 'dispose' });
    });

    it('surfaces a guest runtime error at the line that threw', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      const source = `import { Serial } from '@bbs/runtime';\n\nexport async function setup(): Promise<void> {\n  Serial.begin(115200);\n}\n\nexport async function loop(): Promise<void> {\n  throw new Error('boom');\n}\n`;
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, source) });
      harness.send({ type: 'run' });
      harness.run(10, () => harness.codes().includes('program_runtime_error'));
      const failure = harness.diagnostics().find((d) => d.code === 'program_runtime_error');
      expect(failure?.message).toContain('boom');
      expect(failure?.source?.line).toBe(8);
      harness.send({ type: 'dispose' });
    });
  });

  describe('I²C is honestly unavailable in M-S1', () => {
    it('fails every transaction with one warning and keeps running', () => {
      const snapshot = fixtureSnapshot();
      // The fixture's own program drives the OLED over I²C every iteration.
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: snapshot.programs[0]! });
      harness.send({ type: 'run' });
      harness.run(400, () => harness.lastNowUs() >= 200_000);

      const bus = harness.diagnostics().filter((d) => d.code === 'i2c_bus_unavailable');
      expect(bus).toHaveLength(1);
      expect(bus[0]!.severity).toBe('warning');
      expect(bus[0]!.message).toContain('M-S3');
      // A warning must not end the session: virtual time kept moving.
      expect(harness.diagnostics().filter((d) => d.severity === 'error')).toEqual([]);
      expect(harness.lastNowUs()).toBeGreaterThan(0);
      expect(harness.serialText()).toContain('ready');
      harness.send({ type: 'dispose' });
    });
  });

  describe('session control', () => {
    it('reset rebuilds the kernel and puts virtual time back to zero', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK_SOURCE) });
      harness.send({ type: 'run' });
      harness.run(200, () => harness.lastNowUs() >= 1_000_000);
      expect(harness.lastNowUs()).toBeGreaterThan(0);

      harness.send({ type: 'reset' });
      expect(harness.lastNowUs()).toBe(0);
      expect(harness.statuses().filter((status) => status === 'prepared')).toHaveLength(2);
      harness.send({ type: 'dispose' });
    });

    it('RST re-runs setup without resetting the kernel', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK_SOURCE) });
      harness.send({ type: 'run' });
      harness.run(200, () => harness.lastNowUs() >= 1_000_000);
      const beforeUs = harness.lastNowUs();
      const readies = harness.serialText().filter((line) => line === 'ready').length;

      harness.send({ type: 'control', event: { componentId: 'mcu', controlId: 'rst', action: 'press', value: true } });
      const held = harness.visualsOf('mcu').pop();
      expect(held?.find((state) => state.kind === 'pressed' && state.feature === 'RST')).toMatchObject({ active: true });

      harness.send({ type: 'control', event: { componentId: 'mcu', controlId: 'rst', action: 'press', value: false } });
      harness.run(120);
      expect(harness.serialText().filter((line) => line === 'ready').length).toBe(readies + 1);
      // Virtual time is kept: the board resets, the simulation does not.
      expect(harness.lastNowUs()).toBeGreaterThanOrEqual(beforeUs);
      harness.send({ type: 'dispose' });
    });

    it('step advances without leaving the session running', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK_SOURCE) });
      const before = harness.lastNowUs();
      harness.send({ type: 'step' });
      expect(harness.statuses()[harness.statuses().length - 1]).toBe('paused');
      expect(harness.lastNowUs()).toBeGreaterThanOrEqual(before);
      expect(harness.tick()).toBe(false);
      harness.send({ type: 'dispose' });
    });

    it('ignores commands from another session', () => {
      const snapshot = fixtureSnapshot();
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK_SOURCE) });
      const before = harness.messages.length;
      harness.session.handle({ protocol: SIM_PROTOCOL_VERSION, sessionId: 'sim-other', type: 'run' });
      expect(harness.messages.length).toBe(before);
      expect(harness.tick()).toBe(false);
      harness.send({ type: 'dispose' });
    });
  });
});
