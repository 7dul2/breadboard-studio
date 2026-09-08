import { test, expect, type Page } from '@playwright/test';
import { analysis, design, fit, fresh, loadExample, simulator, state } from './helpers';

/**
 * M-S2 acceptance (plan §11.2): input has to reach the program through the real
 * net, and the canvas overlay must not disturb editing when nothing is running.
 */
const FIRST_RUN = { timeout: 20000 };

/** Prints every edge on the touch pin, so the serial log is the proof the guest saw it. */
const WATCH_TOUCH = `import { gpio, Serial, sleep, INPUT } from '@bbs/runtime';

const TOUCH = 4;
let last = -1;

export async function setup() {
  Serial.begin(115200);
  gpio.pinMode(TOUCH, INPUT);
  Serial.println('ready');
}

export async function loop() {
  const v = gpio.digitalRead(TOUCH);
  if (v !== last) {
    last = v;
    Serial.println('touch=' + v);
  }
  await sleep(10);
}
`;

async function setProgram(page: Page, source: string): Promise<void> {
  const r = await page.evaluate(
    (src) =>
      (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
        { op: 'update_program', id: 'program_main', patch: { source: src } }
      ]),
    source
  );
  expect(r.ok).toBe(true);
}

async function serialText(page: Page): Promise<string> {
  return (await simulator(page)).serial.map((l) => l.text).join('\n');
}

/** Resolved value of the net the TTP223 output shares with the MCU. */
async function touchNetValue(page: Page): Promise<string | undefined> {
  const sim = await simulator(page);
  return sim.nets.find((n) => n.drivers.some((d) => d.componentId === 'touch' && d.pin === 'IO'))?.value;
}

async function runFixture(page: Page, source: string): Promise<void> {
  await setProgram(page, source);
  await page.getByTestId('tab-simulation').click();
  await page.getByTestId('sim-run').click();
  await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
  await expect.poll(async () => serialText(page), FIRST_RUN).toContain('ready');
}

