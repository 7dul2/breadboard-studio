import { describe, it, expect } from 'vitest';
import { builtinCatalog, parseModelRef } from '../src/index.js';

describe('built-in catalog', () => {
  it('loads and validates every definition', () => {
    const c = builtinCatalog();
    expect(c.listBoards().map((b) => b.id).sort()).toEqual(['breadboard_400', 'breadboard_400_terminal', 'breadboard_830', 'breadboard_power_strip_25', 'perfboard_5x7', 'perfboard_7x9']);
    const ids = c.listComponents().map((d) => d.id);
    for (const id of ['xiao_esp32s3_sense', 'esp32s3_devkit_generic', 'esp32s3_n16r8_dual_usb', 'oled_0_96_i2c', 'oled_0_96_ssd1315_i2c', 'ttp223_module', 'ttp224_module', 'sht41_breakout', 'bmp390_breakout', 'ltr390_breakout', 'sen66', 'power_module_3v3', 'tft_1_77_st7735_spi', 'encoder_ky040', 'tactile_6x6']) {
      expect(ids).toContain(id);
    }
  });

  it('keeps optional backside artwork without requiring it from older parts', () => {
    const c = builtinCatalog();
    const ttp224 = c.getComponent('ttp224_module@1')!;
    expect(ttp224.body.size_um).toEqual([35000, 29000]);
    expect(ttp224.params_default?.pin_names).toEqual(['VCC', 'GND', 'OUT4', 'OUT3', 'OUT2', 'OUT1']);
    expect(ttp224.back_render?.length).toBeGreaterThan(10);
    const frontText = ttp224.render.filter((primitive) => primitive.t === 'text').map((primitive) => primitive.text);
    const backText = ttp224.back_render!.filter((primitive) => primitive.t === 'text').map((primitive) => primitive.text);
    expect(frontText).not.toContain('1');
    expect(backText).toContain('1');
    expect(c.getComponent('ttp223_module@1')!.back_render).toBeUndefined();
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

  it('models perfboards as independently solderable pads with stable hole labels', () => {
    const c = builtinCatalog();
    const small = c.getBoard('perfboard_5x7@1')!;
    const large = c.getBoard('perfboard_7x9@1')!;
    expect(small.render.style).toBe('perfboard');
    expect(small.pitch_um).toBe(2540);
    expect(small.terminal_blocks).toHaveLength(24);
    expect(small.terminal_blocks.every((block) => block.rows.length === 1)).toBe(true);
    expect(large.terminal_blocks.at(-1)?.rows).toEqual(['AI']);
    expect(large.terminal_blocks.at(-1)?.columns).toBe(27);
    expect(large.rails).toEqual([]);
  });

  it('models KY-040 signals as supply-pulled contacts instead of fixed 3.3 V push-pull outputs', () => {
    const encoder = builtinCatalog().getComponent('encoder_ky040@1')!;
    expect(encoder.electrical.io_voltage_v).toBeNull();
    for (const pin of ['CLK', 'DT', 'SW']) {
      expect(encoder.pin_meta[pin]).toMatchObject({ drive: 'open_drain', io_voltage_v: null });
    }
  });

  it('models the tactile switch as a contact that conducts only while closed', () => {
    const sw = builtinCatalog().getComponent('tactile_6x6@1')!;
    expect(sw.conduction).toEqual([{ kind: 'switch', pins: ['A', 'B'], state_param: 'closed' }]);
    expect(sw.params_default?.closed, 'a placed switch starts open').toBe(false);
    const closed = (sw.params_schema?.properties as Record<string, unknown> | undefined)?.closed;
    expect(closed).toMatchObject({ type: 'boolean' });
  });

  it('reserves the octal-PSRAM lines on exactly the variants that have them', () => {
    const c = builtinCatalog();
    const reservedOf = (ref: string) =>
      Object.entries(c.getComponent(ref)!.pin_meta)
        .filter(([, meta]) => meta.reserved !== undefined)
        .map(([pin]) => pin)
        .sort();

    // Both 44-pin boards are N16R8 by their own `model` field: the 8 MB octal
    // PSRAM owns GPIO35–37 and they are broken out on the header anyway.
    expect(reservedOf('esp32s3_n16r8_dual_usb@1')).toEqual(['GPIO35', 'GPIO36', 'GPIO37']);
    expect(reservedOf('esp32s3_devkit_generic@1')).toEqual(['GPIO35', 'GPIO36', 'GPIO37']);

    // The XIAO has an R8 module too, but its 14-pin header does not bring those
    // lines out — there is nothing to reserve and nothing to address.
    const xiao = c.getComponent('xiao_esp32s3_sense@1')!;
    expect(reservedOf('xiao_esp32s3_sense@1')).toEqual([]);
    expect(Object.values(xiao.simulation!.pins ?? {}).filter((gpio) => typeof gpio === 'number' && gpio >= 35 && gpio <= 37)).toEqual([]);

    // A reserved pin must say why: both the planner and the simulator quote `notes`.
    for (const def of c.listComponents()) {
      for (const [pin, meta] of Object.entries(def.pin_meta)) {
        if (meta.reserved === undefined) continue;
        expect(meta.notes, `${def.id}.${pin}`).toBeTruthy();
      }
    }
  });

  it('keeps search keywords unique and non-empty when present (issue #42)', () => {
    const c = builtinCatalog();
    for (const d of c.listComponents()) {
      if (d.keywords === undefined) continue;
      expect(d.keywords.length, d.id).toBeGreaterThan(0);
      for (const kw of d.keywords) {
        expect(kw.trim(), `${d.id} has blank keyword`).toBe(kw);
        expect(kw.length, `${d.id} has empty keyword`).toBeGreaterThan(0);
      }
      expect(new Set(d.keywords).size, `${d.id} has duplicate keywords`).toBe(d.keywords.length);
    }
    // 入门与精选型号必须带上中文/常见别名，否则搜索扩容白做。
    expect(c.getComponent('led_5mm@1')!.keywords).toEqual(expect.arrayContaining(['LED', '发光二极管']));
    expect(c.getComponent('tactile_6x6@1')!.keywords).toEqual(expect.arrayContaining(['按键', 'button']));
  });

  it('parses model references', () => {
    expect(parseModelRef('breadboard_400@1')).toEqual({ id: 'breadboard_400', version: 1 });
    expect(parseModelRef('breadboard_400')).toBeNull();
    expect(parseModelRef('Breadboard@1')).toBeNull();
  });

  it('marks the curated default view with `featured` instead of hiding the rest', () => {
    const c = builtinCatalog();
    const all = c.list();

    // The library's default view is exactly this set (issue #32). Pinning it here
    // keeps a new definition from silently changing the curated view, and keeps a
    // curated one from silently disappearing behind the fold.
    expect(all.filter((d) => d.featured).map((d) => d.id).sort()).toEqual([
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
    // Featuring everything would make the fold pointless: the curated view has to
    // stay a strict subset as the catalog grows (#30/#31 add more models).
    expect(all.filter((d) => d.featured).length).toBeLessThan(all.length);

    // The models that only appear inside the shipped examples must still be
    // built-ins — nothing may be dropped from the catalog. Search reaches them
    // because the library searches the whole list, folded or not.
    const shipped = ['xiao_esp32s3_sense', 'esp32s3_devkit_generic', 'oled_0_96_i2c', 'power_module_3v3', 'ttp223_module', 'sht41_breakout', 'bmp390_breakout', 'ltr390_breakout', 'sen66'];
    const ids = new Set(all.map((d) => d.id));
    for (const id of shipped) expect(ids.has(id), `${id} 是示例里出镜的型号，不能从内置目录消失`).toBe(true);
  });
});

describe('simulation bindings', () => {
  it('bind controls and visuals to existing feature labels and declare versioned drivers', () => {
    const c = builtinCatalog();
    const withSim = c.listComponents().filter((d) => d.simulation);
    expect(withSim.map((d) => d.id).sort()).toEqual(['bmp390_breakout', 'esp32s3_devkit_generic', 'esp32s3_n16r8_dual_usb', 'led_5mm', 'ltr390_breakout', 'oled_0_91_i2c', 'oled_0_96_i2c', 'oled_0_96_ssd1315_i2c', 'sen66', 'sht41_breakout', 'ttp223_module', 'xiao_esp32s3_sense']);
    for (const d of withSim) {
      const sim = d.simulation!;
      expect(sim.driver, d.id).toMatch(/^[a-z0-9_.-]+@[0-9]+$/);
      const labels = new Set((d.features ?? []).map((f) => f.label));
      const pinNames = new Set(d.pins.length ? d.pins.map((p) => p.name) : Object.keys(d.pin_meta));
      for (const control of sim.controls ?? []) expect(labels.has(control.feature_label), `${d.id} control ${control.id}`).toBe(true);
      for (const visual of sim.visuals ?? []) expect(labels.has(visual.feature_label), `${d.id} visual ${visual.id}`).toBe(true);
      for (const pin of Object.keys(sim.pins ?? {})) expect(pinNames.has(pin), `${d.id} pin ${pin}`).toBe(true);
      const ids = [...(sim.controls ?? []), ...(sim.visuals ?? [])].map((b) => b.id);
      expect(new Set(ids).size, d.id).toBe(ids.length);
    }
    const n16r8 = c.getComponent('esp32s3_n16r8_dual_usb@1')!;
    expect(n16r8.simulation).toMatchObject({ driver: 'mcu.esp32s3.behavioral@1', pins: expect.objectContaining({ GPIO0: 0, GPIO48: 48, TX: 43, RX: 44 }) });
    expect(n16r8.simulation!.controls!.map((x) => x.feature_label)).toEqual(['BOOT', 'RST']);
    expect(n16r8.features!.find((f) => f.type === 'led')).toMatchObject({ label: 'RGB' });
    expect(c.getComponent('ttp223_module@1')!.simulation!.controls![0]).toMatchObject({ action: 'touch', channel: 'touch' });
    expect(c.getComponent('oled_0_96_ssd1315_i2c@1')!.simulation!.visuals![0]).toMatchObject({ kind: 'display', feature_label: '128×64 OLED' });
  });
});
