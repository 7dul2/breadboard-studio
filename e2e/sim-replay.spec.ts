import { test, expect } from '@playwright/test';
import { enterSim, fit, fresh, loadExample, simulator } from './helpers';

/**
 * 阶段 4: what you did is recorded with the instant it took effect, and replaying it
 * reproduces the run. The recording is the thing that makes the simulator's
 * determinism usable by a person.
 */
const FIRST_RUN = { timeout: 25000 };

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
  await sleep(5);
}
`;

async function serialText(page: import('@playwright/test').Page): Promise<string> {
  return (await simulator(page)).serial.map((l) => l.text).join('\n');
}

async function touch(page: import('@playwright/test').Page, value: boolean): Promise<void> {
  await page.evaluate(
    (v) => (window as unknown as { __bbs: { simulatorControl: (a: string, b: string, c: boolean) => boolean } }).__bbs.simulatorControl('touch', 'touch', v),
    value
  );
}

test.describe('阶段 4 · 录制与回放', () => {
  test('a press is recorded with its instant, and replaying reproduces the run', async ({ page }) => {
    await fresh(page);
    await loadExample(page, 'touch_display');
    await fit(page);
    await page.evaluate(
      (src) =>
        (window as unknown as { __bbs: { apply: (ops: unknown[]) => { ok: boolean } } }).__bbs.apply([{ op: 'update_program', id: 'program_main', patch: { source: src } }]),
      WATCH_TOUCH
    );

    await enterSim(page);
    await expect(page.getByTestId('sim-recording-count')).toHaveText('0');
    await expect(page.getByTestId('sim-replay')).toBeDisabled();

    await page.getByTestId('sim-run').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('ready');
    // let the clock move so the press lands at a non-zero instant
    const start = (await simulator(page)).nowUs;
    await expect.poll(async () => (await simulator(page)).nowUs, FIRST_RUN).toBeGreaterThan(start + 100_000);

    await touch(page, true);
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('touch=1');
    await touch(page, false);
    await expect.poll(async () => (await simulator(page)).recording.length, FIRST_RUN).toBe(2);

    const recorded = (await simulator(page)).recording;
    expect(recorded.map((r) => r.value)).toEqual([true, false]);
    expect(recorded[0]!.atUs, 'stamped by the worker, where the clock is authoritative').toBeGreaterThan(0);
    expect(recorded[1]!.atUs).toBeGreaterThan(recorded[0]!.atUs);
    await expect(page.getByTestId('sim-recording-count')).toHaveText('2');

    // replay: a fresh run that is fed the same events at the same instants
    const before = (await serialText(page)).split('touch=1').length - 1;
    expect(before).toBeGreaterThan(0);
    await page.getByTestId('sim-replay').click();
    await expect.poll(async () => (await simulator(page)).status, FIRST_RUN).toBe('running');
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('ready');

    // the replayed run reaches the same point on its own, with nobody touching anything
    await expect.poll(async () => serialText(page), FIRST_RUN).toContain('touch=1');
    await expect.poll(async () => (await simulator(page)).recording.length, FIRST_RUN).toBe(2);
    const replayed = (await simulator(page)).recording;
    expect(replayed.map((r) => ({ atUs: r.atUs, value: r.value })), 'same events, same instants').toEqual(
      recorded.map((r) => ({ atUs: r.atUs, value: r.value }))
    );
    expect((await simulator(page)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
