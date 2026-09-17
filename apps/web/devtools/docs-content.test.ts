import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCS,
  DOCS_CSS,
  SITE_URL,
  assetHref,
  docCanonical,
  renderDocPage,
  renderDocsIndexPage,
  renderLlmsTxt,
  renderMarkdownBody,
  renderRobotsTxt,
  renderSitemap
} from './docs-content.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

describe('DOCS 注册表', () => {
  it('slug 唯一', () => {
    const slugs = DOCS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('源文件都存在', () => {
    for (const doc of DOCS) {
      expect(existsSync(join(REPO_ROOT, doc.source)), `${doc.source} 不存在`).toBe(true);
    }
  });

  it('每页都有非空且不重复的 title/description', () => {
    for (const doc of DOCS) {
      expect(doc.title.length).toBeGreaterThan(4);
      expect(doc.description.length).toBeGreaterThan(20);
    }
    expect(new Set(DOCS.map((d) => d.title)).size).toBe(DOCS.length);
  });
});

describe('renderDocPage', () => {
  const overview = DOCS.find((d) => d.slug === 'overview');
  if (!overview) throw new Error('overview 必须在 DOCS 里');
  const markdown = readFileSync(join(REPO_ROOT, overview.source), 'utf8');
  const page = renderDocPage(overview, markdown, '/breadboard-studio/').html;

  it('带 canonical、description 和分享图', () => {
    expect(page).toContain(`<link rel="canonical" href="${docCanonical('overview')}">`);
    expect(page).toContain('<meta name="description"');
    expect(page).toContain(`${SITE_URL}social-card.png`);
  });

  it('JSON-LD 是可解析的 JSON，且不能提前闭合 script', () => {
    const raw = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { '@graph': { '@type': string }[] };
    expect(parsed['@graph'].map((n) => n['@type'])).toContain('TechArticle');
    expect(raw).not.toContain('</');
  });

  it('保留 README 的 <details>，而不是把它转义成文本', () => {
    // 这些折叠块在 README 里放了快捷键和命令表；html:false 会让标签变成字面文字。
    expect(page).toContain('<details>');
    expect(page).toContain('<summary>');
    expect(page).not.toContain('&lt;details&gt;');
  });

  it('页内锚点能落地：README 的 #快速开始 / #english 都指向真实存在的标题 id', () => {
    // markdown-it 会把非 ASCII 链接做 percent-encoding，浏览器在匹配 id 前会先解码，
    // 所以断言「解码后的 fragment 命中某个标题 id」，而不是断言字面量。
    const ids = new Set([...page.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]));
    expect(ids.has('快速开始')).toBe(true);
    expect(ids.has('english')).toBe(true);

    const fragments = [...page.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(fragments.map(decodeURIComponent)).toContain('快速开始');
    expect(fragments.map(decodeURIComponent)).toContain('english');
    // 每个页内锚点都必须有对应标题，否则就是一个跳不动的链接。
    for (const fragment of fragments) {
      expect(ids.has(decodeURIComponent(fragment)), `#${fragment} 没有对应的标题`).toBe(true);
    }
  });

  it('已发布的文档互链走站内，未发布的走 GitHub', () => {
    expect(page).toContain('href="/breadboard-studio/docs/catalog/"');
    // 这些是内部过程文档，故意不发到站点上。
    expect(page).toContain('https://github.com/7dul2/breadboard-studio/blob/main/docs/STATUS.md');
    expect(page).not.toContain('/docs/status/');
  });

  it('图片改写为站点路径，并报告需要发布的文件', () => {
    const { assets } = renderDocPage(overview, markdown, '/breadboard-studio/');
    expect(page).toContain(`src="${assetHref('/breadboard-studio/', 'docs/screenshots/editor-environment-node.png')}"`);
    expect(assets).toContain('docs/screenshots/editor-environment-node.png');
  });

  it('外部链接原样保留', () => {
    expect(page).toContain('href="https://github.com/7dul2/breadboard-studio/issues"');
  });
});

describe('renderMarkdownBody', () => {
  it('相对链接按所在文件解析，而不是按仓库根', () => {
    // AGENT_GUIDE 在 docs/ 下，`CATALOG.md` 指的是 docs/CATALOG.md。
    const { html } = renderMarkdownBody('见 [元件库](CATALOG.md)。', 'docs/AGENT_GUIDE.md', '/');
    expect(html).toContain('href="/docs/catalog/"');
  });

  it('../ 能回到仓库根', () => {
    const { html } = renderMarkdownBody('见 [贡献](../CONTRIBUTING.md)。', 'docs/AGENT_GUIDE.md', '/');
    expect(html).toContain('/blob/main/CONTRIBUTING.md');
  });
});

describe('站点级文件', () => {
  it('sitemap 覆盖编辑器、文档首页和每一页', () => {
    const xml = renderSitemap();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const doc of DOCS) expect(xml).toContain(`<loc>${docCanonical(doc.slug)}</loc>`);
    expect(xml).toContain(`<loc>${SITE_URL}</loc>`);
    expect(xml).toContain(`<loc>${SITE_URL}docs/</loc>`);
    // <loc> 必须绝对——相对路径在 sitemap 里是无效的。
    expect(xml.match(/<loc>/g)?.length).toBe(DOCS.length + 2);
  });

  it('robots.txt 指向 sitemap，且不误封任何爬虫', () => {
    const txt = renderRobotsTxt();
    expect(txt).toContain(`Sitemap: ${SITE_URL}sitemap.xml`);
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Allow: /');
    expect(txt).not.toMatch(/^Disallow:\s*\//m);
  });

  it('llms.txt 列出每一页的绝对链接', () => {
    const txt = renderLlmsTxt();
    for (const doc of DOCS) expect(txt).toContain(docCanonical(doc.slug));
  });

  it('文档首页链接到每一页', () => {
    const html = renderDocsIndexPage('/breadboard-studio/');
    for (const doc of DOCS) expect(html).toContain(`href="/breadboard-studio/docs/${doc.slug}/"`);
  });

  it('样式表覆盖表格滚动，否则宽表会撑破页面', () => {
    expect(DOCS_CSS).toContain('overflow-x: auto');
    expect(DOCS_CSS).toContain('prefers-color-scheme: dark');
  });
});