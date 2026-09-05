import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const [svgPath, png, w = '1600', h = '1100'] = process.argv.slice(2);
const svg = readFileSync(svgPath, 'utf8').replace(/^<\?xml[^>]*>\s*/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
await page.setContent(`<html><body style="margin:0;background:#fff">${svg.replace(/width="\d+"/, `width="${w}"`).replace(/height="\d+"/, '')}</body></html>`);
await page.screenshot({ path: png, timeout: 60000 });
await browser.close();
