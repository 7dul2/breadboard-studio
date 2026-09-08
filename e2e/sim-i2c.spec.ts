import { test, expect, type Page } from '@playwright/test';
import { analysis, design, enterSim, fit, fresh, loadExample, simulator, type SimVisualHook } from './helpers';

/**
 * M-S3 acceptance (plan §11.3): the OLED really draws, driven by real I²C
 * transactions from the guest, and the 8 KB frames never touch the store.
 */
const FIRST_RUN = { timeout: 25000 };

async function screen(page: Page): Promise<Extract<SimVisualHook, { kind: 'display' }> | null> {
  const sim = await simulator(page);
  const state = sim.visuals['oled']?.find((v) => v.kind === 'display');
  return state && state.kind === 'display' ? state : null;
}

async function onPixels(page: Page): Promise<number> {
  return (await screen(page))?.onPixels ?? 0;
}

async function serialText(page: Page): Promise<string> {
  return (await simulator(page)).serial.map((l) => l.text).join('\n');
}

async function runFixture(page: Page): Promise<void> {
  await enterSim(page);
  await page.getByTestId('sim-run').click();
  await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
}

test.describe('M-S3 · I²C 与 OLED', () => {
  test('① the panel draws, the pad changes what it says, and the RGB follows', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await runFixture(page);

    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('ready');
    await expect.poll(async () => onPixels(page), FIRST_RUN).toBeGreaterThan(0);
    const ready = await screen(page);
    expect(ready!.enabled, 'the panel is on').toBe(true);
    expect(ready!.width).toBe(128);
    expect(ready!.height).toBe(64);

    // the canvas element really received the frame, outside React
    const canvas = page.getByTestId('sim-screen-oled');
    await expect(canvas).toBeVisible();
    await expect.poll(async () => Number(await canvas.getAttribute('data-on-pixels')), FIRST_RUN).toBeGreaterThan(0);

    // blue while untouched
    const rgbOf = async () => {
      const led = (await simulator(page)).visuals['mcu']?.find((v) => v.kind === 'led');
      return led && led.kind === 'led' ? led.rgb : null;
    };
    await expect.poll(rgbOf, FIRST_RUN).toEqual([0, 0, 120]);

    // press the pad on the canvas: text and LED change together
    const pad = page.getByTestId('sim-control-touch:touch');
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('touch=1');
    await expect.poll(rgbOf, FIRST_RUN).toEqual([0, 180, 0]);
    await expect.poll(async () => (await screen(page))!.sha, FIRST_RUN).not.toBe(ready!.sha);
    const touchedPixels = await onPixels(page);
    expect(touchedPixels, 'still drawing, just a different word').toBeGreaterThan(0);
    expect(touchedPixels).not.toBe(ready!.onPixels);

    await page.mouse.up();
    await expect.poll(async () => (await screen(page))!.sha, FIRST_RUN).toBe(ready!.sha);
  });

  test('② 8 KB frames never enter the store', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await runFixture(page);
    await expect.poll(async () => onPixels(page), FIRST_RUN).toBeGreaterThan(0);

    // let a good number of frames go by — the fixture redraws every ~43 ms
    const start = (await simulator(page)).nowUs;
    await expect.poll(async () => (await simulator(page)).nowUs, FIRST_RUN).toBeGreaterThan(start + 1_500_000);

    const state = (await screen(page))!;
    expect(state.storedPixelBytes, 'the store holds a zero-length array, not the frame').toBe(0);
    expect(state.onPixels, 'while the summary still says the screen is lit').toBeGreaterThan(0);
    expect(state.sha).not.toBe('');
    expect((await simulator(page)).status).toBe('running');
  });

  test('③ cutting SDA is reported as a broken bus, and the run survives it', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await runFixture(page);
    await expect.poll(async () => onPixels(page), FIRST_RUN).toBeGreaterThan(0);

    // the wire cannot come out while the session runs, so stop first
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    const cut = await page.evaluate(() =>
      (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([{ op: 'remove_wire', id: 'w7' }])
    );
    expect(cut.ok).toBe(true);
    expect((await analysis(page)).summary.blocking).toBe(0);
    expect((await design(page)).wires.some((w) => w.id === 'w7')).toBe(false);

    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');

    await expect
      .poll(async () => (await simulator(page)).diagnostics.map((d) => d.code), FIRST_RUN)
      .toContain('i2c_bus_unavailable');
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('oled missing');
    expect(await onPixels(page), 'nothing was drawn on a panel that was never reached').toBe(0);
    expect((await screen(page))!.enabled).toBe(false);
    // a mis-wired circuit is a working simulation, not a simulator failure
    expect((await simulator(page)).status).toBe('running');
    expect((await simulator(page)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
