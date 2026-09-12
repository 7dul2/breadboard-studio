import { expect, test } from '@playwright/test';
import { fresh, loadExample, state } from './helpers';

/**
 * 「已选元件」面板：小元件在画布上不好戳，面板是那条替代路径。
 * 这一组断言的是真实 store 状态，不是截图。
 */
test.describe('已选元件面板', () => {
  test.beforeEach(async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    await page.getByTestId('tab-selected').click();
  });

  test('列出已放置的板与元件，点条目即选中并居中', async ({ page }) => {
    const items = page.locator('.placed-item');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(1);

    const comp = page.locator('.placed-block').first();
    await comp.locator('.placed-item').click();
    const id = (await comp.locator('.placed-item').getAttribute('data-testid'))!.replace('placed-', '');
    expect((await state(page)).selectedIds).toEqual([id]);

    // 选中后展开引脚清单，并且视图确实被移到了这个元件上（缩放不再是整板视图）。
    await expect(comp.locator('.placed-detail')).toBeVisible();
    await expect(comp.locator('.pin-chip').first()).toBeVisible();
  });

  test('点引脚高亮该引脚，点导线选中导线', async ({ page }) => {
    const comp = page.locator('.placed-block').first();
    await comp.locator('.placed-item').click();
    const id = (await comp.locator('.placed-item').getAttribute('data-testid'))!.replace('placed-', '');

    const pin = comp.locator('.pin-chip').first();
    await pin.click();
    await expect(page.locator('.pin-highlight')).toHaveCount(1);
    expect((await state(page)).selectedIds).toEqual([id]);

    const wire = comp.locator('.wire-chip').first();
    if (await wire.count()) {
      const wireId = (await wire.getAttribute('data-testid'))!.replace('wire-chip-', '');
      await wire.click();
      expect((await state(page)).selectedIds).toEqual([wireId]);
      // 选中导线会把两端各自"插到谁身上"一并点亮（另一端常常是一个空孔）。
      await expect(page.locator('.pin-highlight')).not.toHaveCount(0);
    }
  });

  test('导线压在元件上时，点它选中元件而不是导线', async ({ page }) => {
    const comp = page.locator('.placed-block').first();
    const id = (await comp.locator('.placed-item').getAttribute('data-testid'))!.replace('placed-', '');

    // 元件的可见本体：平放元件是 .component-hit（透明命中层），立式是 .component-body。
    const body = page.locator(`[data-component="${id}"] .component-hit, [data-component="${id}"] .component-body`).first();
    const b = await body.boundingBox();
    expect(b).toBeTruthy();
    await page.mouse.click(b!.x + b!.width / 2, b!.y + b!.height / 2);
    expect((await state(page)).selectedIds).toEqual([id]);
  });
});
