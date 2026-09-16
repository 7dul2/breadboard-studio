import { expect, test } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, design, fit, fresh } from './helpers';

test.describe('洞洞板（issue #27）', () => {
  test('在目录中按独立分类展示两种型号与铜环预览', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-perfboard_5x7').hover();
    const card = page.getByTestId('model-detail-card');
    await expect(card).toContainText('洞洞板');
    await expect(card).toContainText('18×24 孔');
    await expect(card.locator('.model-preview .hole')).toHaveCount(432);
    await expect(card.locator('.model-preview .perfboard-bore')).toHaveCount(432);
  });

  test('单孔默认不导通、元件焊盘可直接出线，并可切换焊接面', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'perfboard_5x7');
    await fit(page);
    await expect(page.getByTestId('board-join-panel')).toHaveCount(0);
    expect(await page.locator('[data-hole="bb_1.A1"].hole').count()).toBe(1);
    expect(await page.locator('[data-hole="bb_1.A2"].hole').count()).toBe(1);

    await page.getByTestId('tool-wire').click();
    await clickHole(page, 'bb_1.A1');
    await clickHole(page, 'bb_1.A2');
    let d = await design(page);
    expect(d.wires[0]).toMatchObject({ from: { hole: 'bb_1.A1' }, to: { hole: 'bb_1.A2' } });
    expect((await analysis(page)).summary.error).toBe(0);

    await page.getByTestId('tool-select').click();
    await addFromLibrary(page, 'ttp224_module');
    await clickHole(page, 'bb_1.D5');
    await page.getByTestId('tool-wire').click();
    await page.locator('[data-pin="ttp224_1.VCC"]').click({ force: true });
    await clickHole(page, 'bb_1.X18');
    d = await design(page);
    expect(d.wires.at(-1)).toMatchObject({ from: { hole: 'bb_1.D5' }, to: { hole: 'bb_1.X18' } });
    expect((await analysis(page)).summary.error).toBe(0);

    const before = await page.locator('[data-hole="bb_1.A1"].hole').boundingBox();
    await page.getByTestId('toggle-solder-side').click();
    await expect(page.getByTestId('canvas-hud')).toContainText('焊接面');
    const after = await page.locator('[data-hole="bb_1.A1"].hole').boundingBox();
    expect(after!.x).toBeGreaterThan(before!.x);
    await page.getByTestId('toggle-solder-side').click();
    await expect(page.getByTestId('canvas-hud')).toContainText('元件面');
  });
});
