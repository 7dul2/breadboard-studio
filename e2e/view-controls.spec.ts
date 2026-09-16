import { test, expect, type Page } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, design, fit, fresh, openViewMenu, openWireOptions, state } from './helpers';

async function transform(page: Page) {
  return page.locator('[data-testid="canvas"] .scene').evaluate((el) => {
    const m = (el as unknown as SVGGraphicsElement).getScreenCTM()!;
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f, scale: Math.hypot(m.a, m.b) };
  });
}

test('rotation preserves design, hole hit testing and fit at all quarter turns', async ({ page }) => {
  await fresh(page);
  await addFromLibrary(page, 'breadboard_830');
  const before = (await analysis(page)).hash;
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('rotate-view').click();
    await fit(page);
    await clickHole(page, 'bb_1.a10');
    expect((await state(page)).selectedHole).toBe('bb_1.a10');
    const bounds = await page.getByTestId('canvas').boundingBox();
    const holes = await page.locator('[data-hole]').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }));
    for (const p of holes) {
      expect(p.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(p.x).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      expect(p.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(p.y).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    }
    expect((await analysis(page)).hash).toBe(before);
  }
  await page.getByTestId('rotate-view').click({ button: 'right' });
  await expect.poll(async () => (await transform(page)).b).toBeLessThan(0);
});

test('zoom buttons support keyboard and hold, and wheel zoom stays anchored after rotation', async ({ page }) => {
  await fresh(page); await addFromLibrary(page, 'breadboard_400'); await fit(page);
  await page.getByTestId('rotate-view').click();
  const original = await transform(page);
  await page.getByTestId('zoom-in').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await transform(page)).scale / original.scale).toBeCloseTo(1.15, 3);
  await page.getByTestId('zoom-out').click();
  await expect.poll(async () => (await transform(page)).scale).toBeCloseTo(original.scale, 3);
  const button = await page.getByTestId('zoom-in').boundingBox();
  await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2);
  await page.mouse.down();
  await expect.poll(async () => (await transform(page)).scale / original.scale).toBeGreaterThan(1.5);
  await page.mouse.up();
  await fit(page);
  const hole = page.locator('[data-hole="bb_1.a10"]').first();
  const r = await hole.boundingBox(); const x = r!.x + r!.width / 2; const y = r!.y + r!.height / 2;
  const before = await transform(page);
  await page.getByTestId('canvas').locator('svg.canvas').dispatchEvent('wheel', { clientX: x, clientY: y, deltaY: -100, deltaMode: 0, ctrlKey: true });
  await expect.poll(async () => (await transform(page)).scale / before.scale).toBeCloseTo(Math.exp(0.16), 3);
  const after = await hole.boundingBox();
  // Synthetic MouseEvent client coordinates are quantized to CSS pixels.
  expect(Math.abs(after!.x + after!.width / 2 - x)).toBeLessThan(0.3);
  expect(Math.abs(after!.y + after!.height / 2 - y)).toBeLessThan(0.3);
});

test('named and custom wire colors are saved through the editor and undo', async ({ page }) => {
  await fresh(page); await addFromLibrary(page, 'breadboard_400'); await fit(page);
  await page.getByTestId('tool-wire').click();
  await openWireOptions(page);
  const picker = page.getByTestId('wire-color');
  await expect(picker.locator('button')).toHaveCount(12);
  await picker.locator('[data-color="cyan"]').click();
  await clickHole(page, 'bb_1.a1'); await clickHole(page, 'bb_1.a2');
  const colors = () => page.evaluate(() => (window as any).__bbs.getDesign().wires.map((w: any) => w.color));
  expect(await colors()).toEqual(['cyan']);
  await openWireOptions(page);
  await page.getByTestId('wire-color-custom').fill('#123456');
  await clickHole(page, 'bb_1.a3'); await clickHole(page, 'bb_1.a4');
  expect(await colors()).toEqual(['cyan', '#123456']);
  await page.getByTestId('undo').click();
  expect((await design(page)).wires).toHaveLength(1);
});

/**
 * 应用栏信息架构（issue #37）。三区稳定：应用级 · 编辑上下文 · 视图与状态；
 * 显示类开关全部收进「视图」popover，主栏不再出现复选框。
 */
