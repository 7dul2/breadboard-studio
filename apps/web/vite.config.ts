import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
// The extension is required by Vite's native config loader; TS allows it here via allowImportingTsExtensions.
import { writeDefinition } from './devtools/definition-writeback.ts';

// GitHub Pages serves the site under /<repo>/; local dev serves at /.
const base = process.env.VITE_BASE ?? '/';

const DEFINITIONS_DIR = process.env.BBS_DEFINITIONS_DIR ?? fileURLToPath(new URL('../../packages/catalog/src/definitions', import.meta.url));

/**
 * `POST /__bbs/definition` writes one catalog definition back to its source file
 * (see devtools/definition-writeback.ts for why, and for where each check lives).
 * `apply: 'serve'` is what keeps it out of the built site: the deployed app has no
 * filesystem to write to and must never pretend otherwise.
 */
function definitionWriteback(): Plugin {
  return {
    name: 'bbs-definition-writeback',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__bbs/definition', (req, res) => {
        const send = (status: number, payload: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') return send(405, { ok: false, error: '只接受 POST' });
        let body = '';
        let tooBig = false;
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          // A definition is ~100 kB; 8 MB is a runaway request, not a drawing.
          if (body.length > 8_000_000 && !tooBig) {
            tooBig = true;
            send(413, { ok: false, error: '请求体过大' });
            req.destroy();
          }
        });
        req.on('end', () => {
          if (tooBig) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            return send(400, { ok: false, error: `请求体不是合法 JSON：${(e as Error).message}` });
          }
          const r = writeDefinition(parsed, { dir: DEFINITIONS_DIR });
          if (!r.ok) return send(r.status, r);
          server.config.logger.info(`[bbs] 已写回元件库定义 ${r.path}（${r.bytes} B）`);
          send(200, r);
        });
      });
    }
  };
}

export default defineConfig({
  base,
  plugins: [react(), definitionWriteback()],
  server: {
    port: 5173,
    strictPort: false
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022'
  }
});
