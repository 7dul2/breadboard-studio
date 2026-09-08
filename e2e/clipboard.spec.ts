import { test, expect, type Page } from '@playwright/test';
import { design, fit, fresh, loadExample, state } from './helpers';

/**
 * Copy / cut / paste for 搭建. The property that matters is that a paste lands in
 * holes exactly where the pointer is — the same rule dragging uses — and that it is
 * a single undo step.
 */

const COPY = 'ControlOrMeta+c';
const CUT = 'ControlOrMeta+x';
const PASTE = 'ControlOrMeta+v';

async function components(page: Page): Promise<{ id: string; model: string; placement: Record<string, unknown> }[]> {
  return (await design(page)).components as { id: string; model: string; placement: Record<string, unknown> }[];
}

/** Park the pointer over one hole, which is what ⌘V anchors to. */
async function pointAt(page: Page, hole: string): Promise<void> {
  const box = (await page.locator(`[data-hole="${hole}"]`).first().boundingBox())!;
  expect(box, `hole ${hole} is on screen`).toBeTruthy();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function selectComponent(page: Page, id: string): Promise<void> {
  await page.locator(`[data-component="${id}"]`).last().click({ force: true });
  await expect.poll(async () => (await state(page)).selectedIds).toEqual([id]);
}

test.describe('搭建 · 复制粘贴', () => {
  test('① ⌘C then ⌘V drops a real copy into the hole under the pointer', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);

    const before = await components(page);
    const source = before.find((c) => c.id === 'touch')!;
    await selectComponent(page, 'touch');
    await page.keyboard.press(COPY);
    await expect.poll(async () => (await state(page)).hasClipboard).toBe(true);

    await pointAt(page, 'bb.e18');
    await page.keyboard.press(PASTE);

    await expect.poll(async () => (await components(page)).length).toBe(before.length + 1);
    const pasted = (await components(page)).find((c) => !before.some((b) => b.id === c.id))!;
    expect(pasted.model, 'same part, new id').toBe(source.model);
    expect(pasted.id).not.toBe('touch');
    expect(pasted.placement).toMatchObject({ kind: 'board', board_id: 'bb', anchor_hole: 'e18', rotation_deg: source.placement.rotation_deg });
    // the original is untouched and the copy is what is now selected
    expect((await components(page)).find((c) => c.id === 'touch')!.placement).toEqual(source.placement);
    expect((await state(page)).selectedIds).toEqual([pasted.id]);
  });

  test('② a paste is one undo step, not "appeared" plus "moved"', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    const before = await components(page);
    const undosBefore = (await state(page)).past;

    await selectComponent(page, 'touch');
    await page.keyboard.press(COPY);
    await pointAt(page, 'bb.e18');
    await page.keyboard.press(PASTE);
    await expect.poll(async () => (await components(page)).length).toBe(before.length + 1);
    expect((await state(page)).past).toBe(undosBefore + 1);

    await page.getByTestId('undo').click();
    await expect.poll(async () => (await components(page)).map((c) => c.id)).toEqual(before.map((c) => c.id));
  });

  test('③ the buffer survives a reload, so you can paste into another project', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await selectComponent(page, 'touch');
    await page.keyboard.press(COPY);
    await expect.poll(async () => (await state(page)).hasClipboard).toBe(true);

    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    expect((await state(page)).hasClipboard, 'the copy outlived the page').toBe(true);

    const before = await components(page);
    await page.getByTestId('paste').click();
    await expect.poll(async () => (await components(page)).length).toBe(before.length + 1);
  });

  test('④ ⌘X removes the original only after the copy is safely in the buffer', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);

    // a wire cannot be copied, so cutting one must not delete it either
    const wireId = (await design(page)).wires[0].id;
    await page.locator(`[data-wire="${wireId}"]`).first().click({ force: true });
    await expect.poll(async () => (await state(page)).selectedIds).toEqual([wireId]);
    await page.keyboard.press(CUT);
    await expect(page.getByTestId('toast-info')).toBeVisible();
    expect((await design(page)).wires.some((w) => w.id === wireId), 'the wire is still there').toBe(true);
    expect((await state(page)).hasClipboard).toBe(false);

    // cutting a component does copy and delete it, and it can be pasted back
    await selectComponent(page, 'touch');
    await page.keyboard.press(CUT);
    await expect.poll(async () => (await components(page)).some((c) => c.id === 'touch')).toBe(false);
    expect((await state(page)).hasClipboard).toBe(true);

    await pointAt(page, 'bb.e10');
    await page.keyboard.press(PASTE);
    await expect.poll(async () => (await components(page)).length).toBe(3);
    expect((await components(page)).find((c) => c.placement.anchor_hole === 'e10')).toBeTruthy();
  });

  test('⑤ 仿真 mode has no clipboard: the design is frozen there', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await selectComponent(page, 'touch');
    await page.keyboard.press(COPY);
    const before = await components(page);

    await page.getByTestId('mode-sim').click();
    await expect(page.getByTestId('sim-run')).toBeVisible();
    await expect(page.getByTestId('paste')).toHaveCount(0);
    await expect(page.getByTestId('copy')).toHaveCount(0);
    await page.keyboard.press(PASTE);
    await page.waitForTimeout(200);
    expect((await components(page)).length, 'nothing was pasted into a frozen design').toBe(before.length);

    await page.getByTestId('mode-build').click();
    await expect(page.getByTestId('paste')).toBeEnabled();
  });
});
