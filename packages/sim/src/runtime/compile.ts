/**
 * Studio TS → JavaScript (plan §6.2).
 *
 * sucrase only strips types; it is not a type checker and not a strict syntax
 * checker. That is deliberate: it is line-for-line faithful, so a QuickJS frame
 * `at loop (program_main.ts:14:3)` points at line 14 of what the user wrote and
 * no source map is needed. Everything sucrase lets through is caught later by
 * `evalCode`, which reports a structured `SyntaxError`.
 *
 * `transform` is a parameter, never an import: `packages/sim` keeps sucrase in
 * devDependencies so the product code carries no bundler-visible dependency.
 */
import type { ProgramAsset } from '@breadboard-studio/schema';
import type { SimDiagnostic } from '../types.js';
import { GUEST_MODULE_SPECIFIERS, isGuestModuleSpecifier } from './guest-modules.js';
import { compileErrorDiagnostic, locationFromSucraseError } from './diagnostics.js';

/**
 * Just the part of sucrase's `transform` this module uses. Narrow on purpose:
 * the real `transform` has to be assignable to it, and Studio TS only ever asks
 * for the `typescript` transform (no module rewriting — QuickJS runs ESM).
 */
export type SucraseTransform = (
  code: string,
  options: { transforms: ['typescript']; filePath?: string }
) => { code: string };

/** A compiled program: `filename` is `program.id` and shows up in QuickJS stacks. */
export interface CompiledProgram {
  code: string;
  filename: string;
}

export type CompileResult = { ok: true; code: string; filename: string } | { ok: false; diagnostic: SimDiagnostic };

/** One import/export module request found in the raw source. */
export interface ImportSite {
  specifier: string;
  line: number;
  column: number;
}

// `at loop (file:5:19)` and `at file:9:1` both parse with this one (plan §6.7).
const IMPORT_FROM = /(?:^|[^\w$.])(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])( *)\1/g;
const IMPORT_BARE = /(?:^|[^\w$.])import\s*(['"])( *)\1/g;
const IMPORT_DYNAMIC = /(?:^|[^\w$.])import\s*\(\s*(['"])( *)\1/g;

/**
 * Blank out comments and string *contents* while keeping every character
 * position (and therefore every line number) intact. Quotes survive so the
 * import patterns can still find a specifier slot; the real text is recovered
 * from `literals` by its start offset.
 *
 * This exists because the gate below runs on raw source, where a specifier
 * mentioned inside a comment or a string would otherwise be reported as an
 * illegal import.
 */
function maskSource(source: string): { masked: string; literals: Map<number, string> } {
  const out = source.split('');
  const literals = new Map<number, string>();
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      let j = i + 1;
      let value = '';
      while (j < source.length) {
        if (source[j] === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        value += source[j];
        j++;
      }
      literals.set(start, value);
      blank(start + 1, j);
      i = Math.min(j + 1, source.length);
      continue;
    }
    i++;
  }
  return { masked: out.join(''), literals };
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Every module specifier the source asks for, in source order.
 *
 * Runs on the *raw* source on purpose: sucrase deletes an import whose bindings
 * are unused, so `import fs from 'node:fs'` would never reach the module loader
 * and the illegal import would pass silently (plan §6.2).
 */
export function scanImportSpecifiers(source: string): ImportSite[] {
  const { masked, literals } = maskSource(source);
  const sites: ImportSite[] = [];
  const seen = new Set<number>();
  for (const pattern of [IMPORT_FROM, IMPORT_BARE, IMPORT_DYNAMIC]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
      const quoteAt = match.index + match[0].length - match[2].length - 2;
      if (seen.has(quoteAt)) continue;
      const specifier = literals.get(quoteAt);
      if (specifier === undefined) continue;
      seen.add(quoteAt);
      sites.push({ specifier, ...lineColumnAt(source, quoteAt) });
    }
  }
  return sites.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Compile one program. On failure the diagnostic is `program_compile_error`
 * with a source location that is good enough to highlight a line — sucrase's
 * `e.loc` is missing for some inputs, and the documented fallback is (1, 1).
 */
export function compileStudioTs(program: ProgramAsset, transform: SucraseTransform): CompileResult {
  const filename = program.id;
  const source = program.source ?? '';

  for (const site of scanImportSpecifiers(source)) {
    if (isGuestModuleSpecifier(site.specifier)) continue;
    return {
      ok: false,
      diagnostic: compileErrorDiagnostic(
        `不允许导入「${site.specifier}」：程序只能导入 ${GUEST_MODULE_SPECIFIERS.map((s) => `「${s}」`).join('、')}`,
        { programId: filename, line: site.line, column: site.column }
      )
    };
  }

  try {
    const result = transform(source, { transforms: ['typescript'], filePath: filename });
    return { ok: true, code: result.code, filename };
  } catch (error) {
    return {
      ok: false,
      diagnostic: compileErrorDiagnostic(
        `程序无法编译：${error instanceof Error ? error.message : String(error)}`,
        locationFromSucraseError(error, filename)
      )
    };
  }
}
