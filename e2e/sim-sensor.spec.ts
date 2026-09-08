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
