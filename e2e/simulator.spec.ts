import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { addFromLibrary, analysis, clickHole, design, fit, fresh, loadExample, simulator } from './helpers';

test.describe('simulator shell (phase 0)', () => {
  test('example program is listed and active; the editor saves through ops and follows undo/redo', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await page.getByTestId('tab-simulation').click();
    await expect(page.getByTestId('sim-panel')).toBeVisible();
    await expect(page.getByTestId('sim-target')).toHaveValue('mcu');
    await expect(page.getByTestId('sim-program-program_main')).toBeVisible();
    await expect(page.getByTestId('sim-program-active-program_main')).toBeChecked();
    await expect(page.getByTestId('sim-panel-status')).toHaveText('停止');
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    await expect(page.getByTestId('sim-usb-mcu')).toBeChecked();
    await expect(page.getByTestId('sim-speed')).toHaveValue('1');
    await expect(page.getByTestId('sim-seed')).toHaveValue('1');
    await expect(page.getByTestId('sim-serial')).toContainText('串口输出会在程序运行时出现');
    await expect(page.getByTestId('sim-nets')).toContainText('SDA');
    expect((await simulator(page)).status).toBe('idle');

    const before = await design(page);
    const original = before.programs![0]!.source;
    expect(original).toContain('Touched');

    await page.getByTestId('sim-open-editor-program_main').click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await expect(page.getByTestId('code-editor')).toContainText('触摸显示示例');
    await expect(page.getByTestId('code-text')).toHaveValue(original);
    await expect(page.getByTestId('code-dirty')).toHaveText('已保存');
    await expect(page.getByTestId('code-save')).toBeDisabled();

    const edited = `${original}\n// e2e 修改\n`;
    await page.getByTestId('code-text').fill(edited);
    await expect(page.getByTestId('code-dirty')).toHaveText('未保存');
    await expect(page.getByTestId('code-save')).toBeEnabled();
    expect((await simulator(page)).dirty).toBe(true);
    // nothing reaches the design until it is saved
    expect((await design(page)).programs![0]!.source).toBe(original);

    await page.getByTestId('code-text').press('ControlOrMeta+s');
    await expect(page.getByTestId('code-dirty')).toHaveText('已保存');
    let d = await design(page);
    expect(d.metadata.revision).toBe(before.metadata.revision + 1);
    expect(d.programs![0]!.source).toContain('// e2e 修改');
    expect((await simulator(page)).dirty).toBe(false);

    await page.getByTestId('undo').click();
    d = await design(page);
    expect(d.programs![0]!.source).toBe(original);
    await expect(page.getByTestId('code-text')).toHaveValue(original);
    await expect(page.getByTestId('code-dirty')).toHaveText('已保存');

    await page.getByTestId('redo').click();
    await expect(page.getByTestId('code-text')).toHaveValue(edited);

    // Escape closes the drawer and keeps the state (no draft → nothing lost)
    await page.getByTestId('code-text').press('Escape');
    await expect(page.getByTestId('code-editor')).toHaveCount(0);
    expect((await simulator(page)).editorOpen).toBe(false);

    // a draft survives close/reopen
    await page.getByTestId('sim-open-editor-program_main').click();
    await page.getByTestId('code-text').fill(`${edited}// 草稿\n`);
    await page.getByTestId('code-close').click();
    await expect(page.getByTestId('code-editor')).toHaveCount(0);
    await page.getByTestId('sim-open-editor-program_main').click();
    await expect(page.getByTestId('code-text')).toHaveValue(`${edited}// 草稿\n`);
    await expect(page.getByTestId('code-dirty')).toHaveText('未保存');

    // 保存并运行 saves the draft through update_program first, then starts (and honestly faults) a session
    await page.getByTestId('code-run').click();
    await expect(page.getByTestId('code-dirty')).toHaveText('已保存');
    expect((await design(page)).programs![0]!.source).toBe(`${edited}// 草稿\n`);
    await expect(page.getByTestId('sim-status')).toHaveText('故障');
    await expect(page.getByTestId('sim-diagnostic-runtime_unavailable')).toBeVisible();
    expect((await simulator(page)).programId).toBe('program_main');
  });

  test('new program, honest faulted run without a backend, stale snapshot on topology change', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await fit(page);
    await page.getByTestId('tab-simulation').click();
    await expect(page.getByTestId('sim-no-mcu')).toContainText('先从元件库添加主控');
    await expect(page.getByTestId('sim-new-program')).toBeDisabled();

    await addFromLibrary(page, 'esp32s3_n16r8_dual_usb');
    await clickHole(page, 'bb_1.a9');
    let d = await design(page);
    expect(d.components).toHaveLength(1);
    const mcuId = d.components[0]!.id;
    expect((await analysis(page)).summary.blocking).toBe(0);

    await expect(page.getByTestId('sim-target')).toHaveValue(mcuId);
    await page.getByTestId('sim-new-program').click();
    await expect(page.getByTestId('sim-program-program_1')).toBeVisible();
    await expect(page.getByTestId('sim-program-active-program_1')).toBeChecked();
    d = await design(page);
    expect(d.programs).toHaveLength(1);
    expect(d.programs![0]).toMatchObject({ id: 'program_1', name: '程序 1', target_component_id: mcuId, language: 'studio-ts' });
    expect(d.simulation?.active_program_id).toBe('program_1');
    expect(d.programs![0]!.source).toContain("from '@bbs/runtime'");
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await expect(page.getByTestId('code-text')).toHaveValue(d.programs![0]!.source);
    await expect(page.getByTestId('code-text')).toHaveValue(/export async function setup\(\)/);

    // run: no execution backend in this phase → faulted with runtime_unavailable
    await expect(page.getByTestId('sim-stop')).toBeDisabled();
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveText('故障');
    await expect(page.getByTestId('sim-panel-status')).toHaveText('故障');
    await expect(page.getByTestId('sim-diagnostic-runtime_unavailable')).toBeVisible();
    let sim = await simulator(page);
    expect(sim.status).toBe('faulted');
    expect(sim.programId).toBe('program_1');
    expect(sim.allowed).toEqual(['reset', 'stop']);
    await expect(page.getByTestId('sim-run')).toBeDisabled();
    await expect(page.getByTestId('sim-stop')).toBeEnabled();

    // a topology change invalidates the session: back to idle with a stale-snapshot diagnostic
    const r = await page.evaluate(() =>
      (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
        { op: 'add_board', board: { id: 'bb_x', model: 'breadboard_400@1', attach_to: { board_id: 'bb_1', side: 'right' } } }
      ])
    );
    expect(r.ok).toBe(true);
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    await expect(page.getByTestId('sim-diagnostic-stale_simulation_snapshot')).toBeVisible();
    await expect(page.getByTestId('toast-info')).toContainText('快照过期');
    sim = await simulator(page);
    expect(sim.status).toBe('idle');
    expect(sim.sessionId).toBeNull();
    await expect(page.getByTestId('sim-stop')).toBeDisabled();
    await expect(page.getByTestId('sim-run')).toBeEnabled();

    // 清除 hides the finished session's diagnostics while idle
    await page.getByTestId('sim-clear-diagnostics').click();
    await expect(page.getByTestId('sim-diagnostic-stale_simulation_snapshot')).toHaveCount(0);

    // rename and delete are ops: undo brings the program back
    await page.getByTestId('sim-program-name-program_1').fill('闪烁');
    await page.getByTestId('sim-program-name-program_1').press('Enter');
    expect((await design(page)).programs![0]!.name).toBe('闪烁');
    await page.getByTestId('sim-delete-program-program_1').click();
    expect((await design(page)).programs ?? []).toHaveLength(0);
    await expect(page.getByTestId('code-editor')).toHaveCount(0);
    await page.getByTestId('undo').click();
    expect((await design(page)).programs).toHaveLength(1);
    await expect(page.getByTestId('sim-program-program_1')).toBeVisible();
  });

  test('programs and launch config survive export, import, reload and a 1.0 migration', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-project').click().then(() => page.getByTestId('menu-export-json').click())]);
    const jsonText = readFileSync(await dl.path(), 'utf8');
    const exported = JSON.parse(jsonText) as { schema_version: string; programs: { id: string }[]; simulation: Record<string, unknown> };
    expect(exported.schema_version).toBe('1.1');
    expect(exported.programs).toHaveLength(1);
    expect(exported.programs[0]!.id).toBe('program_main');
    expect(exported.simulation).toMatchObject({ active_program_id: 'program_main', usb_powered_components: ['mcu'] });
    const hashBefore = (await analysis(page)).hash;

    await page.getByTestId('menu-project').click();
    await page.getByTestId('menu-new').click();
    expect((await design(page)).programs ?? []).toHaveLength(0);
    await page.getByTestId('import-input').setInputFiles({ name: 'touch.breadboard.json', mimeType: 'application/json', buffer: Buffer.from(jsonText) });
    await expect(page.getByTestId('toast-success').filter({ hasText: '已导入' })).toBeVisible();
    let d = await design(page);
    expect(d.programs).toHaveLength(1);
    expect(d.simulation?.active_program_id).toBe('program_main');
    expect((await analysis(page)).hash).toBe(hashBefore);

    // reload restores the program from local storage and never auto-runs
    await expect(page.getByTestId('storage-status')).toContainText('已本地保存');
    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    d = await design(page);
    expect(d.programs).toHaveLength(1);
    expect((await simulator(page)).status).toBe('idle');
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    await page.getByTestId('tab-simulation').click();
    await expect(page.getByTestId('sim-program-program_main')).toBeVisible();

    // a 1.0 file is migrated on import
    const legacyText = JSON.stringify({ ...exported, schema_version: '1.0' });
    await page.getByTestId('import-input').setInputFiles({ name: 'legacy.breadboard.json', mimeType: 'application/json', buffer: Buffer.from(legacyText) });
    await expect(page.getByTestId('toast-success').filter({ hasText: '已导入' }).last()).toBeVisible();
    d = await design(page);
    expect(d.schema_version).toBe('1.1');
    expect(d.programs).toHaveLength(1);
    expect((await analysis(page)).hash).toBe(hashBefore);
  });

  test('running without a program reports program_missing and stays idle', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    expect((await design(page)).programs ?? []).toHaveLength(0);
    await expect(page.getByTestId('tab-properties')).toHaveClass(/active/);
    await page.getByTestId('sim-run').click();
    // the toolbar switches to the 仿真 tab so the outcome is visible
    await expect(page.getByTestId('sim-panel')).toBeVisible();
    await expect(page.getByTestId('toast-error')).toContainText('没有可运行的程序');
    await expect(page.getByTestId('sim-diagnostic-program_missing')).toBeVisible();
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    const sim = await simulator(page);
    expect(sim.status).toBe('idle');
    expect(sim.diagnostics.map((x) => x.code)).toEqual(['program_missing']);
  });
});

