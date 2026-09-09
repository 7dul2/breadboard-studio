/**
 * A program reading a BMP390 the way a real driver does (阶段 4).
 *
 * Every other sensor in the catalog reports its measurement more or less directly.
 * The BMP390 reports a raw ADC value that only becomes a pressure after reading a
 * 21-byte calibration block and running a degree-three polynomial — so this is the
 * one part where "the simulated device is honest" and "a real library computes the
 * right number" are different claims. The test makes the guest do the whole job.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOps, loadDesign } from '@breadboard-studio/core';
import { buildSnapshot } from '../src/index.js';
import type { SimulationSnapshot } from '../src/types.js';
import { Harness, loadQuickJs, programWith } from './harness/session-harness.js';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'examples', 'environment_node.breadboard.json');

beforeAll(loadQuickJs, 60_000);

function snapshot(): SimulationSnapshot {
  const loaded = loadDesign(readFileSync(FIXTURE, 'utf8'));
  if (!loaded.ok || !loaded.design) throw new Error('fixture failed to load');
  const r = applyOps(
    loaded.design,
    [
      { op: 'add_program', program: { id: 'program_main', name: '读气压', target_component_id: 'mcu', source: 'export async function loop() {}\n' } },
      { op: 'set_simulation_config', patch: { active_program_id: 'program_main', usb_powered_components: ['mcu'] } }
    ],
    { allow_blocking: true }
  );
  if (!r.ok) throw new Error(`fixture edit refused: ${r.error.message}`);
  return buildSnapshot(r.design);
}

/**
 * The guest does what a real BMP3xx library does: check the chip id, wake the part,
 * burst-read the NVM, parse it with the datasheet scalings, read six data bytes and
 * run Bosch's float compensation.
 */
const READ_BMP390 = `import { Wire, Serial, sleep } from '@bbs/runtime';

const BMP = 0x77;

function s8(v) { return v > 127 ? v - 256 : v; }
function s16(v) { return v > 32767 ? v - 65536 : v; }
function u16(b, i) { return (b[i + 1] << 8) | b[i]; }

async function reg(address, length) {
  await Wire.write(BMP, [address]);
  return Wire.read(BMP, length);
}

export async function setup() {
  Serial.begin(115200);
  Wire.begin();
  const id = (await reg(0x00, 1))[0];
  Serial.println('id=0x' + id.toString(16));
  await Wire.write(BMP, [0x1b, 0x33]);
  await sleep(30); // past the first conversion; bmp3_get_meas_dur is ~11 ms at the default OSR
  Serial.println('ready');
}

export async function loop() {
  const n = await reg(0x31, 21);
  const c = {
    t1: u16(n, 0) / 0.00390625,
    t2: u16(n, 2) / 1073741824.0,
    t3: s8(n[4]) / 281474976710656.0,
    p1: (s16(u16(n, 5)) - 16384) / 1048576.0,
    p2: (s16(u16(n, 7)) - 16384) / 536870912.0,
    p3: s8(n[9]) / 4294967296.0,
    p4: s8(n[10]) / 137438953472.0,
    p5: u16(n, 11) / 0.125,
    p6: u16(n, 13) / 64.0,
    p7: s8(n[15]) / 256.0,
    p8: s8(n[16]) / 32768.0,
    p9: s16(u16(n, 17)) / 281474976710656.0,
    p10: s8(n[19]) / 281474976710656.0,
    p11: s8(n[20]) / 36893488147419103232.0
  };
  const d = await reg(0x04, 6);
  const rp = d[0] | (d[1] << 8) | (d[2] << 16);
  const rt = d[3] | (d[4] << 8) | (d[5] << 16);

  const pd1 = rt - c.t1;
  const t = pd1 * c.t2 + pd1 * pd1 * c.t3;
  const o1 = c.p5 + c.p6 * t + c.p7 * t * t + c.p8 * t * t * t;
  const o2 = rp * (c.p1 + c.p2 * t + c.p3 * t * t + c.p4 * t * t * t);
  const rest = rp * rp * (c.p9 + c.p10 * t) + rp * rp * rp * c.p11;
  Serial.println('T=' + t.toFixed(2) + ' P=' + ((o1 + o2 + rest) / 100).toFixed(2));
  await sleep(200);
}
`;

/** The most recent reading the program printed. */
function lastReading(harness: Harness): { t: number; p: number } | null {
  const line = harness
    .serialText()
    .filter((l) => l.startsWith('T='))
    .at(-1);
  if (!line) return null;
  const m = /^T=(-?[\d.]+) P=(-?[\d.]+)$/.exec(line);
  return m ? { t: Number(m[1]), p: Number(m[2]) } : null;
}

function run(): Harness {
  const snap = snapshot();
  const harness = new Harness();
  harness.send({ type: 'prepare', snapshot: snap, program: programWith(snap, READ_BMP390) });
  harness.send({ type: 'run' });
  return harness;
}

describe('a program reading the BMP390', () => {
  it('sees the right chip id and computes the pressure the slider is set to', () => {
    const harness = run();
    harness.run(800, () => lastReading(harness) !== null);

    const serial = harness.serialText().join('\n');
    expect(serial, 'the id a real library checks first').toContain('id=0x60');
    expect(serial).toContain('ready');

    const reading = lastReading(harness)!;
    // The guest ran the datasheet polynomial over the registers the device served,
    // and landed on the catalog defaults: 1013.2 hPa at 25 °C.
    expect(reading.t).toBeCloseTo(25, 1);
    expect(reading.p).toBeCloseTo(1013.2, 1);

    expect(harness.diagnostics().filter((d) => d.severity === 'error')).toEqual([]);
    expect(harness.statuses().at(-1)).toBe('running');
    harness.send({ type: 'dispose' });
  });

  it('follows both sliders, including a negative temperature', () => {
    const harness = run();
    harness.run(800, () => lastReading(harness) !== null);

    harness.send({ type: 'control', event: { componentId: 'bmp390', controlId: 'pressure', action: 'slider', value: 850.5 } });
    harness.send({ type: 'control', event: { componentId: 'bmp390', controlId: 'temperature', action: 'slider', value: -12.5 } });
    harness.run(800, () => (lastReading(harness)?.t ?? 0) < 0);

    const reading = lastReading(harness)!;
    expect(reading.t).toBeCloseTo(-12.5, 1);
    expect(reading.p).toBeCloseTo(850.5, 1);
    harness.send({ type: 'dispose' });
  });

  it('serves the documented reset value — and says so — when the program forgets to wake it', () => {
    const asleep = READ_BMP390.replace("  await Wire.write(BMP, [0x1b, 0x33]);\n", '');
    const snap = snapshot();
    const harness = new Harness();
    harness.send({ type: 'prepare', snapshot: snap, program: programWith(snap, asleep) });
    harness.send({ type: 'run' });
    harness.run(800, () => lastReading(harness) !== null);

    const reading = lastReading(harness)!;
    // 0x800000 is the datasheet reset value for both fields (Table 25), and it
    // compensates to something *plausible* — roughly mid-scale, not an obvious zero.
    // That is exactly what a real never-converted BMP390 does, and exactly why the
    // diagnostic has to carry the warning rather than the number looking wrong.
    expect(reading.p).toBeGreaterThan(900);
    expect(reading.p).toBeLessThan(1100);
    expect(harness.diagnostics().some((d) => d.code === 'i2c_nack' && d.message.includes('PWR_CTRL'))).toBe(true);
    expect(harness.statuses().at(-1), 'a sleeping sensor is not a crash').toBe('running');
    harness.send({ type: 'dispose' });
  });
});
