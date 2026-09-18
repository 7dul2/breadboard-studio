import { expect, test } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, design, dragSolderBridge, fit, fresh, openViewMenu } from './helpers';

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
    await openViewMenu(page);
    await page.getByTestId('toggle-solder-side').click();
    await expect(page.getByTestId('canvas-hud')).toContainText('焊接面');
    const after = await page.locator('[data-hole="bb_1.A1"].hole').boundingBox();
    expect(after!.x).toBeGreaterThan(before!.x);
    await page.getByTestId('toggle-solder-side').click();
    await expect(page.getByTestId('canvas-hud')).toContainText('元件面');
  });

  test('焊接工具：悬停看状态、点击选中切面板、拖动两焊盘建立焊锡桥', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'perfboard_5x7');
    await fit(page);

    await page.getByTestId('tool-solder').click();
    // R1.1：悬停焊盘显示孔地址与状态（空闲）
    await page.locator('[data-hole="bb_1.A1"]').first().hover({ force: true });
    await expect(page.getByTestId('solder-hover-status')).toContainText('bb_1.A1 · 空闲');

    // 单击焊盘：选中并切到右栏「焊接」面板
    await clickHole(page, 'bb_1.A1');
    await expect(page.getByTestId('tab-solder')).toHaveClass(/active/);
    await expect(page.getByTestId('solder-panel')).toBeVisible();
    await expect(page.getByTestId('solder-selected')).toContainText('bb_1.A1');

    // R1.3：拖动两个焊盘建立焊锡桥
    await dragSolderBridge(page, 'bb_1.A1', 'bb_1.A2');
    const d = await design(page);
    expect(d.solder_bridges![0]).toMatchObject({ a: 'bb_1.A1', b: 'bb_1.A2' });
    await expect(page.getByTestId('solder-bridges')).toContainText('bb_1.A1 ↔ bb_1.A2');

    // R1.5：已占用焊盘的悬停状态说明占用者，而不是只报"已占用"
    await page.getByTestId('tool-select').click();
    await addFromLibrary(page, 'ttp224_module');
    await clickHole(page, 'bb_1.D5');
    await page.getByTestId('tool-solder').click();
    await page.locator('[data-hole="bb_1.D5"]').first().hover({ force: true });
    await expect(page.getByTestId('solder-hover-status')).toContainText('bb_1.D5 · 已焊 ttp224_1.VCC');
  });

  test('焊接面视图下焊桥跟着板镜像，且只在焊接面显示滴状焊桥', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'perfboard_5x7');
    await fit(page);
    await page.getByTestId('tool-solder').click();
    await dragSolderBridge(page, 'bb_1.A1', 'bb_1.A3');

    // 组件面：亮铜线提示板下有桥，滴状焊桥不出现
    await expect(page.locator('.bridge-copper')).toHaveCount(1);
    await expect(page.locator('.solder-bridge')).toHaveCount(0);

    await openViewMenu(page);
    await page.getByTestId('toggle-solder-side').click();
    await expect(page.getByTestId('canvas-hud')).toContainText('焊接面');
    // 焊接面：滴状焊桥出现，铜线隐藏
    await expect(page.locator('.solder-bridge')).toHaveCount(1);
    await expect(page.locator('.bridge-copper')).toHaveCount(0);
    // 桥跟着板走：中点仍在两个端点孔之间（镜像后孔已移到另一侧，桥没有留在原地）
    const a1 = await page.locator('[data-hole="bb_1.A1"].hole').boundingBox();
    const a3 = await page.locator('[data-hole="bb_1.A3"].hole').boundingBox();
    const bridge = await page.locator('.solder-bridge').boundingBox();
    const cx = bridge!.x + bridge!.width / 2;
    expect(cx).toBeGreaterThan(Math.min(a1!.x, a3!.x));
    expect(cx).toBeLessThan(Math.max(a1!.x + a1!.width, a3!.x + a3!.width));
  });

  test('洞洞板不参与面包板的默认机械拼接', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'perfboard_5x7');
    await addFromLibrary(page, 'breadboard_400');
    const d = await design(page);
    expect(d.boards.map((board) => board.position_um)).toEqual([[0, 0], [60800, 0]]);
    await expect(page.getByTestId('board-join-target')).toHaveCount(0);
  });
});
