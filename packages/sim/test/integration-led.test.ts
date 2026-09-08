/**
 * `GPIO → 电阻 → LED → GND`, the first circuit in every beginner's book, end to end.
 *
 * Until the resistor conducted this could not work at all: the series resistor was
 * an open circuit in the connectivity graph, so the LED's anode was on a net the
 * MCU could not reach. The test therefore asserts the electrical claim first — the
 * resistor really is what joins them — and only then that the program lights it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeDesign, applyOps, holeAddress, groupHoles, loadDesign, type DesignModel, type Op } from '@breadboard-studio/core';
import { buildSnapshot } from '../src/index.js';
import type { DeviceVisualState } from '../src/types.js';
import { Harness, loadQuickJs, programWith } from './harness/session-harness.js';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'examples', 'touch_display.breadboard.json');
const GPIO = 'GPIO5';

beforeAll(loadQuickJs, 60_000);

/** A hole already on the ground net that nothing is plugged into. */
function freeGroundHole(design: Parameters<typeof analyzeDesign>[0], model: DesignModel): string {
  const snapshot = buildSnapshot(design);
  const groundNet = snapshot.power?.groundNets[0];
  const net = snapshot.nets.find((n) => n.id === groundNet);
  if (!net) throw new Error('the fixture has no ground net');
  const occupied = new Set([...model.components.values()].flatMap((pc) => pc.pins.filter((p) => p.hole).map((p) => holeAddress(p.hole!.board_id, p.hole!.hole))));
  // Rail holes are never under a module body, which is what makes them wirable.
  const free = net.members.find((m) => m.includes('outer') && !occupied.has(m));
  if (!free) throw new Error('no free hole on the ground rail');
  return free;
}

/** A free hole in the same five-hole group as a pin — where a wire can actually go. */
function tapPoint(model: DesignModel, componentId: string, pin: string): string {
  const placed = model.components.get(componentId)!.pins.find((p) => p.name === pin);
  if (!placed?.hole) throw new Error(`${componentId}.${pin} is not in a hole`);
  const occupied = new Set([...model.components.values()].flatMap((pc) => pc.pins.filter((p) => p.hole).map((p) => holeAddress(p.hole!.board_id, p.hole!.hole))));
  const free = groupHoles(model, holeAddress(placed.hole.board_id, placed.hole.hole)).find((h) => !occupied.has(h));
  if (!free) throw new Error(`no free hole beside ${componentId}.${pin}`);
  return free;
}

function apply(design: Parameters<typeof analyzeDesign>[0], ops: Op[]) {
  const r = applyOps(design, ops, { allow_blocking: true });
  if (!r.ok) throw new Error(`apply refused: ${r.error.message}`);
  return r.design;
}

/** The fixture plus a resistor and an LED hung off one spare GPIO. */
function withLed(ohms = '220') {
  const loaded = loadDesign(readFileSync(FIXTURE, 'utf8'));
  if (!loaded.ok || !loaded.design) throw new Error('fixture failed to load');

  let design = apply(loaded.design, [
    {
      op: 'add_component',
      component: { id: 'r1', model: 'resistor_axial@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e5', anchor_pin: 'P1', rotation_deg: 0 }, params: { value: ohms, span_pitches: 4 } }
    },
    {
      op: 'add_component',
      component: { id: 'led1', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e15', anchor_pin: 'A', rotation_deg: 0 }, params: { color: 'green' } }
    }
  ]);

  const model = analyzeDesign(design).model;
  // Ground is taken from a free hole on the ground *net* rather than beside the
  // MCU's own GND pin: those holes sit under the module's body, which the engine
  // rightly refuses to wire into.
  const ground = freeGroundHole(design, model);
  design = apply(design, [
    { op: 'add_wire', wire: { id: 'w_led_drive', from: { hole: tapPoint(model, 'mcu', GPIO) }, to: { hole: tapPoint(model, 'r1', 'P1') }, color: 'yellow' } },
    { op: 'add_wire', wire: { id: 'w_led_series', from: { hole: tapPoint(model, 'r1', 'P2') }, to: { hole: tapPoint(model, 'led1', 'A') }, color: 'orange' } },
    { op: 'add_wire', wire: { id: 'w_led_gnd', from: { hole: tapPoint(model, 'led1', 'K') }, to: { hole: ground }, color: 'black' } }
  ]);
  return design;
}

