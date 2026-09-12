import { test, expect, type Page } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, design, fit, fresh, state } from './helpers';

async function transform(page: Page) {
  return page.locator('[data-testid="canvas"] .scene').evaluate((el) => {
    const m = (el as unknown as SVGGraphicsElement).getScreenCTM()!;
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f, scale: Math.hypot(m.a, m.b) };
  });
}

test('rotation preserves design, hole hit testing and fit at all quarter turns', async ({ page }) => {
  await fresh(page);
  await addFromLibrary(page, 'breadboard_830');
  const before = (await analysis(page)).hash;
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('rotate-view').click();
    await fit(page);
    await clickHole(page, 'bb_1.a10');
    expect((await state(page)).selectedHole).toBe('bb_1.a10');
    const bounds = await page.getByTestId('canvas').boundingBox();
    const holes = await page.locator('[data-hole]').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }));
    for (const p of holes) {
      expect(p.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(p.x).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      expect(p.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(p.y).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    }
    expect((await analysis(page)).hash).toBe(before);
  }
  await page.getByTestId('rotate-view').click({ button: 'right' });
  await expect.poll(async () => (await transform(page)).b).toBeLessThan(0);
});

test('zoom buttons support keyboard and hold, and wheel zoom stays anchored after rotation', async ({ page }) => {
  await fresh(page); await addFromLibrary(page, 'breadboard_400'); await fit(page);
  await page.getByTestId('rotate-view').click();
  const original = await transform(page);
  await page.getByTestId('zoom-in').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await transform(page)).scale / original.scale).toBeCloseTo(1.15, 3);
  await page.getByTestId('zoom-out').click();
  await expect.poll(async () => (await transform(page)).scale).toBeCloseTo(original.scale, 3);
  const button = await page.getByTestId('zoom-in').boundingBox();
  await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2);
  await page.mouse.down();
  await expect.poll(async () => (await transform(page)).scale / original.scale).toBeGreaterThan(1.5);
  await page.mouse.up();
  await fit(page);
  const hole = page.locator('[data-hole="bb_1.a10"]').first();
  const r = await hole.boundingBox(); const x = r!.x + r!.width / 2; const y = r!.y + r!.height / 2;
  const before = await transform(page);
  await page.getByTestId('canvas').locator('svg.canvas').dispatchEvent('wheel', { clientX: x, clientY: y, deltaY: -100, deltaMode: 0, ctrlKey: true });
  await expect.poll(async () => (await transform(page)).scale / before.scale).toBeCloseTo(Math.exp(0.16), 3);
  const after = await hole.boundingBox();
  // Synthetic MouseEvent client coordinates are quantized to CSS pixels.
  expect(Math.abs(after!.x + after!.width / 2 - x)).toBeLessThan(0.3);
  expect(Math.abs(after!.y + after!.height / 2 - y)).toBeLessThan(0.3);
});

test('named and custom wire colors are saved through the editor and undo', async ({ page }) => {
  await fresh(page); await addFromLibrary(page, 'breadboard_400'); await fit(page);
  await page.getByTestId('tool-wire').click();
  const picker = page.getByTestId('wire-color');
  await expect(picker.locator('button')).toHaveCount(12);
  await picker.locator('[data-color="cyan"]').click();
  await clickHole(page, 'bb_1.a1'); await clickHole(page, 'bb_1.a2');
  const colors = () => page.evaluate(() => (window as any).__bbs.getDesign().wires.map((w: any) => w.color));
  expect(await colors()).toEqual(['cyan']);
  await page.getByTestId('wire-color-custom').fill('#123456');
  await clickHole(page, 'bb_1.a3'); await clickHole(page, 'bb_1.a4');
  expect(await colors()).toEqual(['cyan', '#123456']);
  await page.getByTestId('undo').click();
  expect((await design(page)).wires).toHaveLength(1);
});
