/**
 * Turns the repository's Markdown into the static, crawler-readable half of the
 * deployed site.
 *
 * Why this exists: the editor is a client-rendered SPA, so the deployed
 * `index.html` ships an empty `<div id="root">`. Google and Bing *may* run JS on a
 * delayed second pass; AI crawlers (GPTBot, ClaudeBot, PerplexityBot) and Baidu do
 * not run it at all. Without these pages the whole site is a blank document to
 * them, and `docs/*.md` — the only substantial prose this project owns — is
 * invisible outside GitHub.
 *
 * This module is pure: it takes Markdown text and returns HTML. Reading files and
 * writing `dist/` is `docs-site.ts`'s job, which keeps the rendering rules
 * testable without a build.
 */
import { posix } from 'node:path';
import MarkdownItCtor, { type MarkdownIt, type StateCore } from 'markdown-it';

/** Canonical production origin. Canonical tags, OG URLs and the sitemap must be absolute. */
export const SITE_URL = 'https://7dul2.github.io/breadboard-studio/';
export const REPO_URL = 'https://github.com/7dul2/breadboard-studio';
export const REPO_BRANCH = 'main';
export const SITE_NAME = 'Breadboard Studio';
export const SITE_TAGLINE = '在浏览器里拼面包板或洞洞板、摆元件、自动接线，再按图搭建你的电路。';

/**
 * The published set, in navigation order. Internal process docs (`PLAN.md`,
 * `STATUS.md`, `PHASE5_RFC.md`, `SIMULATOR_RUNTIME_PLAN.md`) are deliberately
 * absent: they read as development bookkeeping, not as documentation, and thin
 * off-topic pages dilute a site this small. Links to them fall through to GitHub.
 *
 * Slugs are English so shared URLs survive copy-paste without percent-encoding.
 */
export type DocSpec = {
  slug: string;
  source: string;
  nav: string;
  title: string;
  description: string;
};

export const DOCS: readonly DocSpec[] = [
  {
    slug: 'overview',
    source: 'README.md',
    nav: '总览',
    title: '面包板与洞洞板布局工具',
    description:
      '在浏览器里拼面包板或洞洞板、摆元件、自动接线，再按图搭建电路。支持 400/830 孔面包板、5×7 与 7×9 cm 洞洞板、ESP32-S3，以及导通向导与 SVG/PNG 导出。'
  },
  {
    slug: 'agent-guide',
    source: 'docs/AGENT_GUIDE.md',
    nav: 'Agent 指南',
    title: 'Agent 使用指南：用 CLI 和 JSON 驱动布局',
    description:
      '不依赖浏览器和截图定位，用命令行与 JSON 设计文件创建工程、放置元件、自动排线和校验接线。所有命令支持 --json 稳定输出，便于程序解析。'
  },
  {
    slug: 'catalog',
    source: 'docs/CATALOG.md',
    nav: '元件库',
    title: '元件目录与建模指南',
    description:
      '如何为面包板与洞洞板工具新增元件定义：外形尺寸、引脚坐标、安装方式、电气属性、正反面绘图，以及 geometry_status / electrical_status 证据等级。'
  },
  {
    slug: 'design-format',
    source: 'docs/DESIGN_FORMAT.md',
    nav: '文件格式',
    title: '设计文件格式 .breadboard.json',
    description:
      '.breadboard.json（schema 1.1）字段说明：板件、元件、导线、导通网络与校验，全部长度为整数微米，JSON Schema 2020-12 定义可直接输出。'
  },
  {
    slug: 'architecture',
    source: 'docs/ARCHITECTURE.md',
    nav: '架构',
    title: '架构与建模约定',
    description:
      'Breadboard Studio 的实现约定：孔位与导通模型、几何引擎、布局与布线的职责边界，以及面包板、洞洞板共用同一套内核的方式。'
  },
  {
    slug: 'simulator-design',
    source: 'docs/SIMULATOR_DESIGN.md',
    nav: '仿真器',
    title: '可编程仿真器设计方案',
    description:
      '在隔离沙箱里真实执行主控程序：驱动板载 RGB、打印串口、经真实 I²C 总线写入 OLED，并按虚拟时间暂停与单步。'
  },
  {
    slug: 'verification',
    source: 'docs/VERIFICATION.md',
    nav: '证据与复核',
    title: '定义证据与实测协作',
    description:
      '元件定义的证据等级与复核流程：documented、measured、verified 各要求什么，以及如何提交实测报告而不必写代码。'
  }
];

export function docBySlug(slug: string): DocSpec | undefined {
  return DOCS.find((d) => d.slug === slug);
}

/** Site-relative URL of a doc page, honouring the deploy base (`/` or `/breadboard-studio/`). */
export function docHref(base: string, slug: string): string {
  return `${base}docs/${slug}/`;
}

