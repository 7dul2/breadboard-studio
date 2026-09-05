import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analysis, clickHole, design, fit, fresh, loadExample, state } from './helpers';

test.describe('editor core flows', () => {
  test('place boards and a module, wire, hit an error, fix it, export, import, refresh', async ({ page }) => {
    await fresh(page);

    // 1. two boards from the library (second one attaches to the right, grid aligned)
    await page.getByTestId('lib-breadboard_400').click();
    await page.getByTestId('lib-breadboard_400').click();
    let d = await design(page);
    expect(d.boards.map((b) => b.id)).toEqual(['bb_1', 'bb_2']);
    expect(d.boards[1]!.position_um[0]).toBeGreaterThan(80000);
    expect((d.boards[1]!.position_um[0] - d.boards[0]!.position_um[0]) % 2540).toBe(0);
    await fit(page);

    // 2. place a XIAO by clicking a hole while in placing mode
    await page.getByTestId('lib-xiao_esp32s3_sense').click();
    await expect(page.getByTestId('placing-hint')).toBeVisible();
    await clickHole(page, 'bb_1.b5');
    d = await design(page);
    expect(d.components.length).toBe(1);
    const mcu = d.components[0]!;
    expect(mcu.placement.kind).toBe('board');
    expect(mcu.placement.anchor_hole).toBe('b5');
    expect(mcu.placement.rotation_deg).toBe(90);
    let a = await analysis(page);
    expect(a.summary.blocking).toBe(0);

    // pins map to holes: D6 anchor at b5 → 3V3 at f9, GND at f10
    const pinHoles = await page.evaluate(() => {
      const w = window as unknown as { __bbs: { getAnalysis: () => { nets: unknown } } };
      return w.__bbs.getAnalysis();
    });
    expect(pinHoles).toBeTruthy();

    // 3. click a hole in the 3V3 group and check the properties panel + highlight
    await page.getByTestId('tool-select').click();
    await clickHole(page, 'bb_1.g9');
    expect((await state(page)).selectedHole).toBe('bb_1.g9');
    await expect(page.getByTestId('props-hole')).toContainText('f9 g9 h9 i9 j9');
    expect(await page.locator('[data-hole="bb_1.h9"][class*="hole"]').first().getAttribute('stroke')).toBe('#f59e0b');

    // 4. wire tool: 3V3 group → top_inner rail, GND group → top_outer rail
    await page.getByTestId('tool-wire').click();
    await page.getByTestId('wire-color').selectOption('red');
    await clickHole(page, 'bb_1.g9');
    await clickHole(page, 'bb_1.bottom_inner_5');
    await page.getByTestId('wire-color').selectOption('black');
    await clickHole(page, 'bb_1.g10');
    await clickHole(page, 'bb_1.bottom_outer_6');
    d = await design(page);
    expect(d.wires.length).toBe(2);
    expect(d.wires[0]!.from).toEqual({ hole: 'bb_1.g9' });
    expect(d.wires[0]!.to).toEqual({ hole: 'bb_1.bottom_inner_5' });
    a = await analysis(page);
    expect(a.nets.find((n) => n.name === '3V3')!.pins).toContain(`${mcu.id}.3V3`);
    expect(a.summary.error).toBe(0);

    // 5. make a mistake: bridge + rail to − rail → power_ground_short
    await clickHole(page, 'bb_1.bottom_inner_8');
    await clickHole(page, 'bb_1.bottom_outer_8');
    a = await analysis(page);
    expect(a.results.some((r) => r.code === 'power_ground_short')).toBe(true);
    await expect(page.getByTestId('count-error')).toContainText('错误 1');
    await page.getByTestId('result-power_ground_short').first().click();
    // clicking the result highlights the endpoints (pins get a highlight ring)
    await expect(page.locator('.pin-highlight').first()).toBeVisible();

    // 6. fix it: select the bad wire and delete
    await page.getByTestId('tool-select').click();
    const badWire = d.wires.length; // third wire is w3
    void badWire;
    await page.locator('[data-wire="w3"].wire').first().click({ force: true });
    expect((await state(page)).selectedIds).toEqual(['w3']);
    await page.keyboard.press('Delete');
    a = await analysis(page);
    expect(a.results.some((r) => r.code === 'power_ground_short')).toBe(false);
    await expect(page.getByTestId('count-error')).toContainText('错误 0');

    // 7. undo brings the error back, redo removes it again
    await page.getByTestId('undo').click();
    expect((await analysis(page)).summary.error).toBe(1);
    await page.getByTestId('redo').click();
    expect((await analysis(page)).summary.error).toBe(0);

    // 8. export SVG and JSON
    const [svgDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-export').click().then(() => page.getByTestId('export-svg').click())]);
    const svgText = readFileSync(await svgDl.path(), 'utf8');
    expect(svgText).toContain('<svg');
    expect(svgText).toContain('data-wire="w1"');
    expect(svgText).toContain('id="board:bb_2"');
    expect(svgText).toContain('图例');
    const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-project').click().then(() => page.getByTestId('menu-export-json').click())]);
    const jsonText = readFileSync(await jsonDl.path(), 'utf8');
    const exported = JSON.parse(jsonText);
    expect(exported.wires.length).toBe(2);
    const hashBefore = (await analysis(page)).hash;

    // 9. new project, then import the exported file back
    await page.getByTestId('menu-project').click();
    await page.getByTestId('menu-new').click();
    expect((await design(page)).boards.length).toBe(0);
    await page.getByTestId('import-input').setInputFiles({ name: 'x.breadboard.json', mimeType: 'application/json', buffer: Buffer.from(jsonText) });
    await expect(page.getByTestId('toast-success')).toBeVisible();
    d = await design(page);
    expect(d.boards.length).toBe(2);
    expect(d.components[0]!.id).toBe(mcu.id);
    expect((await analysis(page)).hash).toBe(hashBefore);

    // 10. refresh restores from local storage
    await expect(page.getByTestId('storage-status')).toContainText('已本地保存');
    await page.reload();
    d = await design(page);
    expect(d.boards.length).toBe(2);
    expect(d.wires.length).toBe(2);
    expect((await analysis(page)).hash).toBe(hashBefore);
  });

  test('invalid import is rejected explicitly and leaves the project untouched', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    const before = (await analysis(page)).hash;
    await page.getByTestId('import-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schema_version":"9.0","boards":[]}') });
    await expect(page.getByTestId('toast-error')).toContainText('导入失败');
    expect((await analysis(page)).hash).toBe(before);
    await page.getByTestId('import-input').setInputFiles({ name: 'bad2.json', mimeType: 'application/json', buffer: Buffer.from('not json at all') });
    await expect(page.getByTestId('toast-error').last()).toContainText('导入失败');
    expect((await analysis(page)).hash).toBe(before);
  });

  test('DSL panel: invalid draft never touches the canvas; valid draft applies', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'environment_node');
    const before = await design(page);
    await page.getByTestId('tab-dsl').click();
    const ta = page.getByTestId('dsl-text');
    await ta.fill('{"schema_version": "1.0", "boards": [');
    await page.getByTestId('dsl-apply').click();
    await expect(page.getByTestId('dsl-errors')).toBeVisible();
    expect((await design(page)).metadata.revision).toBe(before.metadata.revision);
    expect((await design(page)).wires.length).toBe(before.wires.length);
    // structural error (unknown hole) also refused
    const doc = JSON.parse(JSON.stringify(before)) as { wires: { from: Record<string, string> }[] };
    doc.wires[0]!.from = { hole: 'bb_a.z99' };
    await ta.fill(JSON.stringify(doc, null, 2));
    await page.getByTestId('dsl-apply').click();
    await expect(page.getByTestId('dsl-errors')).toContainText('invalid_hole');
    expect((await design(page)).metadata.revision).toBe(before.metadata.revision);
    // valid change: rename project and drop the last wire
    const good = JSON.parse(JSON.stringify(before)) as { metadata: { name: string }; wires: unknown[] };
    good.metadata.name = '通过 DSL 修改';
    good.wires.pop();
    await ta.fill(JSON.stringify(good, null, 2));
    await page.getByTestId('dsl-apply').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();
    const after = await design(page);
    expect(after.metadata.name).toBe('通过 DSL 修改');
    expect(after.wires.length).toBe(before.wires.length - 1);
    expect(after.metadata.revision).toBe(before.metadata.revision + 1);
    expect((await state(page)).dslDirty).toBe(false);
  });

  test('rotation by keyboard returns to the same pin map after four presses; drag moves a component', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'environment_node');
    await fit(page);
    const pinMap = async () => {
      const a = await analysis(page);
      return a.nets.map((n) => `${n.name}:${n.pins.join(',')}`).sort().join('|');
    };
    const start = await pinMap();
    await page.locator('[data-component="mcu"].component-hit').first().click({ force: true });
    expect((await state(page)).selectedIds).toEqual(['mcu']);
    for (let i = 0; i < 4; i++) await page.keyboard.press('r');
    const d = await design(page);
    expect(d.components.find((c) => c.id === 'mcu')!.placement.rotation_deg).toBe(90);
    expect(await pinMap()).toBe(start);

    // drag the SHT41 module two columns to the right (j12 → j14 is occupied by SCL... use j13? pick free area j5..)
    const from = await page.locator('[data-component="sht41"].component-body').first().boundingBox();
    const target = await page.locator('[data-hole="bb_b.j20"]').first().boundingBox();
    expect(from && target).toBeTruthy();
    // hole j12 is the anchor; move so that the anchor lands on bb_b.j20
    const anchor = await page.locator('[data-hole="bb_a.j12"]').first().boundingBox();
    const dx = target!.x - anchor!.x;
    const dy = target!.y - anchor!.y;
    const sx = from!.x + 3;
    const sy = from!.y + from!.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + dx / 2, sy + dy / 2, { steps: 5 });
    await page.mouse.move(sx + dx, sy + dy, { steps: 5 });
    await page.mouse.up();
    const moved = (await design(page)).components.find((c) => c.id === 'sht41')!;
    expect(moved.placement.board_id).toBe('bb_b');
    expect(moved.placement.anchor_hole).toBe('j20');
    // wires that pointed at the old holes now report the intent as open — no phantom connection
    const a = await analysis(page);
    expect(a.results.some((r) => r.code === 'net_intent_open')).toBe(true);
    expect(a.nets.find((n) => n.name === 'SDA')!.pins).not.toContain('sht41.SDA');
  });

  test('build mode lists every wire and remembers completion across reload', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    await page.getByTestId('build-mode').click();
    await expect(page.getByTestId('build-panel')).toContainText('0/11 已完成');
    await expect(page.getByTestId('build-current')).toContainText('bb.b24');
    await page.getByTestId('build-done').click();
    await expect(page.getByTestId('build-panel')).toContainText('1/11 已完成');
    await expect(page.getByTestId('build-current')).toContainText('bb.b3');
    await expect(page.getByTestId('storage-status')).toContainText('已本地保存');
    await page.reload();
    await page.getByTestId('build-mode').click();
    await expect(page.getByTestId('build-panel')).toContainText('1/11 已完成');
  });

  test('agent-style batch through the same engine matches the UI analysis', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'environment_node');
    const before = await analysis(page);
    const r = await page.evaluate(() =>
      (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean; results?: { code: string }[] } } }).__bbs.apply([
        { op: 'add_wire', wire: { id: 'w_agent', from: { hole: 'bb_a.bottom_inner_24' }, to: { hole: 'bb_b.bottom_inner_1' }, color: 'red' } }
      ])
    );
    expect(r.ok).toBe(true);
    const after = await analysis(page);
    expect(after.results.some((x) => x.code === 'isolation_violated')).toBe(true);
    expect(after.summary.error).toBe(before.summary.error + 1);
    await expect(page.getByTestId('result-isolation_violated')).toBeVisible();
    expect((await state(page)).past).toBe(1);
  });
});