const BLINK = `import { gpio, Serial, sleep, OUTPUT, HIGH, LOW } from '@bbs/runtime';

export async function setup() {
  Serial.begin(115200);
  gpio.pinMode(5, OUTPUT);
  Serial.println('ready');
}

export async function loop() {
  gpio.digitalWrite(5, HIGH);
  await sleep(100);
  gpio.digitalWrite(5, LOW);
  await sleep(100);
}
`;

function ledIntensity(harness: Harness): number | null {
  const frames = harness.visualsOf('led1');
  for (let i = frames.length - 1; i >= 0; i--) {
    const led = frames[i]!.find((s: DeviceVisualState) => s.kind === 'led');
    if (led && led.kind === 'led') return led.intensity;
  }
  return null;
}

describe('GPIO → resistor → LED → GND', () => {
  it('the resistor is what puts the GPIO and the anode on one net', () => {
    const design = withLed();
    const snapshot = buildSnapshot(design);
    const gpioNet = snapshot.pinToNet[`mcu.${GPIO}`];
    const anodeNet = snapshot.pinToNet['led1.A'];
    expect(gpioNet, 'the GPIO is wired').toBeDefined();
    expect(anodeNet, 'so is the anode').toBe(gpioNet);

    // ...and they are on one net only because current can cross the resistor
    const conn = analyzeDesign(design).connectivity;
    expect(conn.full.connected('mcu.GPIO5', 'led1.A')).toBe(true);
    expect(conn.direct.connected('mcu.GPIO5', 'led1.A'), 'not the same node — the resistor is in between').toBe(false);
    expect(conn.conducted.map((c) => c.componentId)).toContain('r1');
    expect(analyzeDesign(design).summary.error, 'the circuit is legal').toBe(0);
  });

  it('lights while the program drives the pin high, and goes out when it does not', () => {
    const snapshot = buildSnapshot(withLed());
    const harness = new Harness();
    harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK) });
    harness.send({ type: 'run' });
    harness.run(400, () => harness.serialText().join('\n').includes('ready'));

    // the LED reports itself before anything drives it, and it is dark
    expect(ledIntensity(harness)).toBe(0);

    harness.run(400, () => ledIntensity(harness) === 1);
    expect(ledIntensity(harness), 'driven high through the resistor').toBe(1);

    harness.run(400, () => ledIntensity(harness) === 0);
    expect(ledIntensity(harness), 'and out again on the next half period').toBe(0);

    expect(harness.diagnostics().filter((d) => d.severity === 'error')).toEqual([]);
    expect(harness.statuses().at(-1)).toBe('running');
    harness.send({ type: 'dispose' });
  });

  it('takes its colour from params, not from config', () => {
    const snapshot = buildSnapshot(withLed());
    const led = snapshot.devices.find((d) => d.componentId === 'led1')!;
    expect(led.params).toMatchObject({ color: 'green' });
    expect(led.driver).toBe('output.led@1');

    const harness = new Harness();
    harness.send({ type: 'prepare', snapshot, program: programWith(snapshot, BLINK) });
    harness.send({ type: 'run' });
    harness.run(400, () => ledIntensity(harness) === 1);
    const frames = harness.visualsOf('led1');
    const led1 = frames[frames.length - 1]!.find((s) => s.kind === 'led');
    expect(led1 && led1.kind === 'led' ? led1.rgb : null).toEqual([34, 197, 94]);
    harness.send({ type: 'dispose' });
  });
});