export function docCanonical(slug: string): string {
  return `${SITE_URL}docs/${slug}/`;
}

/**
 * Where a repo-relative asset ends up in `dist/`. Dropping the leading `docs/`
 * keeps URLs short (`/screenshots/x.png`) while staying unique across the repo,
 * because the prefix strip is applied uniformly.
 */
export function assetOutputPath(repoPath: string): string {
  return repoPath.startsWith('docs/') ? repoPath.slice('docs/'.length) : repoPath;
}

export function assetHref(base: string, repoPath: string): string {
  return `${base}${assetOutputPath(repoPath)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON embedded in a `<script>` must not be able to close it. */
function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Resolve a Markdown-relative link against the file that contains it. */
function resolveRepoPath(fromSource: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return posix.normalize(posix.join(posix.dirname(fromSource), target));
}

function splitHash(href: string): [string, string] {
  const i = href.indexOf('#');
  return i === -1 ? [href, ''] : [href.slice(0, i), href.slice(i)];
}

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Relative links in these docs point at repo files (`CONTRIBUTING.md`,
 * `LICENSE`, `examples/…`) or at sibling docs. Published docs get an on-site URL;
 * everything else goes to GitHub, which is strictly better than the 404 a bare
 * relative link would produce on the deployed site.
 */
function rewriteHref(href: string, fromSource: string, base: string): string {
  if (ABSOLUTE_URL.test(href) || href.startsWith('#')) return href;
  const [rawPath, hash] = splitHash(href);
  if (!rawPath) return href;
  const repoPath = resolveRepoPath(fromSource, rawPath);
  const spec = DOCS.find((d) => d.source === repoPath);
  if (spec) return `${docHref(base, spec.slug)}${hash}`;
  return `${REPO_URL}/blob/${REPO_BRANCH}/${repoPath}${hash}`;
}

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type RenderedDoc = {
  html: string;
  /** Repo-relative asset paths this page references; the caller must publish them. */
  assets: string[];
};

/**
 * `html: true` is required, not a shortcut: the README wraps its shortcut and
 * command tables in `<details>`, and escaping that raw HTML would print the tags
 * as text. The input is this repository's own Markdown, at the same trust level as
 * the code that renders it — there is no user-supplied Markdown in this pipeline.
 */
function createMarkdown(fromSource: string, base: string, assets: Set<string>): MarkdownIt {
  const md = new MarkdownItCtor({ html: true, linkify: true, typographer: false });

  // Heading ids, so README's own `#快速开始` / `#english` links resolve on the
  // published page and each section becomes directly shareable.
  md.core.ruler.push('bbs_heading_ids', (state: StateCore) => {
    const seen = new Map<string, number>();
    for (let i = 0; i < state.tokens.length; i += 1) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;
      const slug = slugifyHeading(inline.content) || 'section';
      const n = (seen.get(slug) ?? 0) + 1;
      seen.set(slug, n);
      token.attrSet('id', n === 1 ? slug : `${slug}-${n}`);
    }
  });

  md.core.ruler.push('bbs_rewrite_urls', (state: StateCore) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue;
      for (const child of token.children) {
        if (child.type === 'link_open') {
          // markdown-it 的 attrGet 声明为 string | number | null；属性值在这里只能是字符串。
          const href = child.attrGet('href');
          if (typeof href === 'string' && href) child.attrSet('href', rewriteHref(href, fromSource, base));
        } else if (child.type === 'image') {
          const src = child.attrGet('src');
          if (typeof src !== 'string' || !src || ABSOLUTE_URL.test(src) || src.startsWith('data:')) continue;
          const repoPath = resolveRepoPath(fromSource, src);
          assets.add(repoPath);
          child.attrSet('src', assetHref(base, repoPath));
        }
      }
    }
  });

  return md;
}

/** Exposed for tests: render a Markdown fragment the way the docs site does. */
export function renderMarkdownBody(markdown: string, fromSource: string, base = '/'): RenderedDoc {
  const assets = new Set<string>();
  const html = createMarkdown(fromSource, base, assets).render(markdown);
  return { html, assets: [...assets] };
}

function navHtml(base: string, activeSlug: string | null): string {
  const items = DOCS.map((doc) => {
    const current = doc.slug === activeSlug ? ' aria-current="page"' : '';
    return `<a href="${escapeHtml(docHref(base, doc.slug))}"${current}>${escapeHtml(doc.nav)}</a>`;
  }).join('');
  return `<header class="bbs-docs-header">
  <div class="bbs-docs-header-inner">
    <a class="bbs-docs-brand" href="${escapeHtml(base)}">${escapeHtml(SITE_NAME)}</a>
    <nav aria-label="文档">${items}</nav>
    <a class="bbs-docs-cta" href="${escapeHtml(base)}">打开编辑器</a>
  </div>
</header>`;
}

