import { describe, it, expect } from 'vitest';
import { builtinCatalog, parseModelRef } from '../src/index.js';

describe('built-in catalog', () => {
  it('loads and validates every definition', () => {
    const c = builtinCatalog();
    expect(c.listBoards().map((b) => b.id).sort()).toEqual(['breadboard_400', 'breadboard_830']);
    const ids = c.listComponents().map((d) => d.id);
    for (const id of ['xiao_esp32s3_sense', 'esp32s3_devkit_generic', 'oled_0_96_i2c', 'ttp223_module', 'sht41_breakout', 'bmp390_breakout', 'ltr390_breakout', 'sen66', 'power_module_3v3']) {
      expect(ids).toContain(id);
    }
  });

  it('records evidence status separately for geometry and electrical data', () => {
    const c = builtinCatalog();
    for (const d of c.list()) {
      expect(['verified', 'approximate', 'unknown']).toContain(d.geometry_status);
      expect(['verified', 'approximate', 'unknown']).toContain(d.electrical_status);
      expect(d.sources.length).toBeGreaterThan(0);
      expect(d.license.spdx).toBeTruthy();
    }
    // Nothing in v0.1 has been physically verified; the catalog must not claim otherwise.
    const xiao = c.getComponent('xiao_esp32s3_sense@1')!;
    expect(xiao.geometry_status).toBe('approximate');
  });

  it('parses model references', () => {
    expect(parseModelRef('breadboard_400@1')).toEqual({ id: 'breadboard_400', version: 1 });
    expect(parseModelRef('breadboard_400')).toBeNull();
    expect(parseModelRef('Breadboard@1')).toBeNull();
  });
});
