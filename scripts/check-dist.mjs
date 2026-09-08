// Serves apps/web/dist under /breadboard-studio/ (like GitHub Pages) and smoke-tests it headlessly.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from '@playwright/test';

const dist = join(import.meta.dirname, '..', 'apps', 'web', 'dist');
const base = '/breadboard-studio/';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
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

// Does this build ship the simulation runtime yet (the QuickJS wasm from M-S1)?
// The runtime-dependent checks below are skipped with a note until it does, so
// `check:dist` never turns permanently red. BBS_CHECK_SIM=1 makes them mandatory
// (turn this on in CI once the Worker backend lands), BBS_CHECK_SIM=0 skips them.
const simFlag = process.env.BBS_CHECK_SIM;
const checkSim = simFlag === '1' || (simFlag !== '0' && readdirSync(join(dist, 'assets')).some((f) => f.endsWith('.wasm')));

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
// Subpath + production build + Worker + wasm is covered nowhere else (plan §11.5): the e2e
// suite runs vite dev at base `/` and never starts a session, so the wasm is never fetched.
// `touch_display` is the only example that carries a program asset.
let simNowUs = null;
if (checkSim) {
  await page.getByTestId('menu-project').click();
  await page.getByTestId('example-touch_display').click();
  // The transport only exists in 仿真, so the mode switch is part of the path to a run.
  await page.getByTestId('mode-sim').click();
  await page.getByTestId('sim-run').click();
  await page.waitForFunction(() => (window.__bbs.simulator().nowUs ?? 0) > 0, null, { timeout: 20000 }).catch(() => {});
  simNowUs = await page.evaluate(() => window.__bbs.simulator().nowUs ?? null);
  const sim = await page.evaluate(() => window.__bbs.simulator());
  if (!(simNowUs > 0)) errors.push(`simulator did not advance under ${base}: nowUs=${simNowUs}, status=${sim.status}, diagnostics=${sim.diagnostics.map((x) => x.code).join(',')}`);
}
console.log(JSON.stringify({ url: `http://localhost:4174${base}`, boards: d.boards.length, wires: d.wires.length, nets: a.nets.length, summary: a.summary, checkSim, simNowUs, errors }));
await browser.close();

// Bundle budget (plan §11.5). 900,000 B leaves ~28% headroom over today's 703,674 B entry
// chunk; the banned strings and the single-wasm rule are what keep the QuickJS runtime lazy
// (importing the `quickjs-emscripten` root package would ship 4 wasm files, 4,258 kB).
const entry = readFileSync(join(dist, 'index.html'), 'utf8').match(/<script type="module"[^>]*src="[^"]*\/assets\/([^"]+)"/)?.[1];
if (!entry) {
  errors.push('no module entry chunk found in index.html');
} else {
  const entryText = readFileSync(join(dist, 'assets', entry), 'utf8');
  const entrySize = statSync(join(dist, 'assets', entry)).size;
  const wasm = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.wasm'));
  // `__bbs/definition` is the dev-only catalog write-back: the deployed site has no
  // filesystem behind it and must not offer a button that cannot work.
  const banned = ['quickjs', 'sucrase', 'emscripten', '__bbs/definition'].filter((k) => entryText.includes(k));
  if (entrySize > 900_000) errors.push(`entry chunk ${entrySize} B > 900000 B`);
  if (banned.length) errors.push(`entry chunk mentions ${banned.join(', ')}`);
  if (checkSim && wasm.length !== 1) errors.push(`${wasm.length} .wasm assets, expected exactly 1`);
  console.log(JSON.stringify({ entry, entrySize, wasm, banned, checkSim, errors }));
}
server.close();
if (errors.length || d.wires.length !== 24) process.exit(1);
