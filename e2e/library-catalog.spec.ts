import { expect, test } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, design, fit, fresh } from './helpers';

/**
 * 这三个元件原来只存在于某一份设计的 embedded_catalog 里（导入那份设计才能用），
 * 现在进了内置元件库：新建设计也能直接放。
 */
test.describe('内置元件库新增件', () => {
  test('屏幕 / 旋钮 / 轻触开关 / 四路触摸模块直接可见，并且可以开始放置', async ({ page }) => {
    await fresh(page);
    for (const id of ['tft_1_77_st7735_spi', 'encoder_ky040', 'tactile_6x6', 'ttp224_module']) {
      await expect(page.getByTestId(`lib-${id}`)).toBeVisible();
    }

    // 选中就进入放置态：元件库认得它，不需要先导入定义。
    await page.getByTestId('lib-ttp224_module').click();
    await expect(page.getByTestId('placing-hint')).toContainText('TTP224 四路电容触摸模块');
  });

  test('有反面绘图时同时预览正反面，旧元件仍只显示一面', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-ttp224_module').hover();
    const card = page.getByTestId('model-detail-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('model-preview-front')).toBeVisible();
    await expect(card.getByTestId('model-preview-back')).toBeVisible();
    await expect(card.locator('.model-preview svg')).toHaveCount(2);
    await expect(card).toContainText('正面');
    await expect(card).toContainText('反面');

    await page.getByTestId('lib-encoder_ky040').hover();
    await expect(card.getByTestId('model-preview-front')).toBeVisible();
    await expect(card.getByTestId('model-preview-back')).toHaveCount(0);
    await expect(card.locator('.model-preview svg')).toHaveCount(1);
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
 * 拼装面包板：用目录里可拼接的中间接线板 + 电源条拼出大板（不是新造定义）。
 * 断言的是"真的拼上了"——块数、尺寸、规则无 error，而不是只看弹窗里的字。
 */
test.describe('拼装面包板', () => {
  test('按块数拼出来：中间段不带电源，电源条拼在上下两侧', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('splice-board-open').click();
    await page.getByTestId('splice-across').selectOption('2');
    await page.getByTestId('splice-down').selectOption('1');
    await expect(page.getByTestId('splice-board-card')).toContainText('60 列 × 10 行');
    await page.getByTestId('splice-create').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();

    const design = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[]; embedded_catalog?: unknown } } }).__bbs.getDesign());
    // 2 块不带电源轨的中间接线板 + 每列上下各一条电源条
    expect(design.boards.map((b) => b.model)).toEqual([
      'breadboard_400_terminal@1',
      'breadboard_400_terminal@1',
      'breadboard_power_strip_25@1',
      'breadboard_power_strip_25@1',
      'breadboard_power_strip_25@1',
      'breadboard_power_strip_25@1'
    ]);
    // 用的是内置件，不该往设计里塞新定义
    expect(design.embedded_catalog).toBeUndefined();
    expect((await analysis(page)).summary.error).toBe(0);
  });

  test('纵向拼两排：中间不留电源，只有最上和最下是电源条', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('splice-board-open').click();
    await page.getByTestId('splice-across').selectOption('1');
    await page.getByTestId('splice-down').selectOption('2');
    await expect(page.getByTestId('splice-board-card')).toContainText('30 列 × 20 行');
    await page.getByTestId('splice-create').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();

    const models = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[] } } }).__bbs.getDesign().boards.map((b) => b.model));
    expect(models).toEqual(['breadboard_400_terminal@1', 'breadboard_400_terminal@1', 'breadboard_power_strip_25@1', 'breadboard_power_strip_25@1']);
    expect((await analysis(page)).summary.error).toBe(0);
  });
});

/**
 * issue #32：元件库不再靠硬编码白名单裁剪目录。定义里的 `featured` 决定默认视图，
 * 其余内置型号折叠进各类目的「更多内置型号」，搜索覆盖整个目录，添加流程完全一样。
 */
test.describe('元件库装下整个目录', () => {
  test('默认视图只列精选型号，其余按类目折叠而不是消失', async ({ page }) => {
    await fresh(page);
    // 精选 12 个直接可见；被折叠的型号在 DOM 里确实不存在。
    await expect(page.locator('.library-list .lib-item')).toHaveCount(12);
    await expect(page.getByTestId('lib-xiao_esp32s3_sense')).toHaveCount(0);
    await expect(page.getByTestId('lib-oled_0_96_i2c')).toHaveCount(0);

    // 每个有折叠型号的类目都留了入口，并且标出数量（合计 12 = 目录 24 − 精选 12）。
    await expect(page.getByTestId('lib-more-mcu')).toContainText('更多内置型号（2）');
    await expect(page.getByTestId('lib-more-display')).toContainText('更多内置型号（2）');
    await expect(page.getByTestId('lib-more-sensor')).toContainText('更多内置型号（4）');
    await expect(page.getByTestId('lib-more-input')).toContainText('更多内置型号（1）');
    await expect(page.getByTestId('lib-more-power')).toContainText('更多内置型号（1）');
    await expect(page.getByTestId('lib-more-passive')).toContainText('更多内置型号（2）');
  });

  test('搜索覆盖整个目录：被折叠的型号直接命中，示例里出镜的型号都在', async ({ page }) => {
    await fresh(page);
    for (const [query, id] of [['xiao', 'xiao_esp32s3_sense'], ['sht41', 'sht41_breakout'], ['sen66', 'sen66'], ['devkit', 'esp32s3_devkit_generic'], ['ttp223', 'ttp223_module']] as const) {
      await page.getByTestId('library-search').fill(query);
      await expect(page.getByTestId(`lib-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('library-search-note')).toContainText('全部 24 个内置型号');
    await expect(page.getByTestId('library-search-note')).toContainText('含默认折叠的 12 个');

    await page.getByTestId('library-search').fill('xiao');
    // 只留命中项：没被搜到的精选型号也一起让位。
    await expect(page.getByTestId('lib-esp32s3_n16r8_dual_usb')).toHaveCount(0);

    await page.getByTestId('library-search').fill('no_such_part');
    await expect(page.getByTestId('library-empty')).toBeVisible();
  });

  test('展开类目 → 添加被折叠的型号：落孔成功、校验无 error、带状态徽标', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await expect(page.getByTestId('lib-oled_0_96_i2c')).toHaveCount(0);

    await page.getByTestId('lib-more-display').click();
    await page.getByTestId('lib-oled_0_96_i2c').click();
    await clickHole(page, 'bb_1.j9');

    const d = await design(page);
    expect(d.components).toHaveLength(1);
    expect(d.components[0]!.placement.kind).toBe('board');
    expect(d.components[0]!.placement.anchor_hole).toBe('j9');
    expect((await analysis(page)).summary.error).toBe(0);

    // 不是实测数据就直说：徽标与画布上的状态文案是同一套。
    await expect(page.getByTestId('lib-status-oled_0_96_i2c')).toHaveText('几何近似 电气近似');
    await expect(page.getByTestId('lib-status-esp32s3_n16r8_dual_usb')).toBeVisible();
  });

  test('展开状态在会话内保持（切换页签回来还在），刷新后回到默认折叠', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-more-passive').click();
    await expect(page.getByTestId('lib-led_5mm')).toBeVisible();

    await page.getByTestId('tab-selected').click();
    await expect(page.getByTestId('lib-led_5mm')).toHaveCount(0);
    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('lib-led_5mm')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('lib-more-passive')).toBeVisible();
    await expect(page.getByTestId('lib-led_5mm')).toHaveCount(0);
  });
});
