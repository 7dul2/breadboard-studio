import { expect, test } from '@playwright/test';
import { addFromLibrary, analysis, clickHole, design, fit, fresh } from './helpers';

/**
 * The tactile switch is the first part whose conduction depends on an instance
 * param (`params.closed`), and only half of that is unit-testable. The engine
 * tests prove that a closed contact joins two nodes; they cannot prove that a
 * user has any way to close it. So this walks the real path: place the part,
 * tick the checkbox, and watch two separate nets become one.
 */
test('勾选「已按下」后，开关两端所在的两个网络真的并成一个', async ({ page }) => {
  await fresh(page);
  await addFromLibrary(page, 'breadboard_400');
  await addFromLibrary(page, 'tactile_6x6');
  await clickHole(page, 'bb_1.e10');
  await fit(page);

  // Two independent nets, each one wire away from one of the switch's pins. The
  // pins are one pitch apart (A=e10, B=e11), so the wires must touch column 10
  // and column 11 without bridging them: 9–10 on one side, 11–12 on the other.
  await page.getByTestId('tool-wire').click();
  await clickHole(page, 'bb_1.a9');
  await clickHole(page, 'bb_1.a10');
  await clickHole(page, 'bb_1.a11');
  await clickHole(page, 'bb_1.a12');
  await page.getByTestId('tool-select').click();

  const joined = async () =>
    (await analysis(page)).nets.some((net) => net.pins.includes('tactile_6x6_1.A') && net.pins.includes('tactile_6x6_1.B'));
  // An open contact carries no current, so the two nets stay apart.
  expect(await joined()).toBe(false);

  await page.locator('[data-component="tactile_6x6_1"]').first().click({ force: true });
  const closed = page.getByTestId('prop-已按下（A-B 导通）');
  await expect(closed).toBeVisible();
  await expect(closed).not.toBeChecked();
  await closed.check();

  // The state is an instance param, and a closed contact is a wire.
  const placed = (await design(page)).components[0] as unknown as { params?: Record<string, unknown> };
  expect(placed.params).toMatchObject({ closed: true });
  expect(await joined()).toBe(true);
});
