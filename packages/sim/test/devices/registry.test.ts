import { describe, it, expect } from 'vitest';
import type { DeviceContext, DeviceDriver } from '../../src/contracts.js';
import type { SimDeviceSpec } from '../../src/types.js';
import { BUILTIN_DRIVERS, builtinDrivers } from '../../src/devices/registry.js';
import { ESP32S3_DRIVER_ID, Esp32S3Driver } from '../../src/devices/esp32s3.js';
import { TTP223_DRIVER_ID } from '../../src/devices/ttp223.js';
import { SSD1315_DRIVER_ID } from '../../src/devices/ssd1315.js';
import { LED_DRIVER_ID } from '../../src/devices/led.js';
import { SHT4X_DRIVER_ID } from '../../src/devices/sht4x.js';
import { LTR390_DRIVER_ID } from '../../src/devices/ltr390.js';
import { SEN6X_DRIVER_ID } from '../../src/devices/sen6x.js';
import { createDeviceHarness, fixtureSpec } from './harness.js';

/** Every key `DeviceContext` documents — and nothing that reaches another device. */
const CONTEXT_KEYS = [
  'componentId',
  'spec',
  'nowUs',
  'random',
  'drive',
  'release',
  'read',
  'watch',
  'netIdOf',
  'power',
  'after',
  'cancel',
  'visual',
  'serial',
  'diagnose',
  'diagnoseOnce',
  'attachI2c'
];

function specWith(patch: Partial<SimDeviceSpec>): SimDeviceSpec {
  return { componentId: 'x', model: 'test@1', driver: null, pinNets: {}, pinChannels: { P1: 1 }, properties: {}, ...patch };
}

describe('driver registry', () => {
  it('R1 creates the built-in ESP32-S3 driver for an exactly matching driver id', () => {
    const registry = builtinDrivers();
    expect(registry.has(ESP32S3_DRIVER_ID)).toBe(true);
    expect(registry.ids()).toEqual(Object.keys(BUILTIN_DRIVERS).sort());
    expect(registry.ids()).toContain('mcu.esp32s3.behavioral@1');

    const harness = createDeviceHarness({ spec: fixtureSpec('mcu') });
    const driver = registry.create(harness.ctx);
    expect(driver).toBeInstanceOf(Esp32S3Driver);
    expect(driver?.driverId).toBe(ESP32S3_DRIVER_ID);
  });

  it('R2 matches driver ids as whole strings, version suffix included', () => {
    const registry = builtinDrivers();
    for (const id of ['mcu.esp32s3.behavioral@2', 'mcu.esp32s3.behavioral', 'mcu.esp32s3.behavioral@1 ', 'MCU.ESP32S3.BEHAVIORAL@1']) {
      expect(registry.has(id), id).toBe(false);
      const harness = createDeviceHarness({ spec: specWith({ driver: id }) });
      expect(registry.create(harness.ctx), id).toBeNull();
    }
  });

  it('R3 creates no driver for a component without one, leaving it a passive endpoint', () => {
    const registry = builtinDrivers();
    for (const driver of [null, '']) {
      const harness = createDeviceHarness({ spec: specWith({ driver }) });
      expect(registry.create(harness.ctx)).toBeNull();
      // Nothing was constructed, so nothing drove a pin or published anything.
      expect(harness.drives).toHaveLength(0);
      expect(harness.visuals).toHaveLength(0);
      expect(harness.diagnostics).toHaveLength(0);
    }
  });

  it('R4 hands a driver exactly the documented context, with no way to reach another device', () => {
    const harness = createDeviceHarness({ spec: fixtureSpec('mcu') });
    expect(Object.keys(harness.ctx).sort()).toEqual([...CONTEXT_KEYS].sort());
    for (const forbidden of ['getDevice', 'membersOf', 'devicesOn', 'nets', 'snapshot']) {
      expect(forbidden in harness.ctx, forbidden).toBe(false);
    }
    expect(harness.ctx.componentId).toBe('mcu');
    expect(Object.isFrozen(harness.ctx.spec)).toBe(true);
  });

  it('R5 throws when a driver touches a pin that is not its own', () => {
    const harness = createDeviceHarness({ spec: fixtureSpec('mcu') });
    const ctx: DeviceContext = harness.ctx;
    expect(() => ctx.drive('SDA', 0)).toThrow(/not a pin of mcu/);
    expect(() => ctx.release('SDA')).toThrow(/not a pin of mcu/);
    expect(() => ctx.read('SDA')).toThrow(/not a pin of mcu/);
    expect(() => ctx.watch('SDA')).toThrow(/not a pin of mcu/);
    expect(() => ctx.netIdOf('SDA')).toThrow(/not a pin of mcu/);
    expect(() => ctx.drive('GPIO4', 0)).not.toThrow();
  });

  it('R6 lists every built-in driver, and an override replaces one without adding to the table', () => {
    const created: string[] = [];
    const stub = (id: string) => (ctx: DeviceContext): DeviceDriver => {
      created.push(`${id}:${ctx.componentId}`);
      return { driverId: id };
    };
    const registry = builtinDrivers({ 'input.ttp223@1': stub('input.ttp223@1'), 'display.ssd1315@1': stub('display.ssd1315@1') });
    expect(registry.ids()).toEqual(['display.ssd1315@1', 'input.ttp223@1', 'mcu.esp32s3.behavioral@1', 'output.led@1', 'sensor.ltr390@1', 'sensor.sen6x@1', 'sensor.sht4x@1']);

    const touch = createDeviceHarness({ spec: fixtureSpec('touch') });
    const oled = createDeviceHarness({ spec: fixtureSpec('oled') });
    expect(registry.create(touch.ctx)?.driverId).toBe('input.ttp223@1');
    expect(registry.create(oled.ctx)?.driverId).toBe('display.ssd1315@1');
    expect(created).toEqual(['input.ttp223@1:touch', 'display.ssd1315@1:oled']);
    // The built-in table itself is untouched by the extras, and now holds all three
    // v0.2 drivers: the MCU (M-S1), the TTP223 (M-S2), the OLED (M-S3) and the LED.
    expect(Object.keys(BUILTIN_DRIVERS)).toEqual([ESP32S3_DRIVER_ID, TTP223_DRIVER_ID, SSD1315_DRIVER_ID, LED_DRIVER_ID, SHT4X_DRIVER_ID, LTR390_DRIVER_ID, SEN6X_DRIVER_ID]);
  });

  it('R7 exposes net ids as opaque strings, equal only when the pins really share a net', () => {
    const harness = createDeviceHarness({ spec: fixtureSpec('mcu') });
    const ctx = harness.ctx;
    expect(ctx.netIdOf('GND_1')).toBe(ctx.netIdOf('GND_3'));
    expect(ctx.netIdOf('GPIO8')).not.toBe(ctx.netIdOf('GPIO9'));
    // Unwired pins get a private single-point net rather than a missing key.
    expect(ctx.netIdOf('GPIO48')).toBe('unconnected:mcu.GPIO48');
    expect(ctx.spec.pinNets.GPIO48).toBeUndefined();
  });
});