test.describe('M-S2 · physical input reaches the program through the net', () => {
  test('① a real press on the TTP223 pad drives TOUCH_IO high and the program reads it', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await runFixture(page, WATCH_TOUCH);

    // the net starts low, and the program has already said so
    await expect.poll(async () => touchNetValue(page), FIRST_RUN).toBe(0);
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('touch=0');

    const pad = page.getByTestId('sim-control-touch:touch');
    await expect(pad).toBeVisible();
    const box = (await pad.boundingBox())!;
    expect(box, 'the pad has a hit area on screen').toBeTruthy();
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const selectionBefore = (await state(page)).selectedIds;
    const revisionBefore = (await design(page)).metadata.revision;

    // hold: the net goes high and the guest prints the edge
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await expect.poll(async () => touchNetValue(page), FIRST_RUN).toBe(1);
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('touch=1');

    // release outside the pad still lands, because the pad captured the pointer
    await page.mouse.move(centre.x + 400, centre.y + 300);
    await page.mouse.up();
    await expect.poll(async () => touchNetValue(page), FIRST_RUN).toBe(0);
    await expect.poll(async () => (await serialText(page)).split('touch=0').length, FIRST_RUN).toBeGreaterThan(2);

    // operating a control is not an edit: neither the selection nor the document moved
    expect((await state(page)).selectedIds).toEqual(selectionBefore);
    expect((await design(page)).metadata.revision).toBe(revisionBefore);
  });

  test('② cutting the wire leaves the pin floating: the program stops hearing the pad, the session keeps running', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await runFixture(page, WATCH_TOUCH);

    // the wire cannot be removed while the session runs (plan §9.8), so stop first
    const cut = () =>
      page.evaluate(() => (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([{ op: 'remove_wire', id: 'w11' }]));
    expect((await cut()).ok).toBe(false);
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    expect((await cut()).ok).toBe(true);
    expect((await analysis(page)).summary.blocking).toBe(0);

    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('ready');

    // the MCU pin is now on its own: reading it is a floating read, and the
    // session survives it because floating_input is a warning
    await expect
      .poll(async () => (await simulator(page)).diagnostics.map((d) => d.code), FIRST_RUN)
      .toContain('floating_input');
    expect((await simulator(page)).status).toBe('running');

    // pressing the pad now changes nothing the program can see. Assert the
    // property itself — a rising edge never reaches the guest — rather than
    // "the log is byte-identical", which races the store's one-frame lag.
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('touch=0');
    expect(await page.evaluate(() => (window as unknown as { __bbs: { simulatorControl: (c: string, i: string, v: boolean) => boolean } }).__bbs.simulatorControl('touch', 'touch', true))).toBe(true);
    await page.waitForTimeout(500);
    expect(await serialText(page)).not.toContain('touch=1');
    expect((await simulator(page)).status).toBe('running');
  });

  test('③ pressing RST runs setup() again without resetting the rest of the board', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await runFixture(page, WATCH_TOUCH);
    const readyCount = (text: string) => text.split('ready').length - 1;
    await expect.poll(async () => readyCount(await serialText(page)), FIRST_RUN).toBe(1);

    const rst = page.getByTestId('sim-control-mcu:rst');
    await expect(rst).toBeVisible();
    const box = (await rst.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    await expect.poll(async () => readyCount(await serialText(page)), FIRST_RUN).toBe(2);
    expect((await simulator(page)).status).toBe('running');
  });

  test('④ with nothing running the overlay is gone and the canvas edits normally', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);

    // idle: no hit areas at all
    await expect(page.getByTestId('sim-control-touch:touch')).toHaveCount(0);
    await expect(page.locator('.sim-control')).toHaveCount(0);

    // start a session to learn where the pad sits, then stop again
    await runFixture(page, WATCH_TOUCH);
    const box = (await page.getByTestId('sim-control-touch:touch').boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).toHaveText('停止');
    await expect(page.locator('.sim-control')).toHaveCount(0);

    // the same point now belongs to the board again, not to an overlay
    const owner = await page.evaluate(
      (p) => {
        const el = document.elementFromPoint(p.x, p.y);
        return { cls: el?.getAttribute('class') ?? '', testid: el?.getAttribute('data-testid') ?? '' };
      },
      centre
    );
    expect(owner.cls).not.toContain('sim-control');
    expect(owner.testid).not.toContain('sim-control');

    // and editing still works: the module selects, and dragging it moves it
    await page.locator('[data-component="touch"].component-body').first().click({ force: true });
    expect((await state(page)).selectedIds).toEqual(['touch']);

    const anchorBefore = (await design(page)).components.find((c) => c.id === 'touch')!.placement.anchor_hole;
    const body = (await page.locator('[data-component="touch"].component-body').first().boundingBox())!;
    const from = (await page.locator('[data-hole="bb.e10"]').first().boundingBox())!;
    const to = (await page.locator('[data-hole="bb.e20"]').first().boundingBox())!;
    await page.mouse.move(body.x + 3, body.y + body.height / 2);
    await page.mouse.down();
    await page.mouse.move(body.x + 3 + (to.x - from.x) / 2, body.y + body.height / 2 + (to.y - from.y) / 2, { steps: 5 });
    await page.mouse.move(body.x + 3 + (to.x - from.x), body.y + body.height / 2 + (to.y - from.y), { steps: 5 });
    await page.mouse.up();
    expect((await design(page)).components.find((c) => c.id === 'touch')!.placement.anchor_hole).not.toBe(anchorBefore);
  });

  test('⑤ a deeply recursive program is reported without killing the worker', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await setProgram(page, 'function deep(n) { return n <= 0 ? 0 : deep(n - 1) + 1; }\nexport async function loop() {\n  deep(1000000);\n}\n');
    await page.getByTestId('tab-simulation').click();
    await page.getByTestId('sim-run').click();

    // it must end in a reported fault, not in a silent hang
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('faulted');
    const codes = (await simulator(page)).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
    expect(codes.length, 'the failure was reported').toBeGreaterThan(0);

    // the page is still alive and a fresh session can be started
    await page.getByTestId('tab-properties').click();
    await expect(page.getByTestId('tab-properties')).toHaveClass(/active/);
    await page.getByTestId('tab-simulation').click();
    await setProgram(page, WATCH_TOUCH);
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('ready');
  });
});
