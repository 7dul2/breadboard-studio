/**
 * Dev-only write-back of a catalog definition to the JSON file the built-in
 * catalog imports.
 *
 * The artwork editor's other two outputs are fragile in the same way. 保存到本项目
 * lives inside one document and dies with it — `replace_design` drops
 * `embedded_catalog` when the incoming document has none, so a DSL apply, an
 * import, a new project, or an undo past the save all take the drawing with them.
 * 导出定义 JSON lands in the download folder and has to be moved by hand. Neither
 * is right for a drawing that is simply *wrong*: that belongs in the library, so
 * this writes the source file and every project picks the fix up.
 *
 * **Where the checks live.** Schema validation runs in the browser, where the
 * editor can call the very `validateComponentDefinition` that `builtinCatalog()`
 * runs at boot; a definition that fails it is never sent. It cannot run here:
 * `vite.config.ts` is loaded as plain Node ESM, and the workspace packages are
 * source-only TypeScript with bundler-style specifiers, so importing them breaks
 * the config load outright. What this module enforces instead is everything the
 * filesystem knows about:
 *
 * 1. `<id>.json` must already exist in the directory — a write can only ever
 *    overwrite a definition that is there, never create a file, and the id never
 *    reaches the path unless it is a plain identifier (no traversal);
 * 2. the incoming definition must have the same `kind`, `id` and `version` as the
 *    file it replaces, so a definition can never be written over a different one.
 *
 * The definitions are tracked in git, which is the real undo for a bad write.
 * Nothing here reaches the browser bundle: the module lives outside `src/` and is
 * imported only by `vite.config.ts`, under `apply: 'serve'`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type WriteOutcome = { ok: true; path: string; bytes: number } | { ok: false; status: 400 | 403 | 409; error: string };

export interface WriteOptions {
  /** Directory holding `<id>.json`; overridable so tests never touch the repo. */
  dir: string;
}

/** Definition filenames are exactly `<id>.json`, and every built-in id looks like this. */
const ID = /^[a-z0-9][a-z0-9_]*$/;

/** Same shape as the repo's definition files: 2-space JSON with a trailing newline. */
export function formatDefinition(def: unknown): string {
  return `${JSON.stringify(def, null, 2)}\n`;
}

function identity(v: unknown): { kind: unknown; id: unknown; version: unknown } {
  const o = (v ?? {}) as Record<string, unknown>;
  return { kind: o.kind, id: o.id, version: o.version };
}

export function writeDefinition(body: unknown, opts: WriteOptions): WriteOutcome {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: '请求体不是一个定义对象' };
  const def = body as Record<string, unknown>;

  if (def.kind !== 'board' && def.kind !== 'component') return { ok: false, status: 400, error: `未知的 kind：${JSON.stringify(def.kind)}` };
  if (typeof def.id !== 'string' || !ID.test(def.id)) return { ok: false, status: 400, error: `非法的定义 id：${JSON.stringify(def.id)}` };
  if (typeof def.version !== 'number' || !Number.isInteger(def.version) || def.version < 1) return { ok: false, status: 400, error: `非法的 version：${JSON.stringify(def.version)}` };

  const path = join(opts.dir, `${def.id}.json`);
  if (!existsSync(path)) {
    return { ok: false, status: 403, error: `${def.id} 不在元件库里。写回只能覆盖已有定义；新型号请把 JSON 放进 packages/catalog/src/definitions/ 并在 index.ts 注册。` };
  }

  let current: unknown;
  try {
    current = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, status: 409, error: `${path} 当前不是合法 JSON，先修好它再写回：${(e as Error).message}` };
  }
  const was = identity(current);
  const now = identity(def);
  if (was.kind !== now.kind || was.id !== now.id || was.version !== now.version) {
    return { ok: false, status: 409, error: `身份不一致，拒绝覆盖：文件是 ${was.kind}/${was.id}@${was.version}，请求是 ${now.kind}/${now.id}@${now.version}` };
  }

  const text = formatDefinition(def);
  writeFileSync(path, text, 'utf8');
  return { ok: true, path, bytes: Buffer.byteLength(text) };
}
