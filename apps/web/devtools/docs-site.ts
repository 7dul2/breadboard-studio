/**
 * Emits the crawler-readable part of the deployed site: `docs/**` pages plus
 * `sitemap.xml`, `robots.txt` and `llms.txt`.
 *
 * This runs inside `vite build` rather than as a separate script so that CI and
 * `pages.yml` keep working unchanged — both call `pnpm build`, and both get the
 * docs site for free. `configureServer` serves the same pages in dev so they can be
 * checked without a full build.
 *
 * See docs-content.ts for why these pages exist at all.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger, Plugin } from 'vite';
import {
  DOCS,
  DOCS_CSS,
  SITE_URL,
  assetOutputPath,
  docHref,
  renderDocPage,
  renderDocsIndexPage,
  renderLlmsTxt,
  renderRobotsTxt,
  renderSitemap
} from './docs-content.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Served =
  | { kind: 'text'; path: string; content: string; type: string }
  | { kind: 'asset'; path: string; from: string; type: string };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? undefined : TYPES[path.slice(dot).toLowerCase()]) ?? 'application/octet-stream';
}

/** Every file the docs site owns, keyed by the dist-relative path it is written to. */
function generateSite(base: string): Map<string, Served> {
  const served = new Map<string, Served>();

  // Two different sources claiming one output path would silently drop a file.
  const claim = (outPath: string, from: string) => {
    const previous = served.get(outPath);
    if (previous && !(previous.kind === 'asset' && previous.from === from)) {
      throw new Error(`docs-site: ${outPath} 有多个来源，输出路径冲突`);
    }
  };

  const addText = (path: string, content: string) => {
    claim(path, path);
    served.set(path, { kind: 'text', path, content, type: contentType(path) });
  };

  for (const spec of DOCS) {
    const abs = join(REPO_ROOT, spec.source);
    if (!existsSync(abs)) {
      throw new Error(`docs-site: 找不到文档源文件 ${spec.source}（DOCS 注册表与仓库不一致）`);
    }
    const { html, assets } = renderDocPage(spec, readFileSync(abs, 'utf8'), base);
    addText(`docs/${spec.slug}/index.html`, html);
    for (const repoPath of assets) {
      const outPath = assetOutputPath(repoPath);
      const from = join(REPO_ROOT, repoPath);
      claim(outPath, from);
      served.set(outPath, { kind: 'asset', path: outPath, from, type: contentType(outPath) });
    }
  }

  addText('docs/index.html', renderDocsIndexPage(base));
  addText('docs.css', DOCS_CSS);
  addText('sitemap.xml', renderSitemap());
  addText('robots.txt', renderRobotsTxt());
  addText('llms.txt', renderLlmsTxt());

  // Directory-style URLs are what the sitemap and the nav links use. Registering the
  // bare and trailing-slash forms as aliases keeps them off Vite's SPA fallback,
  // which would otherwise answer them with the editor shell.
  for (const [path, entry] of [...served]) {
    if (!path.endsWith('/index.html')) continue;
    const dir = path.slice(0, -'index.html'.length);
    served.set(dir, entry);
    served.set(dir.replace(/\/$/, ''), entry);
  }

  return served;
}

export function docsSite(): Plugin {
  let outDir = '';
  let base = '/';
  let logger: Logger | null = null;

  return {
    name: 'bbs-docs-site',

    configResolved(config) {
      outDir = config.build.outDir;
      base = config.base;
      logger = config.logger;
    },

    /**
     * The intro inside `#root` links to the docs so crawlers can walk the site. Those
     * hrefs cannot be hardcoded: the deploy base is `/breadboard-studio/` today but
     * would be `/` on a custom domain, and a wrong absolute path 404s silently.
     */
    transformIndexHtml(html) {
      const marker = '<!--bbs-docs-nav-->';
      if (!html.includes(marker)) {
        throw new Error(`docs-site: index.html 里找不到 ${marker}，站内文档导航无法注入`);
      }
      const links = DOCS.map((doc) => `<a href="${docHref(base, doc.slug)}">${doc.nav}</a>`).join(' · ');
      return html.replace(marker, `文档：<a href="${base}docs/">全部文档</a> · ${links}`);
    },

    configureServer(server) {
      // Registered directly rather than through the returned post hook so these
      // paths are handled before Vite's own middlewares see them.
      const site = generateSite(base);
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith(base)) return next();
        const entry = site.get(url.slice(base.length));
        if (!entry) return next();
        res.statusCode = 200;
        res.setHeader('content-type', entry.type);
        if (req.method === 'HEAD') return res.end();
        res.end(entry.kind === 'text' ? Buffer.from(entry.content) : readFileSync(entry.from));
      });
      server.config.logger.info(`[bbs] 文档站 ${DOCS.length} 页已在 dev 下可访问：${base}docs/`);
    },

    closeBundle() {
      if (!outDir) return;
      const site = generateSite(base);
      const written = new Set<string>();
      for (const entry of site.values()) {
        if (written.has(entry.path)) continue;
        written.add(entry.path);
        const target = join(outDir, entry.path);
        mkdirSync(dirname(target), { recursive: true });
        if (entry.kind === 'text') writeFileSync(target, entry.content, 'utf8');
        else copyFileSync(entry.from, target);
      }
      logger?.info(
        `[bbs] 文档站已写入 ${outDir}：${DOCS.length} 页 + sitemap.xml / robots.txt / llms.txt（canonical ${SITE_URL}）`
      );
    }
  };
}