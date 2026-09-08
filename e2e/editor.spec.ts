import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addFromLibrary, analysis, clickHole, design, fit, fresh, loadExample, state } from './helpers';

test.describe('editor core flows', () => {
  test('shows the curated library with integrated and modular breadboard groups', async ({ page }) => {
    await fresh(page);
    await expect(page.locator('.library-list .lib-item')).toHaveCount(6);
    await expect(page.locator('.lib-cat')).toContainText(['面包板 · 一体式', '面包板 · 可拆拼装式', '主控', '显示']);
    await expect(page.getByTestId('lib-breadboard_400')).toBeVisible();
    await expect(page.getByTestId('lib-breadboard_400_terminal')).toBeVisible();
    await expect(page.getByTestId('lib-breadboard_power_strip_25')).toBeVisible();
    await expect(page.getByTestId('lib-breadboard_830')).toBeVisible();
    await expect(page.getByTestId('lib-esp32s3_n16r8_dual_usb')).toBeVisible();
    await expect(page.getByTestId('lib-oled_0_96_ssd1315_i2c')).toBeVisible();
    await expect(page.getByTestId('lib-xiao_esp32s3_sense')).toHaveCount(0);

    await page.getByTestId('lib-esp32s3_n16r8_dual_usb').hover();
    const card = page.getByTestId('model-detail-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('ESP32-S3 N16R8');
    await expect(card).toContainText('44');
    await expect(card.locator('.model-preview svg')).toBeVisible();
    await card.hover();
    await page.waitForTimeout(250);
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);

    await page.getByTestId('lib-oled_0_96_ssd1315_i2c').hover();
    await expect(page.getByTestId('model-detail-card')).toBeVisible();
    await page.getByTestId('tool-select').hover();
    await expect(page.getByTestId('model-detail-card')).toHaveCount(0);
  });

  test('assembles terminal + power + terminal so the N16R8 spans h/b', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400_terminal');
    await addFromLibrary(page, 'breadboard_power_strip_25');
    await page.locator('.board-body[data-board="bb_2"]').click({ force: true });
    await page.getByTestId('board-join-target').selectOption('bb_1');
    await page.getByTestId('board-join-bottom').click();
    await addFromLibrary(page, 'breadboard_400_terminal');
    await page.locator('.board-body[data-board="bb_3"]').click({ force: true });
    await page.getByTestId('board-join-target').selectOption('bb_2');
    await page.getByTestId('board-join-bottom').click();
    await fit(page);
    await addFromLibrary(page, 'esp32s3_n16r8_dual_usb');
    await clickHole(page, 'bb_1.h9');

    const placed = await design(page);
    expect(placed.boards.map((board) => board.position_um[1])).toEqual([0, 35560, 48260]);
    expect(placed.components[0]?.placement).toMatchObject({ board_id: 'bb_1', anchor_hole: 'h9', anchor_pin: 'GND_3' });
    const pins = await page.locator('[data-component="esp32s3_n16r8_dual_usb_1"] [data-pin]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-pin')));
    expect(pins).toHaveLength(44);
    await expect(page.locator('[data-pin="esp32s3_n16r8_dual_usb_1.GND_3"]')).toBeVisible();
    expect((await analysis(page)).summary.blocking).toBe(0);
  });

  test('joins breadboards on any selected edge with an aligned hole grid', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await addFromLibrary(page, 'breadboard_400');

    await expect(page.getByTestId('board-join-panel')).toBeVisible();
    await expect(page.getByTestId('board-join-panel')).toContainText('已拼接：bb_2 位于 bb_1 的右侧');
    await page.getByTestId('board-join-target').selectOption('bb_1');
    await page.getByTestId('board-join-bottom').click();

    const d = await design(page);
    const first = d.boards.find((board) => board.id === 'bb_1')!;
    const second = d.boards.find((board) => board.id === 'bb_2')!;
    expect(second.position_um[1] - first.position_um[1]).toBe(53340);
    expect((second.position_um[0] - first.position_um[0]) % 2540).toBe(0);
    await expect(page.getByTestId('board-join-panel')).toContainText('已拼接：bb_2 位于 bb_1 的下方');
    await expect(page.getByTestId('toast-success')).toContainText('bb_2 已拼到下方 bb_1');

    await addFromLibrary(page, 'esp32s3_n16r8_dual_usb');
    await clickHole(page, 'bb_1.j9');
    const placed = await design(page);
    expect(placed.components[0]!.placement).toMatchObject({ kind: 'board', board_id: 'bb_1', anchor_hole: 'j9', anchor_pin: 'GND_3', rotation_deg: 90 });
    expect((await analysis(page)).summary.blocking).toBe(0);
  });

  test('place boards and a module, wire, hit an error, fix it, export, import, refresh', async ({ page }) => {
    await fresh(page);

    // 1. two boards from the library (second one attaches to the right, grid aligned)
    await addFromLibrary(page, 'breadboard_400');
    await addFromLibrary(page, 'breadboard_400');
    let d = await design(page);
    expect(d.boards.map((b) => b.id)).toEqual(['bb_1', 'bb_2']);
    expect(d.boards[1]!.position_um[0]).toBeGreaterThan(80000);
    expect((d.boards[1]!.position_um[0] - d.boards[0]!.position_um[0]) % 2540).toBe(0);
    await fit(page);

    // 2. place the retained OLED by clicking a hole while in placing mode
    await addFromLibrary(page, 'oled_0_96_ssd1315_i2c');
    await expect(page.getByTestId('placing-hint')).toBeVisible();
    await clickHole(page, 'bb_1.j9');
    d = await design(page);
    expect(d.components.length).toBe(1);
    const mcu = d.components[0]!;
    expect(mcu.placement.kind).toBe('board');
    expect(mcu.placement.anchor_hole).toBe('j9');
    expect(mcu.placement.rotation_deg).toBe(0);
    let a = await analysis(page);
    expect(a.summary.blocking).toBe(0);

    // pins map to j9–j12; their five-hole groups remain available from f–i.
    const pinHoles = await page.evaluate(() => {
      const w = window as unknown as { __bbs: { getAnalysis: () => { nets: unknown } } };
      return w.__bbs.getAnalysis();
    });
    expect(pinHoles).toBeTruthy();

    // 3. click a hole in the GND group and check the properties panel + highlight
    await page.getByTestId('tool-select').click();
    await clickHole(page, 'bb_1.g9');
    expect((await state(page)).selectedHole).toBe('bb_1.g9');
    await expect(page.getByTestId('props-hole')).toContainText('f9 g9 h9 i9 j9');
    expect(await page.locator('[data-hole="bb_1.h9"][class*="hole"]').first().getAttribute('stroke')).toBe('#f59e0b');

    // 4. wire tool: GND group → inner rail, VCC group → outer rail
    await page.getByTestId('tool-wire').click();
    await page.getByTestId('wire-color').selectOption('red');
    await clickHole(page, 'bb_1.g9');
    await clickHole(page, 'bb_1.top_inner_5');
    await page.getByTestId('wire-color').selectOption('black');
    await clickHole(page, 'bb_1.g10');
    await clickHole(page, 'bb_1.top_outer_6');
    d = await design(page);
    expect(d.wires.length).toBe(2);
    expect(d.wires[0]!.from).toEqual({ hole: 'bb_1.g9' });
    expect(d.wires[0]!.to).toEqual({ hole: 'bb_1.top_inner_5' });
    a = await analysis(page);
    expect(a.nets.some((n) => n.pins.includes(`${mcu.id}.VCC`))).toBe(true);
    expect(a.summary.error).toBe(0);

    // 5. make a mistake: bridge + rail to − rail → power_ground_short
    await clickHole(page, 'bb_1.top_inner_8');
    await clickHole(page, 'bb_1.top_outer_8');
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

  test('the wiring guide lists every wire and remembers completion across reload', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    await page.getByTestId('tab-wiring').click();
    await expect(page.getByTestId('build-panel')).toContainText('0/11 已完成');
    await expect(page.getByTestId('build-current')).toContainText('bb.b24');
    await page.getByTestId('build-done').click();
    await expect(page.getByTestId('build-panel')).toContainText('1/11 已完成');
    await expect(page.getByTestId('build-current')).toContainText('bb.b3');
    await expect(page.getByTestId('storage-status')).toContainText('已本地保存');
    await page.reload();
    await page.getByTestId('tab-wiring').click();
    await expect(page.getByTestId('build-panel')).toContainText('1/11 已完成');
  });

  test('multi-selection auto-wires components to one host with selectable Dupont or hard jumpers', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    await page.evaluate(() => {
      const api = (window as unknown as { __bbs: { getDesign: () => { wires: { id: string }[]; net_intents: { id: string }[] }; apply: (ops: unknown[]) => unknown } }).__bbs;
      const d = api.getDesign();
      api.apply([
        ...d.wires.map((w) => ({ op: 'remove_wire', id: w.id })),
        ...d.net_intents.map((n) => ({ op: 'remove_net_intent', id: n.id }))
      ]);
    });
    await fit(page);
    await page.locator('[data-component="mcu"].component-hit').first().click({ force: true });
    await page.locator('[data-component="oled"].component-body').first().click({ force: true, modifiers: ['Shift'] });
    await page.locator('[data-component="touch"].component-body').first().click({ force: true, modifiers: ['Shift'] });
    await expect(page.getByTestId('autowire-panel')).toBeVisible();
    await expect(page.getByTestId('autowire-host')).toHaveValue('mcu');
    // Default "auto": short rail taps and feeders are hard jumpers, the long I²C/IO runs across the DevKit are Dupont wires.
    await expect(page.getByTestId('autowire-route')).toHaveValue('auto');
    await expect(page.getByTestId('autowire-global')).toBeChecked();
    await page.getByTestId('autowire-run').click();
    const done = page.getByTestId('toast-success').filter({ hasText: '自动排线完成' });
    await expect(done).toBeVisible();
    await expect(done).toContainText('全局优化');
    await expect(done).toContainText('目标值');
    const auto = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { wires: { name?: string; route: string; from: { hole?: string }; to?: { hole?: string } }[]; net_intents: { name: string }[] } } }).__bbs.getDesign());
    expect(auto.wires.filter((w) => w.route === 'flat').length).toBeGreaterThan(0);
    expect(auto.wires.filter((w) => w.route === 'elevated').length).toBeGreaterThan(0);
    expect(auto.wires.filter((w) => w.name?.includes('馈线')).length).toBe(2);
    expect(auto.wires.filter((w) => w.name?.includes('桥线')).length).toBe(2);
    expect(auto.net_intents.map((n) => n.name).sort()).toEqual(['3V3', 'GND', 'SCL', 'SDA', 'TOUCH_IO']);
    let a = await analysis(page);
    expect(a.summary.error).toBe(0);
    expect(a.results.some((r) => r.code === 'net_intent_open')).toBe(false);
    expect((await state(page)).selectedIds).toEqual(['mcu', 'oled', 'touch']);
    await page.getByTestId('undo').click();
    expect((await design(page)).wires).toHaveLength(0);

    // Forced Dupont wires: every wire is a straight span.
    await page.getByTestId('autowire-route').selectOption('elevated');
    await page.getByTestId('autowire-run').click();
    await expect(page.getByTestId('toast-success').filter({ hasText: '自动排线完成' }).last()).toBeVisible();
    const after = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { wires: { route: string; waypoints_um: unknown[] }[] } } }).__bbs.getDesign());
    expect(after.wires.length).toBeGreaterThan(0);
    expect(after.wires.every((w) => w.route === 'elevated' && w.waypoints_um.length === 0)).toBe(true);
    a = await analysis(page);
    expect(a.summary.error).toBe(0);
    await page.getByTestId('undo').click();
    expect((await design(page)).wires).toHaveLength(0);
  });

  test('artwork editor: move, copy, delete parts of a board drawing and save it into the project', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await fit(page);
    await addFromLibrary(page, 'esp32s3_n16r8_dual_usb');
    await clickHole(page, 'bb_1.a9');
    await page.getByTestId('tool-select').click();
    await page.locator('.component-hit').first().click({ force: true });
    await page.getByTestId('prop-edit-artwork').click();
    await expect(page.getByTestId('artwork-editor')).toBeVisible();
    const parts = page.locator('[data-testid="artwork-part"]');
    const count = await parts.count();
    expect(count).toBeGreaterThan(100);
    // A framed capacitor is one part of four primitives; arrows nudge it by 0.1 mm / 1 mm.
    await page.locator('[data-part="s1"]').click({ force: true });
    await expect(page.getByTestId('artwork-selected')).toContainText('s1 · 4 个图元');
    const x0 = Number(await page.getByTestId('artwork-x').inputValue());
    const y0 = Number(await page.getByTestId('artwork-y').inputValue());
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    expect(Number(await page.getByTestId('artwork-x').inputValue())).toBeCloseTo(x0 + 0.1, 5);
    expect(Number(await page.getByTestId('artwork-y').inputValue())).toBeCloseTo(y0 + 1, 5);
    // Copy makes a new part selected; delete removes it again. The main editor's shortcuts stay untouched.
    await page.getByTestId('artwork-duplicate').click();
    expect(await parts.count()).toBe(count + 1);
    await expect(page.getByTestId('artwork-selected')).toContainText('n1');
    await page.keyboard.press('Delete');
    expect(await parts.count()).toBe(count);
    expect((await design(page)).components.length).toBe(1);
    // Save embeds the definition (same ref) with tagged parts; the design now carries the custom drawing and undo removes it.
    await page.getByTestId('artwork-save').click();
    await expect(page.getByTestId('toast-success').filter({ hasText: '新绘图' })).toBeVisible();
    await expect(page.getByTestId('artwork-editor')).toHaveCount(0);
    const d = await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { embedded_catalog?: { components?: { id: string; version: number; render: { g?: string; x?: number }[] }[] } } } }).__bbs.getDesign());
    const emb = d.embedded_catalog!.components!.find((c) => c.id === 'esp32s3_n16r8_dual_usb')!;
    expect(emb.version).toBe(1);
    expect(emb.render.every((p) => typeof p.g === 'string')).toBe(true);
    expect((await analysis(page)).summary.blocking).toBe(0);
    await expect(page.getByTestId('props-component')).toContainText('本项目使用自定义绘图');
    await page.getByTestId('undo').click();
    expect((await design(page)).components.length).toBe(1);
    expect(((await page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => { embedded_catalog?: unknown } } }).__bbs.getDesign())).embedded_catalog)).toBeUndefined();
  });

  test('the artwork editor offers a library write-back, and the endpoint only ever overwrites', async ({ page, request }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await fit(page);
    await addFromLibrary(page, 'esp32s3_n16r8_dual_usb');
    await clickHole(page, 'bb_1.a9');
    await page.getByTestId('tool-select').click();
    await page.locator('.component-hit').first().click({ force: true });
    await page.getByTestId('prop-edit-artwork').click();
    // dev only: the built site has no filesystem behind it (scripts/check-dist.mjs bans the URL)
    await expect(page.getByTestId('artwork-write-library')).toBeVisible();

    // Everything that is not an overwrite of an existing definition is refused before
    // any write happens — which is what lets this run against the real catalog directory.
    const base = { kind: 'component', version: 1, name: 'x' };
    const cases: [unknown, number][] = [
      [{ ...base, id: 'definitely_not_a_model' }, 403],
      [{ ...base, id: '../../../../etc/passwd' }, 400],
      [{ ...base, id: 'esp32s3_n16r8_dual_usb', version: '1' }, 400],
      [{ ...base, id: 'esp32s3_n16r8_dual_usb', kind: 'gadget' }, 400],
      [[1, 2, 3], 400]
    ];
    for (const [body, status] of cases) {
      const res = await request.post('/__bbs/definition', { data: body });
      expect(res.status(), JSON.stringify(body).slice(0, 48)).toBe(status);
      expect((await res.json()).ok).toBe(false);
    }
    expect((await request.get('/__bbs/definition')).status()).toBe(405);
  });

  test('deleting a component also prunes its network-intent references', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'desk_device');
    await fit(page);
    const before = await design(page);
    expect(before.net_intents.some((intent) => intent.endpoints.some((endpoint) => endpoint.startsWith('mcu.')))).toBe(true);

    await page.locator('[data-component="mcu"].component-hit').first().click({ force: true });
    await page.keyboard.press('Delete');

    const after = await design(page);
    expect(after.components.some((component) => component.id === 'mcu')).toBe(false);
    expect(after.net_intents.some((intent) => intent.endpoints.some((endpoint) => endpoint.startsWith('mcu.')))).toBe(false);
    expect((await analysis(page)).results.some((result) => result.code === 'unknown_reference')).toBe(false);
    await expect(page.getByTestId('toast-error')).toHaveCount(0);
  });

  test('places the detailed dual-USB N16R8 board and changes its RGB LED', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_830');
    await fit(page);
    await addFromLibrary(page, 'esp32s3_n16r8_dual_usb');
    await clickHole(page, 'bb_1.b30');

    const d = await design(page);
    const mcu = d.components[0]!;
    expect(mcu.model).toBe('esp32s3_n16r8_dual_usb@1');
    expect(mcu.placement.rotation_deg).toBe(90);
    await expect(page.locator(`[data-pin^="${mcu.id}."]`)).toHaveCount(44);
    await expect(page.locator(`#component\\:${mcu.id} rect[fill="#0b0e0f"]`)).toBeVisible();

    await page.getByLabel('板载 RGB 灯 R').fill('12');
    await page.getByLabel('板载 RGB 灯 G').fill('34');
    await page.getByLabel('板载 RGB 灯 B').fill('56');
    await page.getByLabel('板载 RGB 灯 B').press('Enter');
    await expect(page.locator(`#component\\:${mcu.id} circle[fill="rgb(12, 34, 56)"]`)).toBeVisible();
    expect((await analysis(page)).summary.blocking).toBe(0);
  });

  test('keeps the placement cursor centered on the selected anchor pin', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'esp32s3_n16r8_dual_usb');
    const canvas = await page.getByTestId('canvas').boundingBox();
    expect(canvas).not.toBeNull();
    const target = { x: canvas!.x + 650, y: canvas!.y + 240 };

    await page.mouse.click(target.x, target.y);

    const placed = (await design(page)).components[0]!;
    expect(placed.placement.kind).toBe('off_board');
    const anchor = await page.locator(`[data-pin="${placed.id}.GND_3"]`).boundingBox();
    expect(anchor).not.toBeNull();
    expect(Math.abs(anchor!.x + anchor!.width / 2 - target.x)).toBeLessThan(1);
    expect(Math.abs(anchor!.y + anchor!.height / 2 - target.y)).toBeLessThan(1);
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

