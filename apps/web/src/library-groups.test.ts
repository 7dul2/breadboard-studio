import { describe, it, expect } from 'vitest';
import type { CatalogDefinition } from '@breadboard-studio/schema';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { buildLibraryGroups, foldedBuiltinCount, libraryCategoryKey, modelRef } from './library-groups';

const defs = builtinCatalog().list();
const noRefs = new Set<string>();
const noExpanded = new Set<string>();

function group(key: string, filter = '', expanded: ReadonlySet<string> = noExpanded) {
  const found = buildLibraryGroups(defs, { filter, embeddedRefs: noRefs, expanded }).find((g) => g.key === key);
  if (!found) throw new Error(`no group ${key}`);
  return found;
}

function ids(items: CatalogDefinition[]): string[] {
  return items.map((d) => d.id);
}

describe('元件库分组（issue #32）', () => {
  it('默认只展开精选型号，其余进折叠区', () => {
    const all = buildLibraryGroups(defs, { filter: '', embeddedRefs: noRefs, expanded: noExpanded });
    const shown = all.flatMap((g) => ids(g.items));
    const declaredFolded = all.reduce((sum, g) => sum + g.foldedTotal, 0);

    // 分区性质：默认视图 = 精选，折叠区 = 其余，两者不重不漏。
    // 「哪 12 个是精选」由 packages/catalog/test/catalog.test.ts 钉住；这里只验分区。
    expect(shown).toHaveLength(defs.filter((d) => d.featured === true).length);
    expect(declaredFolded).toBe(defs.length - shown.length);
    expect(all.every((g) => g.folded.length === 0)).toBe(true);
  });

  it('展开某个类目后，该类目的折叠型号进入列表，其他类目不受影响', () => {
    const before = group('sensor');
    expect(before.items).toEqual([]);
    expect(before.foldedTotal).toBeGreaterThan(0);

    const after = group('sensor', '', new Set(['sensor']));
    expect(ids(after.folded).sort()).toEqual(['bmp390_breakout', 'ltr390_breakout', 'sen66', 'sht41_breakout']);
    expect(ids(after.folded)).toHaveLength(after.foldedTotal);
    expect(group('passive').folded).toEqual([]);
  });

  it('搜索覆盖整个目录：被折叠的型号直接命中，精选型号排在前面', () => {
    const xiao = buildLibraryGroups(defs, { filter: 'xiao', embeddedRefs: noRefs, expanded: noExpanded }).flatMap((g) => ids(g.items));
    expect(xiao).toContain('xiao_esp32s3_sense');

    // 搜索时精选型号仍然排在同类目前面。
    const display = buildLibraryGroups(defs, { filter: 'oled', embeddedRefs: noRefs, expanded: noExpanded }).find((g) => g.key === 'display')!;
    expect(ids(display.items).indexOf('oled_0_96_ssd1315_i2c')).toBeLessThan(ids(display.items).indexOf('oled_0_96_i2c'));

    // 命中为空时不留空分组。
    expect(buildLibraryGroups(defs, { filter: 'no_such_part', embeddedRefs: noRefs, expanded: noExpanded })).toEqual([]);
  });

  it('搜索命中 keywords 与 manufacturer（issue #42）', () => {
    const hit = (filter: string) =>
      buildLibraryGroups(defs, { filter, embeddedRefs: noRefs, expanded: noExpanded }).flatMap((g) => ids(g.items));

    // 中文别名 / 常见简称 / 料号，不必出现在 id/name/model 里。
    expect(hit('发光二极管')).toContain('led_5mm');
    expect(hit('轻触开关')).toContain('tactile_6x6');
    expect(hit('旋转编码器')).toContain('encoder_ky040');
    expect(hit('KY-040')).toContain('encoder_ky040');
    expect(hit('温湿度')).toContain('sht41_breakout');
    expect(hit('触摸')).toEqual(expect.arrayContaining(['ttp223_module', 'ttp224_module']));

    // 厂商名。
    expect(hit('seeed')).toContain('xiao_esp32s3_sense');
    expect(hit('sensirion')).toContain('sht41_breakout');

    // 旧定义（无 keywords）行为不变：仍靠 id/name/model。
    expect(hit('breadboard_400')).toContain('breadboard_400');
  });

  it('内嵌定义永远露出，即使没有 featured', () => {
    const embedded = new Set(['power_module_3v3@1']);
    const power = buildLibraryGroups(defs, { filter: '', embeddedRefs: embedded, expanded: noExpanded }).find((g) => g.key === 'power')!;
    expect(ids(power.items)).toEqual(['power_module_3v3']);
    expect(power.foldedTotal).toBe(0);
  });

  it('未知状态的占位定义默认折叠，但并不阻止添加', () => {
    const power = group('power');
    expect(power.foldedTotal).toBeGreaterThan(0);
    expect(group('power', '', new Set(['power'])).folded.map((d) => d.electrical_status)).toContain('unknown');
  });

  it('类目 key 覆盖板子与元件，且分组顺序稳定', () => {
    expect(libraryCategoryKey(builtinCatalog().getBoard('perfboard_5x7@1')!)).toBe('board_perfboard');
    expect(libraryCategoryKey(builtinCatalog().getBoard('breadboard_400@1')!)).toBe('board_integrated');
    expect(libraryCategoryKey(builtinCatalog().getComponent('led_5mm@1')!)).toBe('passive');

    const keys = buildLibraryGroups(defs, { filter: '', embeddedRefs: noRefs, expanded: noExpanded }).map((g) => g.key);
    expect(keys).toEqual(['board_integrated', 'board_modular', 'board_perfboard', 'mcu', 'display', 'input', 'sensor', 'power', 'passive']);
  });

  it('modelRef 拼出可比较的引用', () => {
    expect(modelRef({ id: 'led_5mm', version: 1 })).toBe('led_5mm@1');
  });

  it('折叠数量只数「内置且非精选」的定义', () => {
    expect(builtinCatalog().getComponent('power_module_3v3@1')).toBeTruthy();
    const folded = foldedBuiltinCount(defs, noRefs);
    // 内嵌定义不算内置，也不进折叠计数。
    expect(foldedBuiltinCount(defs, new Set(['power_module_3v3@1']))).toBe(folded - 1);
  });

  it('纯函数的边界：空目录、featured:false、纯空白搜索、大小写、未知类目', () => {
    const fake = (id: string, patch: Record<string, unknown> = {}) =>
      ({ kind: 'component', id, version: 1, name: id, category: 'other', featured: false, ...patch }) as unknown as CatalogDefinition;

    expect(buildLibraryGroups([], { filter: '', embeddedRefs: noRefs, expanded: noExpanded })).toEqual([]);

    // featured:false 与缺字段同样进折叠区；纯空白搜索不进入搜索态。
    const groups = buildLibraryGroups([fake('a')], { filter: '   ', embeddedRefs: noRefs, expanded: new Set(['other']) });
    expect(groups).toHaveLength(1);
    expect(ids(groups[0]!.folded)).toEqual(['a']);
    expect(groups[0]!.items).toEqual([]);

    // 搜索大小写不敏感，并且命中折叠项。
    expect(buildLibraryGroups([fake('MixedCase_Part')], { filter: 'mixedcase', embeddedRefs: noRefs, expanded: noExpanded })[0]!.items).toHaveLength(1);

    // connector 是已知类目但排在 mcu 之后，不会被丢掉。
    const keys = buildLibraryGroups([fake('x', { category: 'connector' }), fake('y', { category: 'mcu', featured: true })], {
      filter: '',
      embeddedRefs: noRefs,
      expanded: noExpanded
    }).map((g) => g.key);
    expect(keys).toEqual(['mcu', 'connector']);
  });
});
