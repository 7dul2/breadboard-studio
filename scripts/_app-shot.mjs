// Ad-hoc visual check: open the dev server, run actions, screenshot.
import { chromium } from '@playwright/test';
const [out, example = 'environment_node'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto('http://localhost:5173/');
await page.getByTestId('menu-project').click();
await page.getByTestId(`example-${example}`).click();
await page.waitForTimeout(500);
await page.screenshot({ path: out });
const state = await page.evaluate(() => window.__bbs.state());
console.log(JSON.stringify(state));
await browser.close();
