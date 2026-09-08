import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { validateComponentDefinition } from '@breadboard-studio/schema';
import { formatDefinition, writeDefinition } from './definition-writeback';

const TTP223 = builtinCatalog().getComponent('ttp223_module@1')!;
const BOARD = builtinCatalog().getBoard('breadboard_400@1')!;

/** A directory that looks like packages/catalog/src/definitions, holding only what the test seeds. */
function dirWith(...defs: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bbs-writeback-'));
  for (const d of defs) writeFileSync(join(dir, `${(d as { id: string }).id}.json`), formatDefinition(d), 'utf8');
  return dir;
}

describe('catalog definition write-back', () => {
  it('overwrites the file the built-in catalog reads, in the repo’s own formatting', () => {
    const dir = dirWith(TTP223);
    const edited = { ...TTP223, render: TTP223.render.map((p, i) => ({ ...p, g: `p${i}` })) };
    const r = writeDefinition(edited, { dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe(join(dir, 'ttp223_module.json'));

    const text = readFileSync(r.path, 'utf8');
    expect(text).toBe(formatDefinition(edited));
    expect(text.endsWith('}\n'), 'trailing newline like every other definition file').toBe(true);
    expect(text.split('\n')[1]).toMatch(/^ {2}"/);
    // the catalog would still boot on it, and the edit really landed
    expect(validateComponentDefinition(JSON.parse(text)).ok).toBe(true);
    expect(JSON.parse(text).render[0].g).toBe('p0');
  });

  it('refuses an id with no file, so a write can only ever overwrite', () => {
    const dir = dirWith(TTP223);
    const r = writeDefinition({ ...TTP223, id: 'my_new_module' }, { dir });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(readdirSync(dir)).toEqual(['ttp223_module.json']);
  });

  it('refuses an id that tries to escape the directory', () => {
    const dir = dirWith(TTP223);
    for (const id of ['../../evil', 'a/b', '.env', 'ttp223_module.json', '']) {
      expect(writeDefinition({ ...TTP223, id }, { dir }), id).toMatchObject({ ok: false, status: 400 });
    }
    expect(readdirSync(dir)).toEqual(['ttp223_module.json']);
  });

  it('refuses to write one definition over another', () => {
    const dir = dirWith(TTP223, BOARD);
    // right filename, wrong identity: a board body posted under the module's id
    copyFileSync(join(dir, 'breadboard_400.json'), join(dir, 'ttp223_module.json'));
    const r = writeDefinition(TTP223, { dir });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { ok: false; error: string }).error).toContain('身份不一致');

    const bumped = writeDefinition({ ...TTP223, version: TTP223.version + 1 }, { dir: dirWith(TTP223) });
    expect(bumped, 'a version bump is a new definition, not an overwrite').toMatchObject({ ok: false, status: 409 });
  });

  it('rejects anything that is not a definition object, leaving the file untouched', () => {
    const dir = dirWith(TTP223);
    const original = readFileSync(join(dir, 'ttp223_module.json'), 'utf8');
    for (const body of [null, 42, 'text', [TTP223], {}, { ...TTP223, kind: 'gadget' }, { ...TTP223, version: '1' }]) {
      expect(writeDefinition(body, { dir }), JSON.stringify(body)?.slice(0, 30)).toMatchObject({ ok: false, status: 400 });
    }
    expect(readFileSync(join(dir, 'ttp223_module.json'), 'utf8')).toBe(original);
  });

  it('writes a board definition too', () => {
    const dir = dirWith(BOARD);
    expect(writeDefinition(BOARD, { dir }).ok).toBe(true);
    expect(existsSync(join(dir, 'breadboard_400.json'))).toBe(true);
  });
});
