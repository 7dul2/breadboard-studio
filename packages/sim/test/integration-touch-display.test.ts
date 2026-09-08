/**
 * The whole thing, end to end, on the reference design (plan §11.3, spec §15).
 *
 * Real QuickJS, real sucrase, the real kernel, the real fixture program — and the
 * real `examples/touch_display.breadboard.json`, mutated through the same
 * transaction engine the editor uses, so a "counter-example" here is a design a
 * user could actually build by mis-wiring one thing.
 *
 * The four counter-examples are the point of the suite. Each has to produce a
 * *distinguishable* result — the triple `(code, componentIds, screen state)` — and
 * the session has to stay running through all four, because none of them is a
 * simulator failure: they are all working simulations of a broken circuit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOps, loadDesign, type Op } from '@breadboard-studio/core';
import { buildSnapshot } from '../src/index.js';
import type { DeviceVisualState, SimDiagnostic, SimulationSnapshot } from '../src/types.js';
import { Harness, loadQuickJs, programWith } from './harness/session-harness.js';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'examples', 'touch_display.breadboard.json');

beforeAll(loadQuickJs, 60_000);

function baseDesign() {
  const loaded = loadDesign(readFileSync(FIXTURE, 'utf8'));
  if (!loaded.ok || !loaded.design) throw new Error('fixture failed to load');
  return loaded.design;
}

/** The fixture as edited by `ops`, through the real engine. */
function snapshotOf(ops: Op[] = []): SimulationSnapshot {
  const design = baseDesign();
  if (ops.length === 0) return buildSnapshot(design);
  const r = applyOps(design, ops, { allow_blocking: true });
  if (!r.ok) throw new Error(`fixture edit refused: ${r.error.message}`);
  return buildSnapshot(r.design);
}

function screenOf(harness: Harness): Extract<DeviceVisualState, { kind: 'display' }> | null {
  const frames = harness.visualsOf('oled');
  const last = frames[frames.length - 1]?.find((s) => s.kind === 'display');
  return last && last.kind === 'display' ? last : null;
}

function onPixels(harness: Harness): number {
  const screen = screenOf(harness);
  if (!screen) return 0;
  let n = 0;
  for (const v of screen.pixels) if (v > 0) n++;
  return n;
}

function rgbOf(harness: Harness): [number, number, number] | null {
  const frames = harness.visualsOf('mcu');
  for (let i = frames.length - 1; i >= 0; i--) {
    const led = frames[i]!.find((s) => s.kind === 'led');
    if (led && led.kind === 'led') return led.rgb;
  }
  return null;
}

/** Prepare + run the fixture's own program until `stop`, or `limit` host ticks. */
function runFixture(snapshot: SimulationSnapshot, limit: number, stop: () => boolean): Harness {
  const harness = new Harness();
  harness.send({ type: 'prepare', snapshot, program: snapshot.programs[0]! });
  harness.send({ type: 'run' });
  harness.run(limit, stop);
  return harness;
}

function touch(harness: Harness, value: boolean): void {
  harness.send({ type: 'control', event: { componentId: 'touch', controlId: 'touch', action: 'touch', value } });
}

/** The identity of an outcome: what happened, to whom, and what the screen did. */
function outcome(harness: Harness): { codes: string[]; componentIds: string[]; enabled: boolean; lit: boolean } {
  const relevant = harness
    .diagnostics()
    .filter((d) => d.code !== 'unsupported_device')
    .filter((d) => d.severity !== 'info');
  const screen = screenOf(harness);
  return {
    codes: [...new Set(relevant.map((d) => d.code))].sort(),
    componentIds: [...new Set(relevant.flatMap((d: SimDiagnostic) => d.componentIds ?? []))].sort(),
    enabled: screen?.enabled ?? false,
    lit: onPixels(harness) > 0
  };
}

