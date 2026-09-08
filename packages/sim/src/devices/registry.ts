/**
 * Driver registry (plan §7.1).
 *
 * Driver ids are matched as whole strings, `@1` included: a design asking for
 * `mcu.esp32s3.behavioral@2` gets no driver rather than the v1 behaviour. A
 * component whose `driver` is null or unknown simply has no driver — it stays a
 * passive electrical endpoint, and the caller reports it once with
 * `unsupported_device` (info) instead of failing the whole session.
 *
 * The built-in drivers: the MCU, the TTP223, the OLED, the discrete LED and the
 * SHT4x / LTR390 / SEN6x sensors.
 */
import type { DeviceContext, DeviceDriver, DeviceFactory, DriverRegistry } from '../contracts.js';
import { ESP32S3_DRIVER_ID, createEsp32S3Driver } from './esp32s3.js';
import { LED_DRIVER_ID, createLedDriver } from './led.js';
import { LTR390_DRIVER_ID, createLtr390Driver } from './ltr390.js';
import { SEN6X_DRIVER_ID, createSen6xDriver } from './sen6x.js';
import { SHT4X_DRIVER_ID, createSht4xDriver } from './sht4x.js';
import { SSD1315_DRIVER_ID, createSsd1315Driver } from './ssd1315.js';
import { TTP223_DRIVER_ID, createTtp223Driver } from './ttp223.js';

export const BUILTIN_DRIVERS: Readonly<Record<string, DeviceFactory>> = Object.freeze({
  [ESP32S3_DRIVER_ID]: createEsp32S3Driver,
  [TTP223_DRIVER_ID]: createTtp223Driver,
  [SSD1315_DRIVER_ID]: createSsd1315Driver,
  [LED_DRIVER_ID]: createLedDriver,
  [SHT4X_DRIVER_ID]: createSht4xDriver,
  [LTR390_DRIVER_ID]: createLtr390Driver,
  [SEN6X_DRIVER_ID]: createSen6xDriver
});

/**
 * A registry over the built-in table. `extra` is for tests and for future
 * out-of-tree drivers; it never rewrites a built-in id silently — an entry with
 * the same id wins, which is what a test double wants.
 */
export function builtinDrivers(extra?: Readonly<Record<string, DeviceFactory>>): DriverRegistry {
  const table = new Map<string, DeviceFactory>(Object.entries({ ...BUILTIN_DRIVERS, ...(extra ?? {}) }));
  const ids = Object.freeze([...table.keys()].sort());
  return {
    has: (id: string) => table.has(id),
    ids: () => ids,
    create(ctx: DeviceContext): DeviceDriver | null {
      const id = ctx.spec.driver;
      if (typeof id !== 'string' || id.length === 0) return null;
      const factory = table.get(id);
      return factory === undefined ? null : factory(ctx);
    }
  };
}
