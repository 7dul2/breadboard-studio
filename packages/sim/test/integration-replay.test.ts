/**
 * Recording and replay (阶段 4).
 *
 * The simulator has claimed determinism since M-S1 and proved it for a *fixed* event
 * sequence. A recording is what makes that claim usable: capture what a person did,
 * feed it back, and get the same run. This suite is the proof — it replays a recorded
 * session and compares the whole observable output, not a summary of it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { RecordedControl } from '../src/types.js';
import { fixtureSnapshot } from './devices/harness.js';
import { Harness, loadQuickJs, programWith } from './harness/session-harness.js';

beforeAll(loadQuickJs, 60_000);

const WATCH_TOUCH = `import { gpio, Serial, sleep, INPUT } from '@bbs/runtime';

const TOUCH = 4;
let last = -1;

export async function setup() {
  Serial.begin(115200);
  gpio.pinMode(TOUCH, INPUT);
  Serial.println('ready');
}

export async function loop() {
  const v = gpio.digitalRead(TOUCH);
  if (v !== last) {
    last = v;
    Serial.println('touch=' + v);
  }
  await sleep(5);
}
`;

/** Everything a user could observe, so "the same run" means the same run. */
function observed(harness: Harness) {
  return {
    serial: harness.serialText(),
    diagnostics: harness.diagnostics().map((d) => `${d.code}@${d.atUs ?? '-'}:${d.message}`)
  };
}

/** Let the program run for a while, so a press lands at a non-zero instant. */
function advance(harness: Harness, untilUs: number): void {
  harness.run(400, () => harness.lastNowUs() >= untilUs);
}

function press(harness: Harness, value: boolean): void {
  harness.send({ type: 'control', event: { componentId: 'touch', controlId: 'touch', action: 'touch', value } });
}

/** Controls the session actually accepted, with the instants it stamped them at. */
function recording(harness: Harness): RecordedControl[] {
  return harness.messages.flatMap((m) => (m.type === 'control-log' ? [m.entry] : []));
}

describe('recording and replay', () => {
  it('stamps each control with the virtual time it took effect', () => {
    const snapshot = fixtureSnapshot();
    const harness = new Harness();
    harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, WATCH_TOUCH) });
    harness.send({ type: 'run' });
    harness.run(200, () => harness.serialText().join('\n').includes('ready'));
    // setup() runs at virtual time zero, so let the loop turn before pressing.
    advance(harness, 50_000);

    press(harness, true);
    advance(harness, 100_000);
    press(harness, false);
    harness.run(60, () => false);

    const entries = recording(harness);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.event).toMatchObject({ componentId: 'touch', controlId: 'touch', value: true });
    expect(entries[1]!.event).toMatchObject({ value: false });
    expect(entries[0]!.atUs, 'stamped after the program was already running').toBeGreaterThan(0);
    expect(entries[1]!.atUs).toBeGreaterThan(entries[0]!.atUs);
    harness.send({ type: 'dispose' });
  });

  it('replays the recording to the same run', () => {
    const snapshot = fixtureSnapshot();
    const program = programWith(snapshot, WATCH_TOUCH);

    // 1. a live session with a person pressing the pad
    const live = new Harness();
    live.send({ type: 'prepare', snapshot, program });
    live.send({ type: 'run' });
    live.run(200, () => live.serialText().join('\n').includes('ready'));
    advance(live, 50_000);
    press(live, true);
    advance(live, 120_000);
    press(live, false);
    advance(live, 260_000);
    const entries = recording(live);
    expect(entries).toHaveLength(2);
    const original = observed(live);
    expect(original.serial.join('\n'), 'the pad really reached the program').toContain('touch=1');
    live.send({ type: 'dispose' });

    // 2. a fresh session fed the same events at the same instants
    const replayed = new Harness();
    replayed.send({ type: 'prepare', snapshot, program });
    replayed.send({ type: 'load-replay', entries });
    replayed.send({ type: 'run' });
    advance(replayed, 260_000);

    // The whole observable output, not a summary of it.
    expect(observed(replayed).serial).toEqual(original.serial);
    expect(observed(replayed).diagnostics).toEqual(original.diagnostics);
    // and the replay recorded itself identically, so a recording round-trips
    expect(recording(replayed).map((e) => ({ atUs: e.atUs, value: e.event.value }))).toEqual(
      entries.map((e) => ({ atUs: e.atUs, value: e.event.value }))
    );
    replayed.send({ type: 'dispose' });
  });

  it('delivers a replayed event at its recorded instant, not on arrival', () => {
    const snapshot = fixtureSnapshot();
    const entries: RecordedControl[] = [{ atUs: 60_000, event: { componentId: 'touch', controlId: 'touch', action: 'touch', value: true } }];
    const harness = new Harness();
    harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, WATCH_TOUCH) });
    harness.send({ type: 'load-replay', entries });
    harness.send({ type: 'run' });
    harness.run(600, () => recording(harness).length > 0);

    const stamped = recording(harness);
    expect(stamped, 'the event was delivered').toHaveLength(1);
    // Scheduled, not immediate: an event that arrived at time zero would make every
    // replay differ from the run it came from.
    expect(stamped[0]!.atUs).toBe(60_000);
    harness.send({ type: 'dispose' });
  });

  it('an empty recording changes nothing', () => {
    const snapshot = fixtureSnapshot();
    const harness = new Harness();
    harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, WATCH_TOUCH) });
    harness.send({ type: 'load-replay', entries: [] });
    harness.send({ type: 'run' });
    harness.run(200, () => harness.serialText().join('\n').includes('ready'));
    expect(recording(harness)).toEqual([]);
    expect(harness.statuses().at(-1)).toBe('running');
    harness.send({ type: 'dispose' });
  });
});
