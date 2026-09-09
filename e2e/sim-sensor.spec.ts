import { test, expect } from '@playwright/test';
import { enterSim, fresh, loadExample, simulator } from './helpers';

/**
 * 阶段 4: a slider in the 仿真 panel changes what the program reads back over I²C.
 * Sliders live in the panel, not on the canvas — dragging a value and pressing a
 * pad want different affordances (the overlay has skipped sliders since M-S2).
 */
const FIRST_RUN = { timeout: 25000 };

const READ_SENSOR = `import { Wire, Serial, sleep } from '@bbs/runtime';

const SHT = 0x44;

export async function setup() {
  Serial.begin(115200);
  Wire.begin();
}

export async function loop() {
  await Wire.write(SHT, [0xfd]);
  await sleep(10);
  const b = await Wire.read(SHT, 6);
  if (b.length === 6) Serial.println('T=' + (-45 + (175 * ((b[0] << 8) | b[1])) / 65535).toFixed(1));
  await sleep(50);
}
`;

async function lastTemperature(page: import('@playwright/test').Page): Promise<number | null> {
  const lines = (await simulator(page)).serial.map((l) => l.text).filter((t) => t.startsWith('T='));
  const last = lines[lines.length - 1];
  return last ? Number(last.slice(2)) : null;
}

test.describe('阶段 4 · 传感器滑杆', () => {
  test('the BMP390 slider reaches a program that runs the datasheet compensation', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'environment_node');

    // A guest that does the whole job: read the NVM, parse it, compensate.
    const READ_BMP = `import { Wire, Serial, sleep } from '@bbs/runtime';
const BMP = 0x77;
function s8(v) { return v > 127 ? v - 256 : v; }
function s16(v) { return v > 32767 ? v - 65536 : v; }
function u16(b, i) { return (b[i + 1] << 8) | b[i]; }
async function reg(a, n) { await Wire.write(BMP, [a]); return Wire.read(BMP, n); }
export async function setup() {
  Serial.begin(115200);
  Wire.begin();
  await Wire.write(BMP, [0x1b, 0x33]);
  await sleep(10);
  Serial.println('ready');
}
export async function loop() {
  const n = await reg(0x31, 21);
  const t1 = u16(n, 0) / 0.00390625, t2 = u16(n, 2) / 1073741824.0, t3 = s8(n[4]) / 281474976710656.0;
  const p1 = (s16(u16(n, 5)) - 16384) / 1048576.0, p5 = u16(n, 11) / 0.125;
  const d = await reg(0x04, 6);
  const rp = d[0] | (d[1] << 8) | (d[2] << 16);
  const rt = d[3] | (d[4] << 8) | (d[5] << 16);
  const pd1 = rt - t1;
  const t = pd1 * t2 + pd1 * pd1 * t3;
  Serial.println('P=' + ((p5 + rp * p1) / 100).toFixed(1));
  await sleep(50);
}
`;
    const ok = await page.evaluate(
      (src) =>
        (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
          { op: 'add_program', program: { id: 'program_main', name: '读气压', target_component_id: 'mcu', source: src } },
          { op: 'set_simulation_config', patch: { active_program_id: 'program_main', usb_powered_components: ['mcu'] } }
        ]),
      READ_BMP
    );
    expect(ok.ok).toBe(true);

    await enterSim(page);
    const slider = page.getByTestId('sim-slider-input-bmp390:pressure');
    await expect(slider).toBeVisible();

    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');

    const lastPressure = async (): Promise<number | null> => {
      const line = (await simulator(page)).serial.map((l) => l.text).filter((t) => t.startsWith('P=')).at(-1);
      return line ? Number(line.slice(2)) : null;
    };
    await expect.poll(lastPressure, FIRST_RUN).toBeCloseTo(1013.2, 0);

    await slider.fill('880.5');
    await expect.poll(lastPressure, FIRST_RUN).toBeCloseTo(880.5, 0);
    expect((await simulator(page)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });


  test('the slider moves the temperature the program reads', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'environment_node');

    // give the design a program and power, the way the panel would
    const ok = await page.evaluate(
      (src) =>
        (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
          { op: 'add_program', program: { id: 'program_main', name: '读传感器', target_component_id: 'mcu', source: src } },
          { op: 'set_simulation_config', patch: { active_program_id: 'program_main', usb_powered_components: ['mcu'] } }
        ]),
      READ_SENSOR
    );
    expect(ok.ok).toBe(true);

    await enterSim(page);
    // the sliders are listed before anything runs, and disabled until it does
    const slider = page.getByTestId('sim-slider-input-sht41:temperature');
    await expect(slider).toBeVisible();
    await expect(slider).toBeDisabled();

    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect(slider).toBeEnabled();

    await expect.poll(async () => lastTemperature(page), FIRST_RUN).toBeCloseTo(25, 1);
    await expect(page.getByTestId('sim-slider-value-sht41:temperature')).toHaveText('25 °C');

    // drag it: the reading follows
    await slider.fill('40.5');
    await expect(page.getByTestId('sim-slider-value-sht41:temperature')).toHaveText('40.5 °C');
    await expect.poll(async () => lastTemperature(page), FIRST_RUN).toBeCloseTo(40.5, 1);

    await slider.fill('-12');
    await expect.poll(async () => lastTemperature(page), FIRST_RUN).toBeCloseTo(-12, 1);

    expect((await simulator(page)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect((await simulator(page)).status).toBe('running');
  });
});
