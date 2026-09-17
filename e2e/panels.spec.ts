import { expect, test, type Page } from '@playwright/test';
import { addFromLibrary, analysis, canvasWidth, clickHole, dragPanelRail, enterBuild, enterSim, fresh, loadExample, panelWidth, panelWidthVar, simulator, state, togglePanelRail, viewportWidth } from './helpers';

/**
 * issue #39：左右面板可折叠 / 可调宽 / 记忆布局。
 *
 * 贯穿全篇的一条判据：**面板宽度必须真的变成画布空间**。所以每个用例断言的都不是
 * 「看起来变了」，而是 `画布宽度 === 布局视口宽度 − 左面板 − 右面板`，以及同一次改动里
 * 面板多占的像素与画布少掉的像素相等。`panelWidth` 量的是布局后的盒子宽度，不是 CSS 变量。
 */
const LEFT_DEFAULT = 260;
const RIGHT_DEFAULT = 340;
/** 折叠后剩下的那条常驻轨道的宽度（styles.css 的 --panel-rail-width）。 */
const RAIL = 10;

/** 面板宽度与画布宽度必须严格互补：面板占多少，画布就少多少。 */
async function expectLayout(page: Page, left: number, right: number): Promise<void> {
  const viewport = await viewportWidth(page);
  expect(await panelWidth(page, 'left'), '左面板占的宽度').toBe(left);
  expect(await panelWidth(page, 'right'), '右面板占的宽度').toBe(right);
  expect(await canvasWidth(page), '画布宽度').toBe(viewport - left - right);
}

const BLINK = `import { gpio, Serial, sleep, OUTPUT } from '@bbs/runtime';

const LED = 48;

export async function setup() {
  Serial.begin(115200);
  gpio.pinMode(LED, OUTPUT);
  Serial.println('ready');
}

export async function loop() {
  gpio.digitalWrite(LED, 1);
  await sleep(500);
  gpio.digitalWrite(LED, 0);
  await sleep(500);
}
`;

