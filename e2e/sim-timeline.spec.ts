import { test, expect } from '@playwright/test';
import { enterSim, fit, fresh, loadExample, simulator } from './helpers';

/**
 * 阶段 4: the timeline shows what a net *did*, which the net monitor cannot.
 * The fixture drives TOUCH_IO, so pressing the pad has to leave visible edges.
 */
const FIRST_RUN = { timeout: 25000 };

const WATCH_TOUCH = `import { gpio, Serial, sleep, INPUT } from '@bbs/runtime';

export async function setup() {
  Serial.begin(115200);
  gpio.pinMode(4, INPUT);
  Serial.println('ready');
}

export async function loop() {
  await sleep(10);
}
`;

test.describe('阶段 4 · 网络时间线', () => {
  test('a press on the pad leaves a visible edge on the timeline', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await page.evaluate(
      (src) =>
        (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
          { op: 'update_program', id: 'program_main', patch: { source: src } }
        ]),
      WATCH_TOUCH
    );

    await enterSim(page);
    // nothing has run: the panel says so rather than drawing an empty grid
    await expect(page.getByTestId('sim-timeline-empty')).toBeVisible();

    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect.poll(async () => (await simulator(page)).serial.length, FIRST_RUN).toBeGreaterThan(0);

    // the touch net settles low at start-up, which is itself an edge
    await expect.poll(async () => (await simulator(page)).trace.length, FIRST_RUN).toBeGreaterThan(0);
    await expect(page.getByTestId('sim-timeline')).toBeVisible();

    const touchNet = (await simulator(page)).nets.find((n) => n.drivers.some((d) => d.componentId === 'touch' && d.pin === 'IO'))!.netId;
    const edgesOn = async () => (await simulator(page)).trace.filter((t) => t.netId === touchNet);
    const before = (await edgesOn()).length;

    // press: the net goes high, and that edge must appear
    expect(
      await page.evaluate(() => (window as unknown as { __bbs: { simulatorControl: (a: string, b: string, c: boolean) => boolean } }).__bbs.simulatorControl('touch', 'touch', true))
    ).toBe(true);
    await expect.poll(async () => (await edgesOn()).length, FIRST_RUN).toBeGreaterThan(before);
    expect((await edgesOn()).at(-1)!.value, 'the last thing that happened was a rise').toBe(1);

    // and the strip for that net is actually drawn, with more than one segment
    const strip = page.getByTestId(`sim-strip-${touchNet}`);
    await expect(strip).toBeVisible();
    await expect.poll(async () => Number(await strip.getAttribute('data-segments')), FIRST_RUN).toBeGreaterThan(1);

    // release brings it back down
    await page.evaluate(() => (window as unknown as { __bbs: { simulatorControl: (a: string, b: string, c: boolean) => boolean } }).__bbs.simulatorControl('touch', 'touch', false));
    await expect.poll(async () => (await edgesOn()).at(-1)?.value, FIRST_RUN).toBe(0);

    expect((await simulator(page)).traceDropped, 'nothing was dropped at this rate').toBe(0);
    expect((await simulator(page)).status).toBe('running');
  });

  test('arming a strip stops the run on that net\'s next edge', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await page.evaluate(
      (src) =>
        (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
          { op: 'update_program', id: 'program_main', patch: { source: src } }
        ]),
      WATCH_TOUCH
    );
    await enterSim(page);
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect.poll(async () => (await simulator(page)).trace.length, FIRST_RUN).toBeGreaterThan(0);

    const touchNet = (await simulator(page)).nets.find((n) => n.drivers.some((d) => d.componentId === 'touch' && d.pin === 'IO'))!.netId;
    // the strip's name is the breakpoint control
    await page.getByTestId(`sim-break-${touchNet}`).click();
    await expect(page.getByTestId(`sim-break-${touchNet}`)).toHaveAttribute('aria-pressed', 'true');
    expect((await simulator(page)).status, 'arming alone changes nothing').toBe('running');

    await page.evaluate(() => (window as unknown as { __bbs: { simulatorControl: (a: string, b: string, c: boolean) => boolean } }).__bbs.simulatorControl('touch', 'touch', true));
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('paused');
    await expect(page.getByTestId('sim-status')).toHaveText('暂停');

    const hit = (await simulator(page)).diagnostics.filter((d) => d.code === 'breakpoint_hit');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.netIds).toEqual([touchNet]);

    // disarm and it runs on
    await page.getByTestId(`sim-break-${touchNet}`).click();
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await page.evaluate(() => (window as unknown as { __bbs: { simulatorControl: (a: string, b: string, c: boolean) => boolean } }).__bbs.simulatorControl('touch', 'touch', false));
    await page.waitForTimeout(400);
    expect((await simulator(page)).status, 'a disarmed net does not stop it').toBe('running');
  });
});