function footerHtml(): string {
  return `<footer class="bbs-docs-footer">
  <p>${escapeHtml(SITE_NAME)} · MIT 许可 · <a href="${REPO_URL}">GitHub 源码</a> · <a href="${REPO_URL}/issues">反馈问题</a></p>
  <p>${escapeHtml(SITE_TAGLINE)}</p>
</footer>`;
}

function pageShell(options: {
  base: string;
  title: string;
  description: string;
  canonical: string;
  activeSlug: string | null;
  structuredData: unknown;
  body: string;
}): string {
  const { base, title, description, canonical, activeSlug, structuredData, body } = options;
  const socialCard = `${SITE_URL}social-card.png`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(SITE_NAME)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta name="theme-color" content="#f3f1e9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1b1a" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:locale" content="zh_CN">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(socialCard)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(socialCard)}">
<link rel="stylesheet" href="${escapeHtml(base)}docs.css">
<script type="application/ld+json">${jsonLd(structuredData)}</script>
</head>
<body>
${navHtml(base, activeSlug)}
<main class="bbs-docs-main">
${body}
</main>
${footerHtml()}
</body>
</html>
`;
}

export function renderDocPage(spec: DocSpec, markdown: string, base: string): RenderedDoc {
  const { html, assets } = renderMarkdownBody(markdown, spec.source, base);
  const canonical = docCanonical(spec.slug);
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline: spec.title,
        description: spec.description,
        inLanguage: 'zh-CN',
        url: canonical,
        mainEntityOfPage: canonical,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: spec.title, item: canonical }
        ]
      }
    ]
  };
  return {
    html: pageShell({
      base,
      title: spec.title,
      description: spec.description,
      canonical,
      activeSlug: spec.slug,
      structuredData,
      body: html
    }),
    assets
  };
}

/** `/docs/` itself: a real page with prose, not a bare link list. */
export function renderDocsIndexPage(base: string): string {
  const items = DOCS.map(
    (doc) =>
      `    <li><a href="${escapeHtml(docHref(base, doc.slug))}">${escapeHtml(doc.title)}</a><p>${escapeHtml(doc.description)}</p></li>`
  ).join('\n');
  const body = `<article>
<h1>文档</h1>
<p>${escapeHtml(SITE_NAME)} 是一个开源的面包板与洞洞板布局工具：${escapeHtml(SITE_TAGLINE)}</p>
<p>下面这些文档说明它怎么用、文件格式长什么样、元件怎么建模，以及怎么让 Agent 通过 CLI 参与搭建。</p>
<ul class="bbs-docs-index">
${items}
</ul>
<p><a href="${escapeHtml(base)}">打开编辑器</a> · <a href="${REPO_URL}">GitHub 源码</a></p>
</article>`;
  return pageShell({
    base,
    title: '文档',
    description: `${SITE_NAME} 文档：使用方式、设计文件格式、元件建模、架构约定与仿真器方案。`,
    canonical: `${SITE_URL}docs/`,
    activeSlug: null,
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${SITE_NAME} 文档`,
      inLanguage: 'zh-CN',
      url: `${SITE_URL}docs/`,
      hasPart: DOCS.map((doc) => ({ '@type': 'TechArticle', name: doc.title, url: docCanonical(doc.slug) }))
    },
    body
  });
}

