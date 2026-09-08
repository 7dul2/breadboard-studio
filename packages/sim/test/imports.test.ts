import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const srcDir = join(import.meta.dirname, '..', 'src');

/**
 * Files that may reach for the design-side packages. Everything else runs
 * inside the worker, where importing core drags ajv and the whole geometry
 * engine into the chunk (measured: 135,978 B versus 81 B for types only).
 */
const MAIN_THREAD_ONLY = new Set(['index.ts', 'snapshot.ts', 'controller.ts']);

const FORBIDDEN = [
  { pattern: /@breadboard-studio\/core/, why: 'core' },
  { pattern: /@breadboard-studio\/catalog/, why: 'catalog' },
  { pattern: /\.\.?\/snapshot\.js/, why: 'snapshot.ts' },
  { pattern: /\.\.?\/controller\.js/, why: 'controller.ts' }
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** Import and re-export statements only; a mention inside a comment is fine. */
function importedSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

describe('worker import boundary', () => {
  const files = tsFiles(srcDir).map((path) => ({
    path,
    rel: relative(srcDir, path),
    text: readFileSync(path, 'utf8')
  }));

  it('finds the source tree it is supposed to guard', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const name of MAIN_THREAD_ONLY) {
      expect(files.some((f) => f.rel === name), name).toBe(true);
    }
  });

  it('keeps core, catalog, snapshot and controller out of every worker-side file', () => {
    const offences: string[] = [];
    for (const file of files) {
      if (MAIN_THREAD_ONLY.has(file.rel)) continue;
      for (const specifier of importedSpecifiers(file.text)) {
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(specifier)) offences.push(`${file.rel} imports ${rule.why} (${specifier})`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('only ever type-imports the schema package outside the main-thread files', () => {
    // A value import of @breadboard-studio/schema pulls ajv in. Type imports erase.
    const offences: string[] = [];
    for (const file of files) {
      if (MAIN_THREAD_ONLY.has(file.rel)) continue;
      for (const m of file.text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s*['"]@breadboard-studio\/schema['"]/gm)) {
        if (!m[1]) offences.push(`${file.rel} value-imports @breadboard-studio/schema`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('never imports the heavy runtime dependencies as values', () => {
    // quickjs and sucrase instances are injected as constructor arguments, so
    // packages/sim's shipped code carries no wasm dependency of its own.
    const heavy = /^(quickjs-emscripten|quickjs-emscripten-core|@jitl\/|sucrase)/;
    const offences: string[] = [];
    for (const file of files) {
      for (const m of file.text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
        if (heavy.test(m[2]!) && !m[1]) offences.push(`${file.rel} value-imports ${m[2]}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('routes the worker through the two published subpaths only', async () => {
    const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './kernel', './worker']);
    // Both barrels must actually resolve and re-export something.
    const kernel = await import('../src/kernel.js');
    const worker = await import('../src/worker/index.js');
    for (const name of ['Scheduler', 'DigitalNetKernel', 'PowerDomain', 'builtinDrivers', 'SIM_DIAGNOSTIC_CODES']) {
      expect(Object.keys(kernel), name).toContain(name);
    }
    for (const name of ['SimLoop', 'SpeedPacer', 'Outbox', 'StudioTsSandbox', 'compileStudioTs', 'GUEST_MODULES']) {
      expect(Object.keys(worker), name).toContain(name);
    }
  });
});
