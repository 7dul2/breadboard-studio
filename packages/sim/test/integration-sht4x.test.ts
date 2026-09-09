/**
 * A program reading a real sensor over I²C (阶段 4).
 *
 * This is the first end-to-end use of the *read* half of the bus. `Wire.read` and
 * `Wire.writeRead` had unit tests and a timing formula from M-S3, but the only
 * device that implemented `onI2cRead` was the OLED, which always NACKs — so no
 * transaction had ever come back with data until now.
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

/** The environment example, powered, with a program slot to fill. */
function snapshot(): SimulationSnapshot {
  const loaded = loadDesign(readFileSync(FIXTURE, 'utf8'));
  if (!loaded.ok || !loaded.design) throw new Error('fixture failed to load');
  const r = applyOps(
    loaded.design,
    [
      { op: 'add_program', program: { id: 'program_main', name: '读传感器', target_component_id: 'mcu', source: 'export async function loop() {}\n' } },
      { op: 'set_simulation_config', patch: { active_program_id: 'program_main', usb_powered_components: ['mcu'] } }
    ],
    { allow_blocking: true }
  );
  if (!r.ok) throw new Error(`fixture edit refused: ${r.error.message}`);
  return buildSnapshot(r.design);
}

const READ_SENSOR = `import { Wire, Serial, sleep, I2C_OK } from '@bbs/runtime';

const SHT = 0x44;

export async function setup() {
  Serial.begin(115200);
  Serial.println('bus=' + Wire.begin());
}

export async function loop() {
  await Wire.write(SHT, [0xfd]);
  await sleep(10);
  const b = await Wire.read(SHT, 6);
  if (b.length === 6) {
    const t = (b[0] << 8) | b[1];
    Serial.println('T=' + (-45 + (175 * t) / 65535).toFixed(1));
  } else {
    Serial.println('read failed');
  }
  await sleep(100);
}
`;

/** The most recent temperature the program printed. */
function lastTemperature(harness: Harness): number | null {
  const lines = harness.serialText().filter((l) => l.startsWith('T='));
  const last = lines[lines.length - 1];
  return last ? Number(last.slice(2)) : null;
}

function run(source: string): Harness {
  const snap = snapshot();
  const harness = new Harness();
  harness.send({ type: 'prepare', snapshot: snap, program: programWith(snap, source) });
  harness.send({ type: 'run' });
  return harness;
}

describe('reading an SHT4x over I²C', () => {
  it('brings back the temperature the slider is set to', () => {
    const harness = run(READ_SENSOR);
    harness.run(600, () => lastTemperature(harness) !== null);

    expect(harness.serialText().join('\n'), 'the bus came up').toContain('bus=0');
    expect(lastTemperature(harness), 'the catalog default is 25 °C').toBeCloseTo(25, 1);

    // move the slider; the next measurement reports the new world
    harness.send({ type: 'control', event: { componentId: 'sht41', controlId: 'temperature', action: 'slider', value: 40.5 } });
    harness.run(600, () => (lastTemperature(harness) ?? 0) > 30);
    expect(lastTemperature(harness)).toBeCloseTo(40.5, 1);

    harness.send({ type: 'control', event: { componentId: 'sht41', controlId: 'temperature', action: 'slider', value: -12 } });
    harness.run(600, () => (lastTemperature(harness) ?? 0) < 0);
    expect(lastTemperature(harness)).toBeCloseTo(-12, 1);

    expect(harness.diagnostics().filter((d) => d.severity === 'error')).toEqual([]);
    expect(harness.statuses().at(-1)).toBe('running');
    harness.send({ type: 'dispose' });
  });

  it('refuses a read that does not wait for the conversion, and says why', () => {
    // The classic bug: no `sleep` between the command and the read.
    const impatient = READ_SENSOR.replace('  await sleep(10);\n', '');
    const harness = run(impatient);
    harness.run(600, () => harness.serialText().join('\n').includes('read failed'));

    expect(harness.serialText().join('\n')).toContain('read failed');
    expect(lastTemperature(harness), 'no measurement ever came back').toBeNull();
    const nack = harness.diagnostics().filter((d) => d.code === 'i2c_nack');
    expect(nack.length, 'deduplicated, however many times the loop spins').toBe(1);
    expect(nack[0]!.message).toContain('await sleep(10)');
    expect(harness.statuses().at(-1), 'a NACK is not a crash').toBe('running');
    harness.send({ type: 'dispose' });
  });

  it('reports the parts that still have no driver, once each', () => {
    // Every sensor on this bus now has a driver; the PSU has none because it is not
    // a behavioural part. It is reported once and never answers, which is what an
    // unmodelled part is supposed to look like.
    const harness = run(READ_SENSOR);
    harness.run(400, () => lastTemperature(harness) !== null);
    const unsupported = harness.diagnostics().filter((d) => d.code === 'unsupported_device');
    expect(unsupported.map((d) => d.componentIds?.[0]).sort()).toEqual(['psu']);
    for (const d of unsupported) expect(d.severity).toBe('info');
    expect(lastTemperature(harness), 'and the one that does have a driver still answers').toBeCloseTo(25, 1);
    harness.send({ type: 'dispose' });
  });
});
