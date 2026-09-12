import { expect, test } from '@playwright/test';
import { fresh } from './helpers';

/**
 * 这三个元件原来只存在于某一份设计的 embedded_catalog 里（导入那份设计才能用），
 * 现在进了内置元件库：新建设计也能直接放。
 */
test.describe('内置元件库新增件', () => {
  test('屏幕 / 旋钮 / 轻触开关直接可见，并且可以开始放置', async ({ page }) => {
    await fresh(page);
    for (const id of ['tft_1_77_st7735_spi', 'encoder_ky040', 'tactile_6x6']) {
      await expect(page.getByTestId(`lib-${id}`)).toBeVisible();
    }

    // 选中就进入放置态：元件库认得它，不需要先导入定义。
    await page.getByTestId('lib-tactile_6x6').click();
    await expect(page.getByTestId('placing-hint')).toContainText('轻触按键');
  });

  test('元件详情卡能生成预览（说明几何数据完整）', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-encoder_ky040').hover();
    const card = page.getByTestId('model-detail-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('encoder_ky040@1');
    await expect(card.locator('svg')).toBeVisible();
  });
});
