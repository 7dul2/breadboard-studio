import { expect, test } from '@playwright/test';
import { analysis, fresh } from './helpers';

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

/**
 * 拼装面包板：用目录里可拼接的 400 孔模块拼出大板（不是新造定义）。
 * 断言的是"真的拼上了"——块数、尺寸、规则无 error，而不是只看弹窗里的字。
 */
test.describe('拼装面包板', () => {
  test('按块数拼出来：全是标准件，尺寸对得上且规则无 error', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('splice-board-open').click();
    await page.getByTestId('splice-across').selectOption('2');
    await page.getByTestId('splice-down').selectOption('1');
    await expect(page.getByTestId('splice-board-card')).toContainText('60 列 × 10 行');
    await page.getByTestId('splice-create').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();

    const design = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[]; embedded_catalog?: unknown } } }).__bbs.getDesign());
    expect(design.boards).toHaveLength(2);
    expect(design.boards.map((b) => b.model)).toEqual(['breadboard_400@1', 'breadboard_400@1']);
    // 用的是内置件，不该往设计里塞新定义
    expect(design.embedded_catalog).toBeUndefined();
    expect((await analysis(page)).summary.error).toBe(0);
  });

  test('纵向带电源条：块数 = 板 + 条，且都吸附在同一套网格上', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('splice-board-open').click();
    await page.getByTestId('splice-across').selectOption('1');
    await page.getByTestId('splice-down').selectOption('2');
    await page.getByTestId('splice-strip').check();
    await expect(page.getByTestId('splice-board-card')).toContainText('30 列 × 20 行');
    await page.getByTestId('splice-create').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();

    const models = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[] } } }).__bbs.getDesign().boards.map((b) => b.model));
    expect(models).toEqual(['breadboard_400@1', 'breadboard_power_strip_25@1', 'breadboard_400@1']);
    expect((await analysis(page)).summary.error).toBe(0);
  });
});