describe('touch_display · the whole stack', () => {
  it('① draws the screen, hears the pad and lights the RGB — all through the real wiring', () => {
    const snapshot = snapshotOf();
    const harness = runFixture(snapshot, 900, () => false);
    // 1. the program reached the end of setup
    expect(harness.serialText().join('\n'), 'begin() acknowledged, so the panel is present').toContain('ready');
    // 2. virtual time is moving and nothing failed
    expect(harness.lastNowUs()).toBeGreaterThan(0);
    expect(harness.diagnostics().filter((d) => d.severity === 'error')).toEqual([]);
    // 3. the panel is on and something is actually drawn on it
    expect(screenOf(harness)!.enabled).toBe(true);
    expect(onPixels(harness), 'the fixture writes "Ready" every frame').toBeGreaterThan(0);
    const ready = onPixels(harness);
    // 4. the RGB is blue while untouched
    expect(rgbOf(harness)).toEqual([0, 0, 120]);

    // 5. a real press on the pad travels through the net to the program
    touch(harness, true);
    harness.run(600, () => harness.serialText().join('\n').includes('touch=1'));
    expect(harness.serialText().join('\n')).toContain('touch=1');
    // 6. the screen text changed with it. The serial line is printed at the top of the
    // iteration and `show()` finishes ~23 ms later, so the frame has to be let through.
    harness.run(200, () => false);
    const touched = onPixels(harness);
    expect(touched, '"Touched" is a different word from "Ready"').not.toBe(ready);
    // 7. and the RGB went green at the same time — the joint assertion of §11.3
    expect(rgbOf(harness)).toEqual([0, 180, 0]);
    expect(screenOf(harness)!.enabled).toBe(true);

    harness.send({ type: 'dispose' });
  });

  it('replays identically: same design, same program, same instants', () => {
    const snapshot = snapshotOf();
    const trace = () => {
      const h = runFixture(snapshot, 300, () => false);
      return { serial: h.serialText(), nowUs: h.lastNowUs(), pixels: onPixels(h), rgb: rgbOf(h) };
    };
    const first = trace();
    expect(first.serial.join('\n')).toContain('ready');
    expect(first.pixels).toBeGreaterThan(0);
    expect(trace()).toEqual(first);
  });

  describe('the four ways to break it, each reported differently', () => {
    const results: Record<string, ReturnType<typeof outcome>> = {};

    it('cut SDA: the module is on no bus the controller can see', () => {
      // Cutting w7 leaves *both* ends unwired — the wire was the only thing joining
      // the two hole groups — so this fails one step earlier than a NACK: the bus
      // never comes up. That is the more actionable message, and it is what makes
      // this outcome distinguishable from the wrong-address one below.
      const harness = runFixture(snapshotOf([{ op: 'remove_wire', id: 'w7' }]), 500, () => false);
      const bus = harness.diagnostics().filter((d) => d.code === 'i2c_bus_unavailable');
      // Two, and only two, however long it runs: begin() reporting the unwired pin,
      // and the client library's first transaction reporting that there is no bus.
      // Each is deduplicated to a single line; the loop runs hundreds of times.
      expect(bus).toHaveLength(2);
      expect(bus[0]!.message, 'names the pin, not an address').toContain('SDA');
      expect(new Set(bus.map((d) => d.message)).size).toBe(2);
      expect(harness.diagnostics().filter((d) => d.code === 'i2c_nack')).toEqual([]);
      expect(harness.serialText().join('\n'), 'begin() returned false, so the program knows').toContain('oled missing');
      expect(screenOf(harness)!.enabled, 'the panel was never turned on').toBe(false);
      expect(onPixels(harness)).toBe(0);
      expect(harness.statuses().at(-1), 'a mis-wired circuit still runs').toBe('running');
      results.cutSda = outcome(harness);
      harness.send({ type: 'dispose' });
    });

    it('wrong address: the bus is fine, nobody answers at 0x3d', () => {
      const harness = runFixture(snapshotOf([{ op: 'update_property', id: 'oled', path: 'config.i2c_address', value: 0x3d }]), 500, () => false);
      const nack = harness.diagnostics().filter((d) => d.code === 'i2c_nack');
      expect(nack).toHaveLength(1);
      expect(nack[0]!.componentIds, 'the module is there, it just answers elsewhere').toEqual(['oled']);
      expect(nack[0]!.message).toContain('0x3d');
      expect(nack[0]!.netIds, 'both wires are intact').toEqual(['net_cdaf224f2998', 'net_be9ee4e90a68']);
      expect(screenOf(harness)!.enabled).toBe(false);
      expect(harness.statuses().at(-1)).toBe('running');
      results.wrongAddress = outcome(harness);
      harness.send({ type: 'dispose' });
    });

    it('no power: the module cannot answer at all', () => {
      const harness = runFixture(snapshotOf([{ op: 'remove_wire', id: 'w5' }]), 500, () => false);
      expect(harness.codes()).toContain('device_unpowered');
      expect(screenOf(harness)!.enabled, 'a dark panel, not a blank one').toBe(false);
      expect(onPixels(harness)).toBe(0);
      expect(harness.statuses().at(-1)).toBe('running');
      results.unpowered = outcome(harness);
      harness.send({ type: 'dispose' });
    });

    it('GPIO contention: two drivers fight over the touch net', () => {
      const snapshot = snapshotOf();
      const source = `import { gpio, Serial, sleep, OUTPUT, HIGH } from '@bbs/runtime';

export async function setup() {
  Serial.begin(115200);
  gpio.pinMode(4, OUTPUT);
  Serial.println('ready');
}

export async function loop() {
  gpio.digitalWrite(4, HIGH);
  await sleep(5);
}
`;
      const harness = new Harness();
      harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, source) });
      harness.send({ type: 'run' });
      harness.run(200, () => harness.serialText().join('\n').includes('ready'));
      // the TTP223 drives the same net low; the MCU pushes it high
      harness.run(300, () => harness.codes().includes('digital_contention'));
      expect(harness.codes()).toContain('digital_contention');
      expect(harness.statuses().at(-1)).toBe('running');
      results.contention = outcome(harness);
      harness.send({ type: 'dispose' });
    });

    it('and the four outcomes are pairwise distinguishable', () => {
      const keys = Object.keys(results);
      expect(keys, 'every counter-example ran').toHaveLength(4);
      const signatures = keys.map((k) => JSON.stringify(results[k]));
      // Not "four distinct codes" — the requirement is that the triple a user reads
      // (code, who, what the screen did) differs. Two of these could legitimately
      // share a code; what must never happen is two breakages looking identical.
      expect(new Set(signatures).size, `signatures: ${signatures.join(' | ')}`).toBe(4);
      // The two I²C failures are told apart by which step failed and by who is named:
      // a cut wire never gets a bus, a wrong address gets one and finds nobody home.
      expect(results.cutSda!.codes).toEqual(['i2c_bus_unavailable']);
      expect(results.wrongAddress!.codes).toEqual(['i2c_nack']);
      expect(results.cutSda!.componentIds).not.toEqual(results.wrongAddress!.componentIds);
      // and every one of them left the session running
      for (const key of keys) expect(results[key]!.enabled, `${key} screen`).toBe(false);
    });
  });
});