test.describe('simulator shell · session and draft boundaries', () => {
  test('playback speed is a live control; an unsaved draft never follows the user into another project', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await page.getByTestId('tab-simulation').click();

    // Running without a backend faults; changing 倍速 must not turn that into a stale-snapshot stop.
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveText('故障');
    await page.getByTestId('sim-speed').selectOption('2');
    await expect(page.getByTestId('sim-speed')).toHaveValue('2');
    expect((await design(page)).simulation?.speed).toBe(2);
    await expect(page.getByTestId('sim-status')).toHaveText('故障');
    expect((await simulator(page)).diagnostics.map((d) => d.code)).not.toContain('stale_simulation_snapshot');

    // Editing the wiring is a real change: the session stops with a stale-snapshot notice.
    await page.evaluate(() =>
      (window as unknown as { __bbs: { apply: (ops: unknown[]) => unknown } }).__bbs.apply([{ op: 'remove_wire', id: 'w11' }])
    );
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    expect((await simulator(page)).diagnostics.map((d) => d.code)).toContain('stale_simulation_snapshot');

    // An unsaved draft belongs to the document it was typed in.
    await page.getByTestId('sim-open-editor-program_main').click();
    await page.getByTestId('code-text').fill('// 旧项目的草稿\n');
    await expect(page.getByTestId('code-dirty')).toHaveText('未保存');
    // Re-load the same example: a second success toast is still on screen, so drive the menu directly.
    await page.getByTestId('menu-project').click();
    await page.getByTestId('example-touch_display').click();
    await expect(page.getByTestId('code-editor')).toHaveCount(0);
    expect((await simulator(page)).dirty).toBe(false);
    await page.getByTestId('tab-simulation').click();
    await page.getByTestId('sim-open-editor-program_main').click();
    await expect(page.getByTestId('code-text')).toHaveValue(/Touched/);
    await expect(page.getByTestId('code-text')).not.toHaveValue(/旧项目的草稿/);
    expect((await design(page)).programs![0]!.source).toContain('Touched');
  });
})
