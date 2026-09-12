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
 * 自定义面包板：给列数/行数现算一份板定义并内嵌到设计。
 * 断言的是"真的生成了一块能用的板"——定义进了 embedded_catalog、规则跑出 0 error、
 * 孔位按列数/行数出现，而不是只看弹窗里的文字。
 */
test.describe('自定义面包板', () => {
  test('按列数/行数生成，定义内嵌且规则无 error', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('custom-board-open').click();
    await page.getByTestId('custom-board-columns').fill('20');
    await page.getByTestId('custom-board-rows').selectOption('3');
    // 弹窗里的预估随输入变（20 列 × 6 行 = 120 个接线孔 + 4 条 14 孔电源轨）
    await expect(page.getByTestId('custom-board-card')).toContainText('breadboard_custom_20x6_rail_split@1');
    await expect(page.getByTestId('custom-board-card')).toContainText('176');
    await page.getByTestId('custom-board-create').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();

    const model = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[]; embedded_catalog?: { boards?: { id: string }[] } } } }).__bbs.getDesign());
    expect(model.boards.map((b) => b.model)).toEqual(['breadboard_custom_20x6_rail_split@1']);
    expect((model.embedded_catalog?.boards ?? []).map((b) => b.id)).toEqual(['breadboard_custom_20x6_rail_split']);
    expect((await analysis(page)).summary.error).toBe(0);

    // 3 行/半区、20 列：a1/f1 在，e1（第 5 行）和 a21（第 21 列）不在
    await expect(page.locator('[data-hole="bb_1.a1"]')).toBeVisible();
    await expect(page.locator('[data-hole="bb_1.f1"]')).toBeVisible();
    expect(await page.locator('[data-hole="bb_1.e1"]').count()).toBe(0);
    expect(await page.locator('[data-hole="bb_1.a21"]').count()).toBe(0);
  });

  test('同一个尺寸重复生成不会堆出第二份定义', async ({ page }) => {
    await fresh(page);
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('custom-board-open').click();
      await page.getByTestId('custom-board-columns').fill('16');
      await page.getByTestId('custom-board-create').click();
      // 两条 toast 会同时挂着，所以按板数等而不是按 toast 等
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: unknown[] } } }).__bbs.getDesign().boards.length))
        .toBe(i + 1);
    }
    const defs = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { embedded_catalog?: { boards?: { id: string }[] } } } }).__bbs.getDesign().embedded_catalog?.boards ?? []);
    expect(defs.map((d) => d.id)).toEqual(['breadboard_custom_16x10_rail_split']);
    const boards = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: unknown[] } } }).__bbs.getDesign().boards);
    expect(boards).toHaveLength(2);
  });
});
