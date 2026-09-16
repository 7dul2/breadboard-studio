import { test, expect, type Page } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, fresh, state } from './helpers';

/**
 * 面包板尺寸编辑（issue #22）：创建时自定义尺寸、双击进入尺寸编辑拖把手延长或
 * 裁剪、裁剪保护、一次撤销/重做、保存重载后保留。
 */

/** 一块 400 板的真实尺寸（mm）与孔距。 */
const BB400_W_MM = 82.55;
const PITCH_MM = 2.54;

/**
 * 画布上 1 mm 等于多少像素。直接用相邻两孔 a1/a2 的中心距反推 —— 它们永远
 * 相距一个孔距，所以缩放、平移、旋转都不会算错，也不用碰内部 view 状态。
 */
async function pxPerMm(page: Page, boardId: string): Promise<number> {
  const a = await page.locator(`[data-hole="${boardId}.a1"]`).first().boundingBox();
  const b = await page.locator(`[data-hole="${boardId}.a2"]`).first().boundingBox();
  expect(a && b, '孔 a1 / a2 应当可见').toBeTruthy();
  return (b!.x + b!.width / 2 - (a!.x + a!.width / 2)) / PITCH_MM;
}

/** 这块板当前的物理宽度（mm）。 */
async function boardWidthMm(page: Page, boardId: string): Promise<number> {
  const box = await page.locator(`[data-board="${boardId}"].board-body`).first().boundingBox();
  expect(box, '面包板板体应当可见').not.toBeNull();
  return box!.width / (await pxPerMm(page, boardId));
}

