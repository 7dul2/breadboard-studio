import { describe, it, expect } from 'vitest';
import { builtinCatalog, parseModelRef } from '../src/index.js';

describe('built-in catalog', () => {
  it('loads and validates every definition', () => {
    const c = builtinCatalog();
    expect(c.listBoards().map((b) => b.id).sort()).toEqual(['breadboard_400', 'breadboard_400_terminal', 'breadboard_830', 'breadboard_power_strip_25']);
    const ids = c.listComponents().map((d) => d.id);
    for (const id of ['xiao_esp32s3_sense', 'esp32s3_devkit_generic', 'esp32s3_n16r8_dual_usb', 'oled_0_96_i2c', 'oled_0_96_ssd1315_i2c', 'ttp223_module', 'sht41_breakout', 'bmp390_breakout', 'ltr390_breakout', 'sen66', 'power_module_3v3', 'tft_1_77_st7735_spi', 'encoder_ky040', 'tactile_6x6']) {
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

  it('models KY-040 signals as supply-pulled contacts instead of fixed 3.3 V push-pull outputs', () => {
    const encoder = builtinCatalog().getComponent('encoder_ky040@1')!;
    expect(encoder.electrical.io_voltage_v).toBeNull();
    for (const pin of ['CLK', 'DT', 'SW']) {
      expect(encoder.pin_meta[pin]).toMatchObject({ drive: 'open_drain', io_voltage_v: null });
    }
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

  it('parses model references', () => {
    expect(parseModelRef('breadboard_400@1')).toEqual({ id: 'breadboard_400', version: 1 });
    expect(parseModelRef('breadboard_400')).toBeNull();
    expect(parseModelRef('Breadboard@1')).toBeNull();
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