test('custom definition import through the library', async ({ page }) => {
  await fresh(page);
  await addFromLibrary(page, 'breadboard_400');
  const def = readFileSync(join(import.meta.dirname, '..', 'examples', 'custom_definition_example.json'), 'utf8');
  await page.getByTestId('definition-input').setInputFiles({ name: 'def.json', mimeType: 'application/json', buffer: Buffer.from(def) });
  await expect(page.getByTestId('toast-success')).toContainText('my_3pin_module');
  await expect(page.getByTestId('lib-my_3pin_module')).toBeVisible();
  await addFromLibrary(page, 'my_3pin_module');
  await clickHole(page, 'bb_1.j10');
  const d = await design(page);
  expect(d.components[0]!.placement.anchor_hole).toBe('j10');
  expect((d as unknown as { embedded_catalog: { components: unknown[] } }).embedded_catalog.components.length).toBe(1);
  await page.getByTestId('definition-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"component","id":"x"}') });
  await expect(page.getByTestId('toast-error')).toBeVisible();
});

test('PNG export produces a real PNG of the whole design', async ({ page }) => {
  await fresh(page);
  await loadExample(page, 'desk_device');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-export').click().then(() => page.getByTestId('export-png').click())]);
  const buf = readFileSync(await dl.path());
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect(width).toBeGreaterThan(1500);
  expect(height).toBeGreaterThan(500);
  expect(dl.suggestedFilename()).toMatch(/\.png$/);
});