test.describe('应用栏信息架构（issue #37）', () => {
  test('1280px 宽下单行放下、留有余量，视图开关不在主栏里（选中与接线两种工具态）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fresh(page);

    const bar = page.locator('.toolbar');
    // 两种工具态都量一遍：接线工具会多出上下文控件，1280 下最先在这里溢出。
    for (const tool of ['select', 'wire'] as const) {
      if (tool === 'wire') await page.getByTestId('tool-wire').click();
      const layout = await bar.evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        // 隐藏的元素（1280 下收起的字标）尺寸为 0，不参与几何断言。
        const controls = [...el.querySelectorAll('.zone button, .zone select, .brand, .storage')].filter(
          (c) => !c.closest('.menu') && c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().height > 0
        );
        const boxes = controls.map((c) => c.getBoundingClientRect());
        const lineHeight = (c: Element) => {
          const s = getComputedStyle(c);
          return parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
        };
        return {
          width: Math.round(r.width),
          contentRight: Math.round(r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth)),
          worstRight: Math.round(Math.max(...boxes.map((b) => b.right))),
          centerSpread: Math.max(...boxes.map((b) => Math.round(b.top + b.height / 2))) - Math.min(...boxes.map((b) => Math.round(b.top + b.height / 2))),
          // 文字折行：按「内容高度 / 行高」数行数，不依赖具体字体度量（图标按钮没有文字，跳过）。
          wrapped: controls
            .filter((c) => (c.textContent ?? '').trim().length > 0)
            .map((c) => {
              const s = getComputedStyle(c);
              const inner = c.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
              return { text: (c.textContent ?? '').trim().slice(0, 8), lines: Math.round(inner / lineHeight(c)) };
            })
            .filter((x) => x.lines > 1),
          // 被压窄到内容放不下：nowrap 之后收缩会表现为标签被静默裁掉。
          clipped: controls
            .filter((c) => c.scrollWidth > c.clientWidth + 1)
            .map((c) => ({ text: (c.textContent ?? '').trim().slice(0, 10), scrollWidth: c.scrollWidth, clientWidth: c.clientWidth })),
          slack: Math.round(el.querySelector('.spacer')!.getBoundingClientRect().width)
        };
      });

      expect(layout.width, `${tool}：应用栏不该超出视口宽度`).toBeLessThanOrEqual(1280);
      expect(layout.worstRight, `${tool}：最右侧控件越过了内容区（右缘 ${layout.contentRight}）`).toBeLessThanOrEqual(layout.contentRight + 1);
      expect(layout.centerSpread, `${tool}：应用栏应当只有一行，不该换行`).toBeLessThanOrEqual(2);
      expect(layout.wrapped, `${tool}：这些控件里的文字折行了：${JSON.stringify(layout.wrapped)}`).toEqual([]);
      expect(layout.clipped, `${tool}：这些控件被压窄到内容放不下：${JSON.stringify(layout.clipped)}`).toEqual([]);
      expect(layout.slack, `${tool}：应用栏没有余量了，再加一个控件就会溢出`).toBeGreaterThan(0);
    }

    // 主栏里一个复选框都没有；显示开关只存在于 popover 打开时。
    await expect(page.locator('.toolbar input[type="checkbox"]')).toHaveCount(0);
    for (const id of ['toggle-hole-labels', 'toggle-pin-labels', 'toggle-connectivity', 'toggle-dim', 'toggle-solder-side']) {
      await expect(page.getByTestId(id), `${id} 应当收进视图 popover，而不是留在主栏`).toHaveCount(0);
    }
    await expect(page.getByTestId('view-menu')).toBeVisible();

    // 三个区都在，且顺序固定。
    await expect(page.locator('.toolbar .zone-app')).toBeVisible();
    await expect(page.locator('.toolbar .zone-tools')).toBeVisible();
    await expect(page.locator('.toolbar .zone-view')).toBeVisible();
  });

  test('视图 popover：收纳全部显示开关，Esc 与点击外部都能关，Esc 不清空选中', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400'); // 添加即选中 bb_1
    await openViewMenu(page);
    const pop = page.locator('.view-popover');
    for (const id of ['toggle-hole-labels', 'toggle-pin-labels', 'toggle-connectivity', 'toggle-dim', 'toggle-solder-side']) {
      await expect(pop.getByTestId(id), `${id} 应当在视图 popover 里`).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    expect((await state(page)).selectedIds, 'Esc 只关 popover，不该顺手清空选中').toEqual(['bb_1']);

    await openViewMenu(page);
    await expect(pop).toBeVisible();
    await page.getByTestId('canvas').click({ position: { x: 600, y: 300 } });
    await expect(pop).toHaveCount(0);
  });

  test('每个视图开关切换后画布真的变了', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await addFromLibrary(page, 'oled_0_96_ssd1315_i2c');
    await clickHole(page, 'bb_1.j9');
    await fit(page);

    const scene = page.locator('[data-testid="canvas"] .scene');
    // 两根线落在**不同导通网络**上：a1→a10 与 f1→f10（a–e 与 f–j 是两组）。
    // 第二根用来观察「聚焦选中」把无关导线压暗。
    await page.getByTestId('tool-wire').click();
    await clickHole(page, 'bb_1.a1'); await clickHole(page, 'bb_1.a10');
    await clickHole(page, 'bb_1.f1'); await clickHole(page, 'bb_1.f10');
    await page.getByTestId('tool-select').click();

    // 孔号：默认关 → 打开后出现孔号文字
    await expect(scene.locator('.hole-label')).toHaveCount(0);
    await openViewMenu(page);
    await page.getByTestId('toggle-hole-labels').check();
    await expect(scene.locator('.hole-label').first()).toBeVisible();

    // 针脚名：默认开 → 关掉后引脚的标签消失（同一 popover 保持打开）
    await expect(scene.locator('.pin-label').first()).toBeVisible();
    await page.getByTestId('toggle-pin-labels').uncheck();
    await expect(scene.locator('.pin-label')).toHaveCount(0);
    await page.getByTestId('toggle-pin-labels').check();
    await expect(scene.locator('.pin-label').first()).toBeVisible();

    // 选中 c1（与 a1 同组、上面没有导线，所以点下去选的是孔而不是线）。
    // 点画布 = 点 popover 外部，所以先选中、再重新打开 popover，选中本身保留。
    await clickHole(page, 'bb_1.c1');
    expect((await state(page)).selectedHole, '点画布应当保持选中这个孔').toBe('bb_1.c1');
    await openViewMenu(page);

    // 导通高亮：打开时高亮整条网络（c1 所在组 + 导线连到的 a10 那组 = 10 孔），关闭时只剩本组 5 孔。
    const highlighted = () => scene.locator('circle[stroke="#f59e0b"]').count();
    const onCount = await highlighted();
    await page.getByTestId('toggle-connectivity').uncheck();
    const offCount = await highlighted();
    expect(onCount, '导通高亮打开时应当高亮更多孔').toBeGreaterThan(offCount);
    expect(offCount).toBeGreaterThan(0);
    await page.getByTestId('toggle-connectivity').check();
    expect(await highlighted()).toBe(onCount);

    // 聚焦选中：默认开 → 另一根线（f1→f10）被压暗；关掉后不再有压暗的线。
    expect(await scene.locator('.wire-dimmed').count(), '默认应当压暗无关导线').toBeGreaterThan(0);
    await page.getByTestId('toggle-dim').uncheck();
    await expect(scene.locator('.wire-dimmed')).toHaveCount(0);
  });

  test('三区结构不随模式变化：仿真下视图与状态仍在同一位置', async ({ page }) => {
    await fresh(page);
    const before = (await page.locator('.toolbar .zone-view').boundingBox())!;
    await page.getByTestId('mode-sim').click();
    await expect(page.getByTestId('sim-status')).toBeVisible();
    const after = (await page.locator('.toolbar .zone-view').boundingBox())!;
    expect(Math.abs(after.x - before.x), '切模式不该让右区左右跳动').toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
    // 仿真态没有写设计的动作，但视图开关照样能用。
    await expect(page.getByTestId('copy')).toHaveCount(0);
    await openViewMenu(page);
    await expect(page.getByTestId('toggle-hole-labels')).toBeVisible();
  });
});
