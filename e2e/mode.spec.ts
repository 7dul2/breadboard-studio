import { test, expect, type Page } from '@playwright/test';
import { design, enterBuild, enterHardware, enterSim, fit, fresh, loadExample, simulator, state } from './helpers';

/**
 * The 搭建/仿真 switch. The rule it enforces: 搭建 changes the circuit, 仿真 runs it.
 * What 仿真 may still write is exactly what the engine allows during a session
 * (program source and simulation config) — the topology is frozen, and every
 * control that would change it is absent rather than present-and-refused.
 */
const FIRST_RUN = { timeout: 20000 };

/** One topology edit, issued identically in both modes so that only the mode differs. */
function addBoard(page: Page): Promise<{ ok: boolean }> {
  return page.evaluate(() =>
    (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
      { op: 'add_board', board: { id: 'bb_x', model: 'breadboard_400@1', attach_to: { board_id: 'bb', side: 'right' } } }
    ])
  );
}

test.describe('mode switch · 搭建 edits, 仿真 runs', () => {
  test('① each mode shows only its own controls', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');

    // 搭建 is where the document is written
    expect((await state(page)).mode).toBe('build');
    await expect(page.getByTestId('tool-wire')).toBeVisible();
    await expect(page.getByTestId('undo')).toBeVisible();
    await expect(page.getByTestId('lib-esp32s3_n16r8_dual_usb')).toBeVisible();
    await expect(page.getByTestId('tab-wiring')).toBeVisible();
    await expect(page.getByTestId('sim-run')).toHaveCount(0);
    await expect(page.getByTestId('sim-status')).toHaveCount(0);

    // 仿真 keeps nothing that writes the circuit
    await enterSim(page);
    expect((await state(page)).rightTab).toBe('simulation');
    await expect(page.getByTestId('sim-status')).toBeVisible();
    await expect(page.getByTestId('sim-panel')).toBeVisible();
    for (const id of ['tool-select', 'tool-wire', 'tool-pan', 'undo', 'redo', 'tab-properties', 'tab-dsl', 'tab-wiring', 'lib-esp32s3_n16r8_dual_usb']) {
      await expect(page.getByTestId(id), `${id} is a 搭建 control`).toHaveCount(0);
    }

    // and back: the tools return, the transport goes
    await enterBuild(page);
    await expect(page.getByTestId('undo')).toBeVisible();
    await expect(page.getByTestId('sim-run')).toHaveCount(0);
  });

  test('② leaving 仿真 ends the session, so the edit it refused now lands', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await enterSim(page);
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');

    const boardsBefore = (await design(page)).boards.length;
    expect((await addBoard(page)).ok, 'a running session freezes the topology').toBe(false);
    expect((await design(page)).boards).toHaveLength(boardsBefore);

    // the switch is the promise: 搭建 means editable, so it stops the session itself
    await enterBuild(page);
    const sim = await simulator(page);
    expect(sim.status).toBe('idle');
    expect(sim.sessionId).toBeNull();
    expect(sim.canEditTopology).toBe(true);
    expect((await addBoard(page)).ok).toBe(true);
    expect((await design(page)).boards).toHaveLength(boardsBefore + 1);
  });

  test('③ 仿真 selects but never edits, even with no session running', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await enterSim(page);

    // no session at all: the old guard would have allowed this, only the mode stops it
    expect((await simulator(page)).canEditTopology).toBe(true);

    const body = page.locator('[data-component="touch"].component-body').first();
    const box = (await body.boundingBox())!;
    const before = (await design(page)).components.find((c) => c.id === 'touch')!.placement.anchor_hole;
    const revisionBefore = (await design(page)).metadata.revision;

    // clicking still inspects — selection is reading, not writing
    await body.click({ force: true });
    expect((await state(page)).selectedIds).toEqual(['touch']);

    // dragging it does nothing: pointer-down never captures, so nothing moves
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    expect((await design(page)).components.find((c) => c.id === 'touch')!.placement.anchor_hole).toBe(before);

    // and neither does the keyboard: 仿真 has no delete to offer
    await page.getByTestId('canvas').press('Delete');
    expect((await design(page)).components.map((c) => c.id)).toContain('touch');
    expect((await design(page)).metadata.revision).toBe(revisionBefore);
    await expect(page.getByTestId('toast-error')).toHaveCount(0);
  });

  test('⑤ 实机 is the third mode, and leaving 仿真 for it still ends the session', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await enterSim(page);
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');

    // the fix this asserts: the session ends on *leaving* 仿真, whatever the destination
    await enterHardware(page);
    const sim = await simulator(page);
    expect(sim.status).toBe('idle');
    expect(sim.sessionId).toBeNull();

    // 实机 borrows neither half's controls: it does not edit, and it does not simulate
    for (const id of ['tool-select', 'tool-wire', 'undo', 'tab-properties', 'tab-dsl', 'tab-wiring', 'lib-esp32s3_n16r8_dual_usb', 'sim-run', 'sim-status', 'sim-panel']) {
      await expect(page.getByTestId(id), `${id} 不属于实机`).toHaveCount(0);
    }
    await expect(page.getByTestId('hardware-panel')).toContainText('这不是仿真');

    // and back to 搭建: the 仿真/实机 tabs were never real tabs, so 属性 is what returns
    await enterBuild(page);
    expect((await state(page)).rightTab).toBe('properties');
    await expect(page.getByTestId('hardware-panel')).toHaveCount(0);
  });

  test('④ the wiring guide is a 搭建 panel and highlights the wire it is on', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await page.getByTestId('tab-wiring').click();
    await expect(page.getByTestId('build-panel')).toContainText('已完成');
    expect((await state(page)).rightTab).toBe('wiring');
    await expect(page.locator('.wire-halo'), 'the current wire is haloed on the canvas').toHaveCount(1);

    // it is not a mode of its own any more: leaving the tab drops the highlight
    await page.getByTestId('tab-properties').click();
    await expect(page.locator('.wire-halo')).toHaveCount(0);
  });
});
