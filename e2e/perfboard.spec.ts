import { expect, test } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, design, dragSolderBridge, fit, fresh, openViewMenu, state } from './helpers';

test.describe('洞洞板（issue #27）', () => {
  test('在目录中按独立分类展示两种型号与铜环预览', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-perfboard_5x7').hover();
    const card = page.getByTestId('model-detail-card');
    await expect(card).toContainText('洞洞板');
    await expect(card).toContainText('18×24 孔');
    await expect(card.locator('.model-preview .hole')).toHaveCount(432);
    await expect(card.locator('.model-preview .perfboard-bore')).toHaveCount(432);
    // R1.6：默认尺寸下不许误报"尺寸无效"（列/行就是定义里的默认值，用户没改过）
    await expect(card).not.toContainText('尺寸无效');
    await expect(card.getByTestId('model-detail-add')).toBeEnabled();
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

  test('焊接面：元件跟着板走、文字正着读、元件压暗且穿孔点高亮（R2.3/R2.4/R3.1/R3.2/R2.7）', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'perfboard_5x7');
    await fit(page);
    await page.getByTestId('tool-select').click();
    await addFromLibrary(page, 'ttp224_module');
    await clickHole(page, 'bb_1.D5');
    await fit(page);

    const padFront = await page.locator('[data-hole="bb_1.D5"].hole').boundingBox();
    const pinFront = await page.locator('[data-pin="ttp224_1.VCC"]').first().boundingBox();
    await expect(page.locator('.pin-highlight')).toHaveCount(0);
    await expect(page.locator('.board-side-label')).toHaveCount(0);

    await openViewMenu(page);
    await page.getByTestId('toggle-solder-side').click();
    // R2.7：HUD 要说清是哪块板在焊接面
    await expect(page.getByTestId('canvas-hud')).toContainText('焊接面：bb_1');
    await expect(page.locator('.board-side-label')).toHaveText('焊接面');

    const padSolder = await page.locator('[data-hole="bb_1.D5"].hole').boundingBox();
    const pinSolder = await page.locator('[data-pin="ttp224_1.VCC"]').first().boundingBox();
    // 板确实镜像了
    expect(Math.abs(padSolder!.x - padFront!.x)).toBeGreaterThan(20);
    // R2.4：元件跟着板一起镜像 —— 引脚相对焊盘的偏移不变（元件没有留在原地）
    const offsetFront = pinFront!.x + pinFront!.width / 2 - (padFront!.x + padFront!.width / 2);
    const offsetSolder = pinSolder!.x + pinSolder!.width / 2 - (padSolder!.x + padSolder!.width / 2);
    expect(Math.abs(offsetFront)).toBeLessThan(3);
    expect(Math.abs(offsetSolder)).toBeLessThan(3);

    // R3.4：选中的元件不压暗（刚放完是选中态）。先点空白处取消选中，再看 R3.1 的压暗。
    await page.getByTestId('canvas').click({ position: { x: 12, y: 12 } });
    expect((await state(page)).selectedIds).toEqual([]);

    // R3.1：该板元件（含名称）整体压暗
    const opacity = await page.locator('g.component[data-component="ttp224_1"]').evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(opacity).toBeLessThan(1);
    // R3.2：穿孔引脚高亮
    expect(await page.locator('.pin-highlight').count()).toBeGreaterThan(0);

    // R2.3：焊接面文字全部正着读（矩阵行列式 > 0，即没有被镜像）
    for (const sel of ['.component-name', '.board-label', '.pin-label']) {
      const loc = page.locator(sel).first();
      const det = await loc.evaluate((el) => {
        const m = (el as SVGGraphicsElement).getScreenCTM()!;
        return m.a * m.d - m.b * m.c;
      });
      expect(det, `${sel} 不该是镜像字`).toBeGreaterThan(0);
    }
  });

  test('两块洞洞板各自翻面：只翻选中的那块，另一块完全不动（R2.1/R2.5/R2.6）', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'perfboard_5x7');
    await addFromLibrary(page, 'perfboard_5x7');
    await fit(page);
    const holeBox = (id: string) => page.locator(`[data-hole="${id}.A1"].hole`).boundingBox();
    const before1 = await holeBox('bb_1');
    const before2 = await holeBox('bb_2');

    // R2.6 第 2 条：选中该板后用属性面板翻面（点板的空白边距，避开孔）
    const body = await page.locator('[data-board="bb_1"].board-body').first().boundingBox();
    await page.mouse.click(body!.x + 4, body!.y + body!.height / 2);
    await expect(page.getByTestId('props-board')).toBeVisible();
    await page.getByTestId('flip-board').click();
    await expect(page.getByTestId('canvas-hud')).toContainText('焊接面：bb_1');

    const after1 = await holeBox('bb_1');
    const after2 = await holeBox('bb_2');
    expect(Math.abs(after1!.x - before1!.x)).toBeGreaterThan(20);
    expect(after2!.x).toBeCloseTo(before2!.x, 0);
    expect(after2!.y).toBeCloseTo(before2!.y, 0);

    // R2.5：翻面的板上点焊盘仍然点中它自己（反镜像命中）
    await clickHole(page, 'bb_1.A2');
    expect((await state(page)).selectedHole).toBe('bb_1.A2');
    await clickHole(page, 'bb_2.A2');
    expect((await state(page)).selectedHole).toBe('bb_2.A2');
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
