// Serves apps/web/dist under /breadboard-studio/ (like GitHub Pages) and smoke-tests it headlessly.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from '@playwright/test';

const dist = join(import.meta.dirname, '..', 'apps', 'web', 'dist');
const base = '/breadboard-studio/';

// The subpath is injected by CI (pages.yml sets VITE_BASE); a bare `pnpm build`
// produces a base-/ bundle whose /assets/… requests 404 under this server. Say
// so immediately instead of letting the first click time out 30 s later (seen
// on 2026-09-11, issue #9).
const html = readFileSync(join(dist, 'index.html'), 'utf8');
if (/<script[^>]+src="\/assets\//.test(html) || /<link[^>]+href="\/assets\//.test(html)) {
  console.error('check:dist：dist/index.html 以 /assets/… 引用资源，这是 base 为 / 的构建。');
  console.error('本脚本按 GitHub Pages 的 /breadboard-studio/ 子路径提供服务；本地复现发布构建请先执行：');
  console.error('  VITE_BASE=/breadboard-studio/ pnpm build');
  process.exit(1);
}

// Crawler-visible output. The editor is client-rendered, so `dist/index.html` is the
// *only* thing a non-JS crawler ever sees — GPTBot, ClaudeBot, PerplexityBot and Baidu
// all skip JS. If the intro inside #root or the docs pages go missing, the site is a
// blank div to them again, and nothing else in CI would notice. Checked against the
// real build rather than the source file.
const SITE = 'https://7dul2.github.io/breadboard-studio/';
const staticErrors = [];
const textLength = (markup) =>
  markup
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;

for (const needle of ['bbs-intro', '面包板', '洞洞板', 'rel="canonical"', 'property="og:image"', 'application/ld+json']) {
  if (!html.includes(needle)) staticErrors.push(`dist/index.html 缺少 ${needle}`);
}
const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
if (!ld) staticErrors.push('dist/index.html 找不到 JSON-LD');
else {
  try {
    JSON.parse(ld);
  } catch (e) {
    staticErrors.push(`dist/index.html 的 JSON-LD 不是合法 JSON：${e.message}`);
  }
}
if (textLength(html) < 200) staticErrors.push(`dist/index.html 可读正文过短（${textLength(html)} 字符），爬虫会读到一个空页面`);

for (const file of ['social-card.png', 'robots.txt', 'llms.txt', 'sitemap.xml', 'docs.css']) {
  if (!existsSync(join(dist, file))) staticErrors.push(`缺少 dist/${file}`);
}

// The sitemap is the contract: every URL it advertises must be a real page with prose.
const locs = [...readFileSync(join(dist, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (locs.length < 2) staticErrors.push(`sitemap.xml 只有 ${locs.length} 个 <loc>`);
for (const loc of locs) {
  if (!loc.startsWith(SITE)) {
    staticErrors.push(`sitemap.xml 的 ${loc} 不在站点前缀 ${SITE} 下`);
    continue;
  }
  const rel = loc.slice(SITE.length);
  const file = join(dist, rel, 'index.html');
  if (!existsSync(file)) {
    staticErrors.push(`sitemap.xml 列出了 ${loc}，但 dist/${rel}index.html 不存在`);
    continue;
  }
  const markup = readFileSync(file, 'utf8');
  if (!/<h1[ >]/.test(markup)) staticErrors.push(`${rel}index.html 没有 <h1>`);
  if (!/rel="canonical"/.test(markup)) staticErrors.push(`${rel}index.html 没有 canonical`);
  // Pages are prose first; a stub that lost its body should fail loudly.
  if (textLength(markup) < (rel === '' ? 200 : 400)) {
    staticErrors.push(`${rel}index.html 正文过短（${textLength(markup)} 字符）`);
  }
}
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
// React's createRoot clears #root on mount, which is what makes the crawler-only intro
// safe to ship. If that ever stops happening the intro stays on screen behind the
// editor, so assert it is gone rather than trusting react-dom's internals.
if (await page.locator('.bbs-intro').count()) {
  errors.push('挂载后 #root 里仍有 .bbs-intro：爬虫用的介绍没有被 React 清掉');
}
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

// Bundle budget (plan §11.5). The entry chunk is 842,933 B as of the SEO/docs-site
// change, so 900,000 B leaves only ~6% headroom — the next sizeable dependency will
// trip this. The banned strings and the single-wasm rule are what keep the QuickJS
// runtime lazy (importing the `quickjs-emscripten` root package would ship 4 wasm
// files, 4,258 kB).
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
console.log(JSON.stringify({ pages: locs.length, staticErrors }));
server.close();
if (errors.length || staticErrors.length || d.wires.length !== 24) process.exit(1);
