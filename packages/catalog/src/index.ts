/**
 * Built-in catalog of boards and components.
 *
 * Definitions are plain JSON files in ./definitions. To add a new part, drop a
 * JSON file there and add one import + one entry in the arrays below; the file
 * is validated against the definition schema by the catalog tests.
 */
import type { BoardDefinition, ComponentDefinition, CatalogDefinition } from '@breadboard-studio/schema';
import { validateBoardDefinition, validateComponentDefinition } from '@breadboard-studio/schema';

import breadboard400 from './definitions/breadboard_400.json';
import breadboard400Terminal from './definitions/breadboard_400_terminal.json';
import breadboardPowerStrip25 from './definitions/breadboard_power_strip_25.json';
import breadboard830 from './definitions/breadboard_830.json';
import xiaoEsp32s3Sense from './definitions/xiao_esp32s3_sense.json';
import esp32s3DevkitGeneric from './definitions/esp32s3_devkit_generic.json';
import esp32s3N16r8DualUsb from './definitions/esp32s3_n16r8_dual_usb.json';
import oled096 from './definitions/oled_0_96_i2c.json';
import oled096Ssd1315 from './definitions/oled_0_96_ssd1315_i2c.json';
import oled091 from './definitions/oled_0_91_i2c.json';
import ttp223 from './definitions/ttp223_module.json';
import ttp224 from './definitions/ttp224_module.json';
import sht41 from './definitions/sht41_breakout.json';
import bmp390 from './definitions/bmp390_breakout.json';
import ltr390 from './definitions/ltr390_breakout.json';
import sen66 from './definitions/sen66.json';
import powerModule from './definitions/power_module_3v3.json';
import resistor from './definitions/resistor_axial.json';
import led from './definitions/led_5mm.json';
import tft177St7735Spi from './definitions/tft_1_77_st7735_spi.json';
import encoderKy040 from './definitions/encoder_ky040.json';
import tactile6x6 from './definitions/tactile_6x6.json';

export const CATALOG_ID = 'builtin';
export const CATALOG_VERSION = '0.1.0';

const rawBoards: unknown[] = [breadboard400, breadboard830, breadboard400Terminal, breadboardPowerStrip25];
const rawComponents: unknown[] = [
  xiaoEsp32s3Sense,
  esp32s3DevkitGeneric,
  esp32s3N16r8DualUsb,
  oled096,
  oled096Ssd1315,
  oled091,
  ttp223,
  ttp224,
  sht41,
  bmp390,
  ltr390,
  sen66,
  powerModule,
  resistor,
  led,
  tft177St7735Spi,
  encoderKy040,
  tactile6x6
];

export interface ModelRef {
  id: string;
  version: number;
}

export function parseModelRef(ref: string): ModelRef | null {
  const m = /^([a-z0-9_]+)@([0-9]+)$/.exec(ref);
  if (!m) return null;
  return { id: m[1]!, version: Number(m[2]) };
}

export function formatModelRef(def: { id: string; version: number }): string {
  return `${def.id}@${def.version}`;
}

export class CatalogError extends Error {}

/**
 * A catalog resolves `<id>@<version>` references. Embedded definitions in a
 * design and user-imported definitions take precedence over built-ins with the
 * same id@version, so an exported design keeps rendering identically after a
 * catalog upgrade.
 */
export class Catalog {
  private boards = new Map<string, BoardDefinition>();
  private components = new Map<string, ComponentDefinition>();

  constructor(defs: CatalogDefinition[] = []) {
    for (const d of defs) this.add(d);
  }

  add(def: CatalogDefinition): void {
    const key = formatModelRef(def);
    if (def.kind === 'board') this.boards.set(key, def);
    else this.components.set(key, def);
  }

  /** Validate and add an untrusted definition object (user import / embedded catalog). */
  addUnknown(raw: unknown): { ok: true; def: CatalogDefinition } | { ok: false; issues: { path: string; message: string }[] } {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind === 'board') {
      const r = validateBoardDefinition(raw);
      if (!r.ok || !r.value) return { ok: false, issues: r.issues };
      this.add(r.value);
      return { ok: true, def: r.value };
    }
    if (kind === 'component') {
      const r = validateComponentDefinition(raw);
      if (!r.ok || !r.value) return { ok: false, issues: r.issues };
      this.add(r.value);
      return { ok: true, def: r.value };
    }
    return { ok: false, issues: [{ path: '/kind', message: 'kind must be "board" or "component"' }] };
  }

  /** Create a child catalog that overlays extra definitions on top of this one. */
  overlay(defs: CatalogDefinition[]): Catalog {
    const c = new Catalog([...this.boards.values(), ...this.components.values()]);
    for (const d of defs) c.add(d);
    return c;
  }

  getBoard(ref: string): BoardDefinition | undefined {
    return this.boards.get(ref);
  }

  getComponent(ref: string): ComponentDefinition | undefined {
    return this.components.get(ref);
  }

  get(ref: string): CatalogDefinition | undefined {
    return this.boards.get(ref) ?? this.components.get(ref);
  }

  listBoards(): BoardDefinition[] {
    return [...this.boards.values()];
  }

  listComponents(): ComponentDefinition[] {
    return [...this.components.values()];
  }

  list(): CatalogDefinition[] {
    return [...this.boards.values(), ...this.components.values()];
  }
}

let builtin: Catalog | null = null;

/** Built-in catalog. Definitions are schema-validated once on first use. */
export function builtinCatalog(): Catalog {
  if (builtin) return builtin;
  const c = new Catalog();
  for (const raw of rawBoards) {
    const r = validateBoardDefinition(raw);
    if (!r.ok || !r.value) throw new CatalogError(`built-in board definition invalid: ${JSON.stringify(r.issues)}`);
    c.add(r.value);
  }
  for (const raw of rawComponents) {
    const r = validateComponentDefinition(raw);
    if (!r.ok || !r.value) {
      const id = (raw as { id?: string }).id;
      throw new CatalogError(`built-in component definition ${id} invalid: ${JSON.stringify(r.issues)}`);
    }
    c.add(r.value);
  }
  builtin = c;
  return c;
}

export const rawDefinitions = { boards: rawBoards, components: rawComponents };
