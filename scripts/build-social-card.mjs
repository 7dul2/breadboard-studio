// Renders the 1200x630 social card (apps/web/public/social-card.png), which is what
// WeChat, Twitter/X, Discord and GitHub link previews show. Committed rather than
// generated per build so `vite build` stays fast and the asset is reviewable.
//
//   pnpm social-card
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = join(import.meta.dirname, '..', 'apps', 'web', 'public', 'social-card.png');

const W = 1200;
const H = 630;
const COLS = 13;
const ROWS = 9;

/** Hole grid for the board graphic; mirrors the favicon's breadboard motif. */
function holes() {
  const out = [];
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      // The centre groove is where a real breadboard's DIP gap sits.
      const y = 44 + r * 26 + (r >= Math.floor(ROWS / 2) ? 16 : 0);
      out.push(`<circle cx="${40 + c * 26}" cy="${y}" r="4.5" fill="#2f2e2a" opacity="0.78"/>`);
    }
  }
  return out.join('');
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${W}px; height: ${H}px; }
  .card {
    width: ${W}px; height: ${H}px; display: flex; align-items: center;
    gap: 48px; padding: 0 64px; background: #f3f1e9;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #23231f;
  }
  .left { flex: 1 1 auto; min-width: 0; }
  .brand { font-size: 68px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.05; }
  .rule { width: 72px; height: 6px; background: #8a5a2b; border-radius: 3px; margin: 22px 0 20px; }
  .tagline { font-size: 30px; line-height: 1.45; color: #3c3a33; }
  .tagline span { color: #6b6960; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
  .chips b {
    font-size: 19px; font-weight: 600; color: #4a4840;
    background: #e7e4d7; border: 1px solid #d5d1c1;
    border-radius: 999px; padding: 6px 16px;
  }
  .url { margin-top: 30px; font-size: 21px; color: #8a5a2b; font-weight: 600; }
  .right { flex: 0 0 396px; display: flex; justify-content: center; }
</style>
</head>
<body>
  <div class="card">
    <div class="left">
      <div class="brand">Breadboard<br>Studio</div>
      <div class="rule"></div>
      <div class="tagline">在浏览器里拼面包板与洞洞板<br><span>摆元件 · 自动接线 · 导通校验</span></div>
      <div class="chips"><b>400 / 830 孔面包板</b><b>5×7 · 7×9 洞洞板</b><b>ESP32-S3</b><b>程序仿真</b></div>
      <div class="url">7dul2.github.io/breadboard-studio</div>
    </div>
    <div class="right">
      <svg width="396" height="396" viewBox="0 0 396 396" fill="none">
        <rect x="8" y="28" width="380" height="340" rx="16" fill="#e9e6d8" stroke="#cfcabb" stroke-width="2"/>
        <rect x="8" y="182" width="380" height="32" fill="#ddd9c9"/>
        <rect x="26" y="40" width="2" height="316" fill="#c9c4b2"/>
        <rect x="368" y="40" width="2" height="316" fill="#c9c4b2"/>
        ${holes()}
        <path d="M66 70 L118 70 L118 148 L196 148" stroke="#c8503c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M330 96 L278 96 L278 210 L214 210" stroke="#2f6f4f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M92 300 L92 250 L150 250" stroke="#2f5d8a" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="150" y="126" width="96" height="52" rx="6" fill="#3a3933"/>
        <rect x="166" y="140" width="64" height="24" rx="3" fill="#5d5b52"/>
      </svg>
    </div>
  </div>
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();
console.log(`已生成 ${OUT}（${W}x${H}）`);