/** 换掉夹具里的程序，走的是编辑器同一个 op。 */
async function setProgram(page: Page, source: string): Promise<void> {
  const r = await page.evaluate(
    (src) => (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([{ op: 'update_program', id: 'program_main', patch: { source: src } }]),
    source
  );
  expect(r.ok).toBe(true);
}

test.describe('左右面板：折叠 / 调宽 / 记忆布局（#39）', () => {
  test('默认与改动前一致：左 260 / 右 340，两侧都展开', async ({ page }) => {
    await fresh(page);
    await expectLayout(page, LEFT_DEFAULT, RIGHT_DEFAULT);
    expect(await panelWidthVar(page, 'left')).toBe(LEFT_DEFAULT);
    expect(await panelWidthVar(page, 'right')).toBe(RIGHT_DEFAULT);
    for (const side of ['left', 'right'] as const) {
      const rail = page.getByTestId(`panel-rail-${side}`);
      await expect(rail).toBeVisible();
      await expect(rail).toHaveAttribute('aria-expanded', 'true');
      expect((await rail.boundingBox())!.width, `${side} 轨道宽度`).toBe(RAIL);
    }
  });

  test('折叠左面板把宽度还给画布，展开后逐像素复原', async ({ page }) => {
    await fresh(page);
    const canvasBefore = await canvasWidth(page);
    const panelBefore = await panelWidth(page, 'left');

    await togglePanelRail(page, 'left');
    await expect(page.getByTestId('panel-rail-left')).toHaveAttribute('aria-expanded', 'false');
    expect(await panelWidthVar(page, 'left'), '折叠时宽度变量写 0').toBe(0);
    const canvasAfter = await canvasWidth(page);
    const panelAfter = await panelWidth(page, 'left');

    expect(panelAfter, '折叠后只剩常驻轨道').toBe(RAIL);
    expect(canvasAfter - canvasBefore, '画布让出的宽度').toBe(panelBefore - panelAfter);
    expect(canvasAfter - canvasBefore, '面板 260px 的足迹基本都还给了画布').toBeGreaterThan(LEFT_DEFAULT - 2 * RAIL);
    await expectLayout(page, RAIL, RIGHT_DEFAULT);

    await togglePanelRail(page, 'left');
    expect(await canvasWidth(page)).toBe(canvasBefore);
    expect(await panelWidth(page, 'left')).toBe(panelBefore);
    await expectLayout(page, LEFT_DEFAULT, RIGHT_DEFAULT);
  });

  test('拖轨道改宽度：面板与画布的变化量相等，并夹在 200–520 之间', async ({ page }) => {
    await fresh(page);
    const canvas0 = await canvasWidth(page);
    const grow = async (side: 'left' | 'right', outward: number) => {
      const canvasBefore = await canvasWidth(page);
      const panelBefore = await panelWidth(page, side);
      await dragPanelRail(page, side, outward);
      const canvasAfter = await canvasWidth(page);
      const panelAfter = await panelWidth(page, side);
      // 同一次拖动里，面板多占的像素就是画布少掉的像素（±1 是鼠标坐标取整）。
      expect(Math.abs((panelAfter - panelBefore) + (canvasAfter - canvasBefore)), `${side} 面板与画布的变化量应当抵消`).toBeLessThanOrEqual(1);
      return { panelBefore, panelAfter };
    };

    const left = await grow('left', 100);
    expect(left.panelAfter).toBeGreaterThanOrEqual(358);
    expect(left.panelAfter).toBeLessThanOrEqual(362);

    // 上限 520：往外拖多远都停在这里
    const capped = await grow('left', 400);
    expect(capped.panelAfter).toBe(520);
    expect(await canvasWidth(page)).toBe(canvas0 - (520 - LEFT_DEFAULT));

    // 下限 200
    const floored = await grow('left', -400);
    expect(floored.panelAfter).toBe(200);
    expect(await canvasWidth(page)).toBe(canvas0 + (LEFT_DEFAULT - 200));

    // 右面板同理，只是「往外」是指针向左
    const right = await grow('right', 80);
    expect(right.panelAfter).toBeGreaterThanOrEqual(418);
    expect(right.panelAfter).toBeLessThanOrEqual(422);

    // 拖过之后面板仍然是展开的：拖动不该被当成一次折叠点击
    await expect(page.getByTestId('panel-rail-left')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('panel-rail-right')).toHaveAttribute('aria-expanded', 'true');
  });

  test('折叠后仍有看得见、有名字的展开入口，点击与键盘都能展开', async ({ page }) => {
    await fresh(page);
    for (const side of ['left', 'right'] as const) {
      await togglePanelRail(page, side);
      const rail = page.getByTestId(`panel-rail-${side}`);
      await expect(rail).toBeVisible();
      await expect(rail).toHaveAttribute('aria-expanded', 'false');
      await expect(rail).toHaveAccessibleName(`展开${side === 'left' ? '左' : '右'}侧面板`);
      const box = (await rail.boundingBox())!;
      expect(box.width, '折叠后轨道仍然可见').toBe(RAIL);
      // 折叠后轨道贴在窗口的对应边上（不是 x>=0 这种恒真检查）。
      if (side === 'left') expect(box.x, '左轨道贴在左边缘').toBe(0);
      else expect(box.x + box.width, '右轨道贴在右边缘').toBe(await viewportWidth(page));

      await rail.focus();
      await page.keyboard.press('Enter');
      await expect(rail).toHaveAttribute('aria-expanded', 'true');
      await expect(rail).toHaveAccessibleName(`折叠${side === 'left' ? '左' : '右'}侧面板`);
      await togglePanelRail(page, side);
      await expect(rail).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('`[` / `]` 折叠面板，但输入框里的方括号不会被吞', async ({ page }) => {
    await fresh(page);
    const rail = (side: 'left' | 'right') => page.getByTestId(`panel-rail-${side}`);
    const before = await canvasWidth(page);

    await page.keyboard.press('[');
    await expect(rail('left')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('[');
    await expect(rail('left')).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press(']');
    await expect(rail('right')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press(']');
    await expect(rail('right')).toHaveAttribute('aria-expanded', 'true');
    expect(await canvasWidth(page)).toBe(before);

    // 元件库搜索框：`[` 是搜索词，不是快捷键
    const search = page.getByTestId('library-search');
    await search.click();
    await page.keyboard.type('[');
    await expect(search).toHaveValue('[');
    await expect(rail('left')).toHaveAttribute('aria-expanded', 'true');

    // DSL 文本域：`[` 是合法的数组语法，必须能打进去
    await page.getByTestId('tab-dsl').click();
    const dsl = page.getByTestId('dsl-text');
    await dsl.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('[');
    await expect(dsl).toHaveValue(/\[$/);
    await expect(rail('right')).toHaveAttribute('aria-expanded', 'true');
    expect(await canvasWidth(page)).toBe(before);
  });

  test('折叠时把焦点从看不见的内容里移开，按键不会被吞', async ({ page }) => {
    await fresh(page);
    const search = page.getByTestId('library-search');
    await search.click();
    await page.keyboard.type('led');
    await expect(search).toHaveValue('led');

    // 轨道在 pointerdown 里 preventDefault（为了拖拽不选中文字），所以浏览器不会把焦点
    // 转给轨道；不主动搬走，焦点就留在了马上要看不见的搜索框里。
    await togglePanelRail(page, 'left');
    const rail = page.getByTestId('panel-rail-left');
    await expect(rail).toHaveAttribute('aria-expanded', 'false');
    // 焦点被主动搬到轨道上：折叠后按 Enter 应该是「展开」，而不是落回看不见的内容。
    await page.keyboard.press('Enter');
    await expect(rail, '焦点已搬到轨道，Enter 重新展开').toHaveAttribute('aria-expanded', 'true');
    await togglePanelRail(page, 'left');
    await expect(rail).toHaveAttribute('aria-expanded', 'false');
  });

  test('布局记在本地：刷新后保留，清空 localStorage 回到默认', async ({ page }) => {
    await fresh(page);
    await dragPanelRail(page, 'left', 100);
    await dragPanelRail(page, 'right', 60);
    await togglePanelRail(page, 'right');
    const left = await panelWidth(page, 'left');

    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expectLayout(page, left, RAIL);
    await expect(page.getByTestId('panel-rail-right')).toHaveAttribute('aria-expanded', 'false');

    await fresh(page);
    await expectLayout(page, LEFT_DEFAULT, RIGHT_DEFAULT);
    await expect(page.getByTestId('panel-rail-right')).toHaveAttribute('aria-expanded', 'true');
  });

  test('拖拽与折叠不写设计数据：撤销栈、保存状态与草稿都不动', async ({ page }) => {
    await fresh(page);
    await addFromLibrary(page, 'breadboard_400');
    await addFromLibrary(page, 'oled_0_96_ssd1315_i2c');
    await clickHole(page, 'bb_1.a25');
    const before = await state(page);
    const beforeHash = (await analysis(page)).hash;
    expect(before.past, '先要做过一次真实编辑').toBeGreaterThan(0);

    await dragPanelRail(page, 'left', 80);
    await togglePanelRail(page, 'right');
    const after = await state(page);
    expect(after.past, '拖拽/折叠没进撤销栈').toBe(before.past);
    expect(after.future).toBe(before.future);
    // 设计哈希不含 revision/时间戳，所以这一条等价于「文档一个字节都没动」。
    expect((await analysis(page)).hash, '面板布局不写设计数据').toBe(beforeHash);
    expect(after.dslDirty).toBe(false);
    // 自动保存是 300ms 防抖的（store.ts 的 saveTimer），所以这里不能拿「编辑刚做完」那一刻的
    // storage 状态去比——要等它落地，顺便证明拖面板没把自动保存打断。
    await expect.poll(async () => (await state(page)).storage.state).toBe('saved');

    const width = await panelWidth(page, 'left');
    await page.getByTestId('undo').click();
    expect((await state(page)).past, '撤销的是那次放置').toBe(before.past - 1);
    expect(await panelWidth(page, 'left'), '撤销不会把面板宽度带走').toBe(width);
    await expect(page.getByTestId('panel-rail-right')).toHaveAttribute('aria-expanded', 'false');
  });

  test('折叠右侧面板不会卸载仿真面板：会话照跑', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await setProgram(page, BLINK);
    await enterSim(page);
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, { timeout: 20000 }).toBe('running');
    const running = await simulator(page);
    const canvasBefore = await canvasWidth(page);
    const panelBefore = await panelWidth(page, 'right');

    await togglePanelRail(page, 'right');
    await expect(page.getByTestId('panel-rail-right')).toHaveAttribute('aria-expanded', 'false');
    // React 卸载会把 DOM 一起带走，所以「还挂着」就是「没卸载」。
    await expect(page.getByTestId('sim-panel')).toBeAttached();
    expect(await panelWidth(page, 'right'), '折叠后面板收成那条轨道').toBe(RAIL);
    expect(await canvasWidth(page), '画布正好拿到面板让出的宽度').toBe(canvasBefore + (panelBefore - RAIL));
    await expect.poll(async () => (await simulator(page)).nowUs, { timeout: 20000 }).toBeGreaterThan(running.nowUs);
    const after = await simulator(page);
    expect(after.sessionId, '会话没被打断').toBe(running.sessionId);
    expect(after.status).toBe('running');

    await togglePanelRail(page, 'right');
    await expect(page.getByTestId('sim-panel')).toBeVisible();
  });

  test('仿真里没有左侧面板：`[` 是空操作，`]` 仍能折叠右面板', async ({ page }) => {
    await fresh(page);
    await enterSim(page);
    expect(await panelWidth(page, 'left'), '仿真下左面板不渲染也不占宽度').toBe(0);
    const canvas = await canvasWidth(page);
    const panelBefore = await panelWidth(page, 'right');
    await page.keyboard.press('[');
    expect(await canvasWidth(page), '没有左面板可折，画布不动').toBe(canvas);
    await page.keyboard.press(']');
    await expect(page.getByTestId('panel-rail-right')).toHaveAttribute('aria-expanded', 'false');
    expect(await canvasWidth(page), '画布正好拿到右面板让出的宽度').toBe(canvas + (panelBefore - RAIL));

    await enterBuild(page);
    await expect(page.getByTestId('panel-rail-left'), '`[` 没在仿真里偷偷折叠左面板').toHaveAttribute('aria-expanded', 'true');
  });

  test('模型详情浮层跟着面板宽度走，不再写死 260/340', async ({ page }) => {
    await fresh(page);
    await dragPanelRail(page, 'left', 100);
    await togglePanelRail(page, 'right');
    const left = await panelWidth(page, 'left');
    const right = await panelWidth(page, 'right');
    const viewport = await page.evaluate(() => document.documentElement.clientWidth);

    await page.getByTestId('lib-encoder_ky040').hover();
    const layer = page.getByTestId('model-detail-layer');
    await expect(layer).toBeVisible();
    const box = (await layer.boundingBox())!;
    expect(Math.round(box.x), '浮层从画布左缘开始').toBe(Math.round(left));
    expect(Math.round(box.width), '浮层止于画布右缘').toBe(Math.round(viewport - left - right));
  });
});