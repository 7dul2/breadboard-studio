import { test, expect, type Page } from '@playwright/test';
import { design, fresh, loadExample, simulator } from './helpers';

/**
 * M-S1 acceptance (plan §11.1). Every timing assertion polls virtual time
 * through `__bbs.simulator()`; none of them sleeps for a fixed period, so the
 * suite does not depend on how fast the machine runs the sandbox.
 *
 * The first run of each test pulls the worker chunk and the 503 kB wasm on
 * demand under `vite dev`, so it gets a longer poll budget than the rest.
 */
const FIRST_RUN = { timeout: 20000 };

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

/** Replace the fixture's program through the same op the editor uses. */
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

async function ledValues(page: Page): Promise<string[]> {
  const sim = await simulator(page);
  return (sim.visuals.mcu ?? []).filter((v) => v.kind === 'led').map((v) => (v as { rgb: number[] }).rgb.join(','));
}

test.describe('M-S1 · the program actually runs', () => {
  test('① drives the on-board RGB from user code, and ② pause freezes / reset zeroes virtual time', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await setProgram(page, BLINK);
    await page.getByTestId('tab-simulation').click();

    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');

    // setup() reached the console, so the guest really executed
    await expect.poll(async () => (await simulator(page)).serial.map((l) => l.text).join('\n'), FIRST_RUN).toContain('ready');

    // virtual time advances monotonically
    const first = (await simulator(page)).nowUs;
    await expect.poll(async () => (await simulator(page)).nowUs, FIRST_RUN).toBeGreaterThan(first);

    // ① the LED alternates between the two values the program writes
    const seen = new Set<string>();
    await expect
      .poll(async () => {
        for (const v of await ledValues(page)) seen.add(v);
        return seen.size;
      }, FIRST_RUN)
      .toBeGreaterThanOrEqual(2);
    expect([...seen].sort()).toEqual(['0,0,0', '255,255,255']);

    // ② pause freezes virtual time. The store mirrors `nowUs` one animation frame
    // behind (plan §9.4), and pause only lands between slices, so wait for the
    // value to settle before asserting that it stays put.
    await page.getByTestId('sim-pause').click();
    await expect(page.getByTestId('sim-status')).toHaveText('暂停');
    let previous = -1;
    await expect
      .poll(async () => {
        const current = (await simulator(page)).nowUs;
        const settled = current === previous;
        previous = current;
        return settled;
      }, FIRST_RUN)
      .toBe(true);
    const paused = (await simulator(page)).nowUs;
    const frozenLed = await ledValues(page);
    await page.waitForTimeout(600);
    expect((await simulator(page)).nowUs).toBe(paused);
    expect(await ledValues(page)).toEqual(frozenLed);

    // ② reset returns virtual time to zero and the program starts over
    await page.getByTestId('sim-reset').click();
    await expect.poll(async () => (await simulator(page)).nowUs, FIRST_RUN).toBeLessThan(paused);
    await expect.poll(async () => (await simulator(page)).serial.map((l) => l.text).join('\n'), FIRST_RUN).toContain('ready');
  });

  test('③ an infinite loop is cut off with a located diagnostic and the page stays responsive', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await setProgram(page, 'export async function loop() {\n  while (true) {}\n}\n');
    await page.getByTestId('tab-simulation').click();
    await page.getByTestId('sim-run').click();

    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('faulted');
    const budget = (await simulator(page)).diagnostics.find((d) => d.code === 'execution_budget_exceeded');
    expect(budget, 'execution_budget_exceeded was raised').toBeDefined();
    expect(budget!.severity).toBe('error');
    // the diagnostic points back into the user's own program
    expect(budget!.source?.programId).toBe('program_main');
    expect(budget!.source?.line).toBeGreaterThan(0);

    // the main thread never blocked: the UI still reacts
    await page.getByTestId('tab-properties').click();
    await expect(page.getByTestId('tab-properties')).toHaveClass(/active/);
    await page.getByTestId('tab-simulation').click();
    await expect(page.getByTestId('sim-panel')).toBeVisible();
  });

  test('④ a program that can never wake up is reported as a deadlock, not as a budget overrun', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await setProgram(page, 'export async function loop() {\n  await new Promise(() => {});\n}\n');
    await page.getByTestId('tab-simulation').click();
    await page.getByTestId('sim-run').click();

    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('faulted');
    const codes = (await simulator(page)).diagnostics.map((d) => d.code);
    expect(codes).toContain('simulation_deadlock');
    expect(codes).not.toContain('execution_budget_exceeded');
  });

  test('⑥ 10× advances virtual time faster than 1× for the same wall clock', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    // sleep(1) keeps the queue busy so the pacer, not the guest, sets the rate
    await setProgram(page, "import { sleep } from '@bbs/runtime';\nexport async function loop() {\n  await sleep(1);\n}\n");
    await page.getByTestId('tab-simulation').click();

    const advanceOver = async (ms: number): Promise<number> => {
      const from = (await simulator(page)).nowUs;
      await page.waitForTimeout(ms);
      return (await simulator(page)).nowUs - from;
    };

    await page.getByTestId('sim-speed').selectOption('1');
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect.poll(async () => (await simulator(page)).nowUs, FIRST_RUN).toBeGreaterThan(0);
    const atOnce = await advanceOver(1500);

    await page.getByTestId('sim-speed').selectOption('10');
    await expect.poll(async () => (await simulator(page)).speed).toBe(10);
    const atTen = await advanceOver(1500);

    // Assert a ratio band, never an exact multiple: setTimeout granularity and
    // background-tab throttling both move the real numbers around.
    expect(atOnce).toBeGreaterThan(0);
    expect(atTen).toBeGreaterThan(atOnce * 3);
  });

  test('⑦ an electrical blocker refuses the run until 强制启动 is ticked', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    // short the 3V3 rail to ground: an `error` result that is deliberately non-blocking,
    // so only the simulator's own pre-flight can catch it
    const shorted = await page.evaluate(() =>
      (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([
        { op: 'add_wire', wire: { id: 'w_short', from: { hole: 'bb.top_inner_1' }, to: { hole: 'bb.top_outer_1' }, color: 'red' } }
      ])
    );
    expect(shorted.ok).toBe(true);
    const codes = (await page.evaluate(() => (window as unknown as { __bbs: { getAnalysis: () => { results: { code: string }[] } } }).__bbs.getAnalysis())).results.map((r) => r.code);
    expect(codes, 'the fixture really is shorted now').toContain('power_ground_short');

    await page.getByTestId('tab-simulation').click();
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('idle');
    const blocked = (await simulator(page)).diagnostics.find((d) => d.code === 'simulation_blocked_by_design');
    expect(blocked, 'the run was refused before a backend was built').toBeDefined();
    expect(blocked!.message).toContain('power_ground_short');
    expect((await simulator(page)).sessionId).toBeNull();

    // the escape hatch is debug-only and lives in localStorage, never in the design
    await expect(page.getByTestId('sim-blockers')).toBeVisible();
    await page.getByTestId('sim-force-start').check();
    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect(page.getByTestId('sim-force-banner')).toBeVisible();
    expect((await simulator(page)).diagnostics.map((d) => d.code)).toContain('simulation_forced_start');
    expect(JSON.stringify(await design(page))).not.toContain('force');
  });
});
