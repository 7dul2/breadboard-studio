// Serves apps/web/dist under /breadboard-studio/ (like GitHub Pages) and smoke-tests it headlessly.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from '@playwright/test';

const dist = join(import.meta.dirname, '..', 'apps', 'web', 'dist');
const base = '/breadboard-studio/';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  let path = req.url.split('?')[0];
  if (!path.startsWith(base)) { res.writeHead(404); res.end('not under base'); return; }
  path = path.slice(base.length) || 'index.html';
  let file = join(dist, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(4174, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:4174${base}`);
await page.getByTestId('menu-project').click();
await page.getByTestId('example-environment_node').click();
await page.getByTestId('fit').click();
const a = await page.evaluate(() => window.__bbs.getAnalysis());
const d = await page.evaluate(() => window.__bbs.getDesign());
console.log(JSON.stringify({ url: `http://localhost:4174${base}`, boards: d.boards.length, wires: d.wires.length, nets: a.nets.length, summary: a.summary, errors }));
await browser.close();
server.close();
if (errors.length || d.wires.length !== 24) process.exit(1);
