// Browser-side performance check on the stress example: drag a module for ~2 s and report frame timings.
//   node scripts/perf-browser.mjs   (needs the dev server on :4173, e.g. `pnpm exec playwright test` webServer or `pnpm dev`)
import { chromium } from '@playwright/test';
const base = process.env.BASE_URL ?? 'http://localhost:4173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.getByTestId('menu-project').click();
await page.getByTestId('example-stress_test').click();
await page.getByTestId('fit').click();
await page.waitForTimeout(300);
const tLoad = await page.evaluate(() => {
  const t = performance.now();
  window.__bbs.getAnalysis();
  return performance.now() - t;
});
await page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    window.__frames.push(now - last);
    last = now;
    if (window.__frames.length < 100000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const from = await page.locator('[data-component="mcu_0"].component-hit').first().boundingBox();
await page.mouse.move(from.x + 8, from.y + 8);
await page.mouse.down();
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < 2000) {
  await page.mouse.move(from.x + 8 + (i % 40) * 6, from.y + 8 + Math.floor(i / 40) * 12, { steps: 1 });
  i++;
}
await page.mouse.up();
const frames = await page.evaluate(() => window.__frames.slice(5));
frames.sort((a, b) => a - b);
const p = (q) => frames[Math.floor(frames.length * q)];
const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
const d = await page.evaluate(() => window.__bbs.getDesign());
console.log(JSON.stringify({
  ua: await page.evaluate(() => navigator.userAgent),
  design: { boards: d.boards.length, components: d.components.length, wires: d.wires.length },
  analysis_ms_in_browser: Math.round(tLoad * 100) / 100,
  drag: { pointer_moves: i, frames: frames.length, frame_ms_avg: Math.round(avg * 10) / 10, frame_ms_p50: Math.round(p(0.5) * 10) / 10, frame_ms_p95: Math.round(p(0.95) * 10) / 10, frame_ms_max: Math.round(frames[frames.length - 1] * 10) / 10 }
}, null, 2));
await browser.close();
