// Ad-hoc visual check: open the dev server, run actions, screenshot.
import { chromium } from '@playwright/test';
const [out, scenario = 'example'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto('http://localhost:4173/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.getByTestId('menu-project').click();
await page.getByTestId('example-environment_node').click();
await page.getByTestId('fit').click();
if (scenario === 'hole') {
  await page.locator('[data-hole="bb_a.a5"]').first().click({ force: true });
  await page.getByTestId('fit').click();
  // zoom in around board A
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
}
if (scenario === 'drag') {
  const from = await page.locator('[data-component="mcu"].component-hit').first().boundingBox();
  await page.mouse.move(from.x + 10, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 200, from.y + 60, { steps: 8 });
}
if (scenario === 'wire') {
  await page.getByTestId('tool-wire').click();
  await page.locator('[data-hole="bb_a.a9"]').first().click({ force: true });
  const t = await page.locator('[data-hole="bb_b.e10"]').first().boundingBox();
  await page.mouse.move(t.x, t.y);
}
if (scenario === 'validation') {
  await page.evaluate(() => window.__bbs.apply([{ op: 'add_wire', wire: { id: 'w_bad', from: { hole: 'bb_a.bottom_inner_20' }, to: { hole: 'bb_a.bottom_outer_20' }, color: 'red' } }]));
  await page.getByTestId('result-power_ground_short').first().click();
}
if (scenario === 'component') {
  await page.locator('[data-component="mcu"].component-hit').first().click({ force: true });
}
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
