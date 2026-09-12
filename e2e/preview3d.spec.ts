import { expect, test } from '@playwright/test';
import { fresh, loadExample } from './helpers';

/**
 * 「3D 预览」模式：用 three.js 从同一份设计自动生成实体。
 * 这是只读模式 —— 画布换成 3D，编辑工具收起来，设计一点不动。
 */
test.describe('3D 预览', () => {
  test('切进 3D 预览：能起 WebGL、场景按设计生成、编辑工具收起来', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');

    // 搭建模式有 2D 画布和元件库
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('tab-library')).toBeVisible();

    await page.getByTestId('mode-preview3d').click();
    await expect(page.getByTestId('three-view')).toBeVisible();
    await expect(page.getByTestId('three-view')).toHaveAttribute('data-webgl', 'ok');

    // 3D 自己占满中间：2D 画布、左右面板都不在了
    await expect(page.getByTestId('canvas')).toHaveCount(0);
    await expect(page.getByTestId('tab-library')).toHaveCount(0);
    await expect(page.getByTestId('three-stats')).toContainText('孔');

    // 场景确实按设计生成了（几何是纯函数算的，不依赖渲染像素）
    const hook = await page.evaluate(() => (window as unknown as { __bbs3d?: { stats: Record<string, number>; objects: number } }).__bbs3d);
    expect(hook).toBeTruthy();
    expect(hook!.stats.boards).toBeGreaterThan(0);
    expect(hook!.stats.wires).toBeGreaterThan(0);
    expect(hook!.stats.holes).toBeGreaterThan(0);
    expect(hook!.objects).toBeGreaterThan(0);
  });

  test('视角按钮：等轴测 / 正俯视 / 正侧视，且不改设计', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    const before = JSON.stringify(await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => unknown } }).__bbs.getDesign()));

    await page.getByTestId('mode-preview3d').click();
    await expect(page.getByTestId('three-view')).toHaveAttribute('data-webgl', 'ok');
    for (const id of ['three-iso', 'three-top', 'three-front']) {
      await page.getByTestId(id).click();
      await expect(page.getByTestId(id)).toHaveClass(/active/);
    }

    // 只是看，不改设计
    const after = JSON.stringify(await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => unknown } }).__bbs.getDesign()));
    expect(after).toBe(before);

    // 切回搭建，2D 画布回来
    await page.getByTestId('mode-build').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
  });
});