/** 这块板上最大的列号（= 终端孔列数）。 */
function maxColumn(page: Page, boardId: string): Promise<number> {
  return page.evaluate((id) => {
    const holes = [...document.querySelectorAll(`[data-hole^="${id}."]`)];
    return holes.reduce((max, el) => {
      const m = /^[a-z](\d+)$/.exec((el as HTMLElement).dataset.hole!.slice(id.length + 1));
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  }, boardId);
}

/** 双击板体的中央沟槽进入尺寸编辑（那里没有孔，命中一定是板本身）。 */
async function enterSizeEdit(page: Page, boardId: string): Promise<void> {
  await page.locator(`[data-board="${boardId}"] .board-ravine`).first().dblclick({ force: true });
  await expect(page.getByTestId(`resize-handle-x-${boardId}`)).toBeVisible();
}

/** 把 x 把手横向拖 `pitches` 个孔距（正数变宽、负数裁剪）。 */
async function dragResizeHandle(page: Page, boardId: string, pitches: number, opts: { release?: boolean } = {}): Promise<void> {
  const handle = page.getByTestId(`resize-handle-x-${boardId}`);
  const box = await handle.boundingBox();
  expect(box, `${boardId} 的右把手应当可见`).not.toBeNull();
  const scale = await pxPerMm(page, boardId);
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + pitches * PITCH_MM * scale, cy, { steps: 12 });
  if (opts.release !== false) await page.mouse.up();
}

test.describe('面包板尺寸编辑（#22）', () => {
  test('创建时自定义尺寸：40 列 × 5 行，孔号与外形都跟着变', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-breadboard_400').hover();
    await expect(page.getByTestId('model-size-editor')).toBeVisible();
    await page.getByTestId('model-size-columns').fill('40');
    await page.getByTestId('model-detail-add').click();

    expect(await maxColumn(page, 'bb_1')).toBe(40);
    expect(await page.locator('[data-hole="bb_1.a40"]').count()).toBe(1);
    expect(await page.locator('[data-hole="bb_1.a41"]').count()).toBe(0);
    // 外形：40 列比 30 列宽 10 个孔距
    expect(await boardWidthMm(page, 'bb_1')).toBeCloseTo(BB400_W_MM + 10 * PITCH_MM, 0);
    const d = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[] } } }).__bbs.getDesign());
    expect(d.boards[0]!.model).toContain('breadboard_400_custom');
  });

  test('不填尺寸时按原型号添加，不产生自定义定义', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    expect(await maxColumn(page, 'bb_1')).toBe(30);
    const d = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[] } } }).__bbs.getDesign());
    expect(d.boards[0]!.model).toBe('breadboard_400@1');
  });

  test('双击进入尺寸编辑，拖右把手延长：预览吸附到孔距，松手确认', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await page.getByTestId('fit').click();
    await enterSizeEdit(page, 'bb_1');

    await dragResizeHandle(page, 'bb_1', 10, { release: false });
    // 拖动中应当有预览文字（列 × 行）
    await expect(page.locator('.canvas text', { hasText: /40 列 × 5 行/ }).first()).toBeVisible();
    await page.mouse.up();

    await expect(page.getByTestId('toast-success')).toBeVisible();
    expect(await maxColumn(page, 'bb_1')).toBe(40);
    expect(await page.locator('[data-hole="bb_1.a40"]').count()).toBe(1);
  });

  test('拖把手裁剪：30 → 20 列，孔位真的少了，一次撤销可回到 30 列', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await page.getByTestId('fit').click();

    const handle = page.getByTestId('resize-handle-x-bb_1');
    expect(await handle.count()).toBe(0); // 未进入尺寸编辑时没有把手
    await enterSizeEdit(page, 'bb_1');

    await dragResizeHandle(page, 'bb_1', -10);

    expect(await maxColumn(page, 'bb_1')).toBe(20);
    // 一次撤销回到 30 列
    await page.getByTestId('undo').click();
    expect(await maxColumn(page, 'bb_1')).toBe(30);
    await page.getByTestId('redo').click();
    expect(await maxColumn(page, 'bb_1')).toBe(20);
  });

  test('Esc 取消拖动，尺寸不变', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await page.getByTestId('fit').click();
    await enterSizeEdit(page, 'bb_1');

    await dragResizeHandle(page, 'bb_1', 10, { release: false });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await maxColumn(page, 'bb_1')).toBe(30);
    const s = await state(page);
    expect(s.past).toBe(1); // 只有"添加面包板"那一步
  });

  test('裁剪保护：裁掉仍有元件锚点的孔位会被拒绝，且给出孔号', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await addFromLibrary(page, 'oled_0_96_ssd1315_i2c');
    await clickHole(page, 'bb_1.a25');
    expect((await analysis(page)).summary.blocking).toBe(0);
    await page.getByTestId('fit').click();
    await enterSizeEdit(page, 'bb_1');

    // 拖到 20 列：a25（以及 a26–a28）会被裁掉 —— 拖动中就该看到明确的不行提示
    await dragResizeHandle(page, 'bb_1', -10, { release: false });
    await expect(page.locator('.canvas text.overlay-bad')).toBeVisible();
    await page.mouse.up();

    await expect(page.getByTestId('toast-error')).toBeVisible();
    await expect(page.getByTestId('toast-error')).toContainText('a25');
    expect(await maxColumn(page, 'bb_1')).toBe(30); // 没有被改掉
  });

  test('保存重载后尺寸与自定义定义都保留', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-breadboard_400').hover();
    await page.getByTestId('model-size-columns').fill('45');
    await page.getByTestId('model-detail-add').click();
    expect(await maxColumn(page, 'bb_1')).toBe(45);

    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    expect(await maxColumn(page, 'bb_1')).toBe(45);
    const d = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { boards: { model: string }[]; embedded_catalog?: { boards?: { id: string }[] } } } }).__bbs.getDesign());
    expect(d.boards[0]!.model).toContain('breadboard_400_custom');
    expect(d.embedded_catalog?.boards?.map((b) => b.id)).toContain('breadboard_400_custom');
  });

  test('可拆拼装型号（中间接线板）也能自定义尺寸', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('lib-breadboard_400_terminal').hover();
    await expect(page.getByTestId('model-size-editor')).toBeVisible();
    await page.getByTestId('model-size-columns').fill('15');
    await page.getByTestId('model-detail-add').click();
    expect(await maxColumn(page, 'bb_1')).toBe(15);
    // 派生体仍是可拼接的几何件（有中间沟槽、没有电源轨）
    const d = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { embedded_catalog?: { boards?: { id: string; rails: unknown[]; terminal_blocks: { columns: number }[] }[] } } } }).__bbs.getDesign());
    const def = d.embedded_catalog!.boards!.find((b) => b.id === 'breadboard_400_terminal_custom')!;
    expect(def.terminal_blocks[0]!.columns).toBe(15);
    expect(def.rails).toHaveLength(0);
  });

  test('锁定后的板双击不会进入尺寸编辑', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await page.getByTestId('prop-board-locked').check();
    await page.locator('[data-board="bb_1"] .board-ravine').first().dblclick({ force: true });
    await expect(page.getByTestId('toast-error')).toContainText('已锁定');
    await expect(page.getByTestId('resize-handle-x-bb_1')).toHaveCount(0);
  });
});
