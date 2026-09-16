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
    const folded = all.flatMap((g) => g.foldedTotal);

    // 精选型号 = 改造前白名单里的那 12 个，一个不少。
    expect(shown.sort()).toEqual([
      'breadboard_400',
      'breadboard_400_terminal',
      'breadboard_830',
      'breadboard_power_strip_25',
      'encoder_ky040',
      'esp32s3_n16r8_dual_usb',
      'oled_0_96_ssd1315_i2c',
      'perfboard_5x7',
      'perfboard_7x9',
      'tactile_6x6',
      'tft_1_77_st7735_spi',
      'ttp224_module'
    ]);
    // 其余内置型号没有消失，只是折叠了。
    expect(folded.reduce((a, b) => a + b, 0)).toBe(defs.length - shown.length);
    expect(all.every((g) => g.folded.length === 0)).toBe(true);
  });

  it('展开某个类目后，该类目的折叠型号进入列表，其他类目不受影响', () => {
    const before = group('sensor');
    expect(before.items).toEqual([]);
    expect(before.foldedTotal).toBeGreaterThan(0);

    const after = group('sensor', '', new Set(['sensor']));
    expect(ids(after.folded).sort()).toEqual(['bmp390_breakout', 'ltr390_breakout', 'sen66', 'sht41_breakout']);
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
    expect(keys).toEqual(['board_integrated', 'board_modular', 'board_perfboard', 'mcu', 'display', 'input', 'sensor', 'power', 'passive']);  });

  it('modelRef 拼出可比较的引用', () => {
    expect(modelRef({ id: 'led_5mm', version: 1 })).toBe('led_5mm@1');
  });

  it('折叠数量只数「内置且非精选」的定义', () => {
    expect(foldedBuiltinCount(defs, noRefs)).toBe(12);
    // 内嵌定义不算内置，也不进折叠计数。
    expect(foldedBuiltinCount(defs, new Set(['power_module_3v3@1']))).toBe(11);
  });
});
