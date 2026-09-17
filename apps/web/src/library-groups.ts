/**
 * Grouping rules for the parts library (issue #32).
 *
 * The library used to be a hardcoded `VISIBLE_BUILTIN_IDS` whitelist that
 * quietly hid every model the catalog added after the initial demo set. The
 * rules now live in the data: a definition marks itself `featured` to appear in
 * the default view, everything else is folded behind a per-category toggle.
 * Search always scans the whole catalog, so folding never loses a part.
 *
 * This module is pure so the behaviour is unit-testable without a browser.
 */
import type { CatalogDefinition } from '@breadboard-studio/schema';

/** Display order of the library's category groups. */
const LIBRARY_CATEGORY_ORDER = [
  'board_integrated',
  'board_modular',
  'board_perfboard',
  'mcu',
  'display',
  'input',
  'sensor',
  'power',
  'passive',
  'connector',
  'other'
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  board_integrated: '面包板 · 一体式',
  board_modular: '面包板 · 可拆拼装式',
  board_perfboard: '洞洞板',
  mcu: '主控',
  display: '显示',
  sensor: '传感器',
  input: '输入',
  power: '电源',
  passive: '基础元件',
  connector: '连接器',
  other: '其他'
};

/** Label of the fold that hides non-featured built-ins inside one category. */
export const MORE_LABEL = '更多内置型号';

export interface LibraryGroup {
  key: string;
  /** Parts rendered directly: featured, embedded in the design, or a search hit. */
  items: CatalogDefinition[];
  /** Non-featured built-ins hidden behind the toggle. Empty while searching. */
  folded: CatalogDefinition[];
  /** Every non-featured built-in in this category, open or not (for the toggle count). */
  foldedTotal: number;
}

export interface LibraryGroupsOptions {
  /** Raw search box text. Non-empty turns off folding and scans the whole catalog. */
  filter: string;
  /** `${id}@${version}` of definitions embedded in the current design — always pinned visible. */
  embeddedRefs: ReadonlySet<string>;
  /** Category keys whose fold the user opened this session. */
  expanded: ReadonlySet<string>;
}

export function modelRef(def: { id: string; version: number }): string {
  return `${def.id}@${def.version}`;
}

/** How many built-in definitions the default (unfiltered) view folds away. */
export function foldedBuiltinCount(defs: CatalogDefinition[], embeddedRefs: ReadonlySet<string>): number {
  return defs.filter((def) => def.featured !== true && !embeddedRefs.has(modelRef(def))).length;
}

/**
 * Board definitions have no `category`. Perfboards are picked by render style;
 * the spliceable middle boards are still an id list, so a **new** spliceable
 * model must be added here or it silently lands in `board_integrated`. Giving
 * `BoardDefinition` its own `category`/`spliceable` field would remove this
 * (noted in the #32 review — out of scope for the library refactor).
 */
export function libraryCategoryKey(def: CatalogDefinition): string {
  if (def.kind !== 'board') return def.category;
  if (def.render.style === 'perfboard') return 'board_perfboard';
  if (def.id === 'breadboard_400_terminal' || def.id === 'breadboard_power_strip_25') return 'board_modular';
  return 'board_integrated';
}

function matchesFilter(def: CatalogDefinition, query: string): boolean {
  // id / name / model stay first-class; manufacturer and keywords cover the
  // Chinese names, nicknames and part numbers users actually type (issue #42).
  const parts = [def.id, def.name, def.model ?? '', def.manufacturer ?? ''];
  if (def.kind === 'component' && def.keywords) parts.push(...def.keywords);
  return parts.join(' ').toLowerCase().includes(query);
}

/** Featured first, original catalog order otherwise (Array#sort is stable). */
function featuredFirst(items: CatalogDefinition[]): CatalogDefinition[] {
  return [...items].sort((a, b) => Number(b.featured === true) - Number(a.featured === true));
}

function orderedKeys(keys: Iterable<string>): string[] {
  const order = new Map<string, number>(LIBRARY_CATEGORY_ORDER.map((key, i) => [key, i]));
  return [...keys].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
}

export function buildLibraryGroups(defs: CatalogDefinition[], opts: LibraryGroupsOptions): LibraryGroup[] {
  const query = opts.filter.trim().toLowerCase();
  const buckets = new Map<string, { items: CatalogDefinition[]; folded: CatalogDefinition[] }>();
  const bucket = (key: string) => {
    const found = buckets.get(key);
    if (found) return found;
    const created = { items: [] as CatalogDefinition[], folded: [] as CatalogDefinition[] };
    buckets.set(key, created);
    return created;
  };

  if (query) {
    // Searching is a lookup over the entire catalog: a folded part must still be
    // findable, and results read better without an extra click.
    for (const def of defs) if (matchesFilter(def, query)) bucket(libraryCategoryKey(def)).items.push(def);
    return orderedKeys(buckets.keys())
      .map((key) => ({ key, items: featuredFirst(buckets.get(key)!.items), folded: [], foldedTotal: 0 }))
      .filter((group) => group.items.length > 0);
  }

  for (const def of defs) {
    const target = bucket(libraryCategoryKey(def));
    const pinned = def.featured === true || opts.embeddedRefs.has(modelRef(def));
    if (pinned) target.items.push(def);
    else target.folded.push(def);
  }

  return orderedKeys(buckets.keys()).map((key) => {
    const { items, folded } = buckets.get(key)!;
    return {
      key,
      items: featuredFirst(items),
      // Folded items are still mounted once the fold is open, so the badge and
      // "add" flow work exactly like a featured card.
      folded: opts.expanded.has(key) ? folded : [],
      foldedTotal: folded.length
    };
  }).filter((group) => group.items.length > 0 || group.foldedTotal > 0);
}