export function renderSitemap(): string {
  const urls = [SITE_URL, `${SITE_URL}docs/`, ...DOCS.map((doc) => docCanonical(doc.slug))];
  const entries = urls.map((url) => `  <url>\n    <loc>${escapeHtml(url)}</loc>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

/**
 * `robots.txt` is only read from the *host* root, so on `7dul2.github.io` this file
 * at `/breadboard-studio/robots.txt` is not what crawlers fetch — nothing was ever
 * blocking them, and the empty HTML was the real problem. It is still worth
 * shipping: it documents intent, and it takes effect the moment the site moves to a
 * custom domain. The sitemap is submitted by hand in the meantime.
 */
export function renderRobotsTxt(): string {
  return `# Read from the host root. On github.io project pages crawlers look at
# https://7dul2.github.io/robots.txt instead, so this takes full effect only on a
# custom domain. The sitemap below is submitted manually to each search console.
User-agent: *
Allow: /

Sitemap: ${SITE_URL}sitemap.xml
`;
}

/**
 * llms.txt is a community proposal — OpenAI and Anthropic have not committed to it,
 * so treat it as a cheap bet rather than a channel. The links are what matter.
 */
export function renderLlmsTxt(): string {
  const links = DOCS.map((doc) => `- [${doc.title}](${docCanonical(doc.slug)}): ${doc.description}`).join('\n');
  return `# ${SITE_NAME}

> ${SITE_TAGLINE} 开源（MIT），无需安装或登录，支持让 AI Agent 通过 CLI 和 JSON 设计文件参与搭建。

关键事实：
- 支持一体式 400 / 830 孔面包板、可拆拼装式面包板，以及 5×7 cm / 7×9 cm 洞洞板。
- 洞洞板每个焊盘默认独立不导通，元件可直接焊在孔位，可切换元件面与焊接面。
- 支持 ESP32-S3 N16R8、OLED、旋转编码器、触摸按键等元件，导线分杜邦线与硬质跳线。
- 提供静态校验（同孔冲突、脱格、板体碰撞、电源短路）与导通向导高亮。
- 可在隔离沙箱里真实执行主控程序，经真实 I²C 总线驱动虚拟 OLED。
- 设计导出为 .breadboard.json，可导出 SVG / PNG。

## 文档

${links}

## 链接

- 在线使用：${SITE_URL}
- 源码：${REPO_URL}
- 问题反馈：${REPO_URL}/issues
`;
}

/**
 * Docs pages share one stylesheet instead of inlining CSS into every file: the
 * tables are the bulk of this content and they need real horizontal-scroll rules.
 */
export const DOCS_CSS = `:root {
  color-scheme: light dark;
  --bg: #f3f1e9;
  --fg: #23231f;
  --muted: #5f5d54;
  --rule: #d9d5c7;
  --panel: #fbfaf5;
  --accent: #8a5a2b;
  --code-bg: #e9e6da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1b1a;
    --fg: #e8e6df;
    --muted: #a3a096;
    --rule: #3a3936;
    --panel: #232322;
    --accent: #d8a86a;
    --code-bg: #2c2c2a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
a { color: var(--accent); }
.bbs-docs-header { border-bottom: 1px solid var(--rule); background: var(--panel); }
.bbs-docs-header-inner {
  max-width: 60rem; margin: 0 auto; padding: 0.75rem 1.25rem;
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem;
}
.bbs-docs-brand { font-weight: 700; text-decoration: none; color: var(--fg); }
.bbs-docs-header nav { display: flex; flex-wrap: wrap; gap: 0.25rem 0.9rem; font-size: 0.9rem; }
.bbs-docs-header nav a { text-decoration: none; color: var(--muted); }
.bbs-docs-header nav a:hover, .bbs-docs-header nav a[aria-current="page"] { color: var(--fg); text-decoration: underline; }
.bbs-docs-cta {
  margin-left: auto; font-size: 0.9rem; text-decoration: none;
  border: 1px solid var(--rule); border-radius: 999px; padding: 0.2rem 0.8rem;
}
.bbs-docs-main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.bbs-docs-main h1 { font-size: 1.9rem; line-height: 1.3; margin: 0 0 1rem; }
.bbs-docs-main h2 { font-size: 1.35rem; margin: 2.5rem 0 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--rule); }
.bbs-docs-main h3 { font-size: 1.1rem; margin: 1.75rem 0 0.5rem; }
.bbs-docs-main img { max-width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 6px; }
.bbs-docs-main code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }
.bbs-docs-main pre {
  background: var(--code-bg); padding: 0.9rem 1rem; border-radius: 6px;
  overflow-x: auto; border: 1px solid var(--rule);
}
.bbs-docs-main pre code { background: none; padding: 0; }
.bbs-docs-main blockquote {
  margin: 1rem 0; padding: 0.25rem 1rem; border-left: 3px solid var(--accent);
  background: var(--panel); color: var(--muted);
}
.bbs-docs-main table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.92rem; }
.bbs-docs-main th, .bbs-docs-main td { border: 1px solid var(--rule); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
.bbs-docs-main th { background: var(--panel); }
/* These docs are table-dense; let a wide table scroll instead of stretching the page. */
.bbs-docs-main table { display: block; overflow-x: auto; }
.bbs-docs-main details { border: 1px solid var(--rule); border-radius: 6px; padding: 0.5rem 0.9rem; margin: 1rem 0; background: var(--panel); }
.bbs-docs-main summary { cursor: pointer; font-weight: 600; }
.bbs-docs-index { list-style: none; padding: 0; }
.bbs-docs-index li { border-top: 1px solid var(--rule); padding: 0.9rem 0; }
.bbs-docs-index li a { font-weight: 600; text-decoration: none; }
.bbs-docs-index li p { margin: 0.3rem 0 0; color: var(--muted); font-size: 0.92rem; }
.bbs-docs-footer {
  border-top: 1px solid var(--rule); padding: 1.5rem 1.25rem 3rem;
  max-width: 60rem; margin: 0 auto; color: var(--muted); font-size: 0.88rem;
}
.bbs-docs-footer p { margin: 0.2rem 0; }
`;
