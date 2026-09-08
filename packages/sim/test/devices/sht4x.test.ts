import { describe, expect, it } from 'vitest';
import { createSht4xDriver, humidityTicks, sht4xCrc, temperatureTicks, SHT4X_DRIVER_ID } from '../../src/devices/sht4x.js';
import type { SimDeviceSpec } from '../../src/types.js';
import { createDeviceHarness } from './harness.js';

const ADDR = 0x44;
const MEASURE_HIGH = 0xfd;

function spec(overrides: Partial<SimDeviceSpec> = {}): SimDeviceSpec {
  return {
    componentId: 'sht',
    model: 'sht41_breakout@1',
    driver: SHT4X_DRIVER_ID,
    pinNets: { SDA: 'net_sda', SCL: 'net_scl' },
    pinChannels: { SDA: 'sda', SCL: 'scl' },
    properties: { i2c_address: ADDR },
    i2c: { role: 'device', buses: [{ index: 0, sdaPin: 'SDA', sclPin: 'SCL', sdaNet: 'net_sda', sclNet: 'net_scl' }], address: ADDR },
    controls: [
      { id: 'temperature', featureLabel: '传感器', action: 'slider', channel: 'temperature_c', range: { min: -40, max: 125, step: 0.1, default: 25, unit: '°C' } },
      { id: 'humidity', featureLabel: '传感器', action: 'slider', channel: 'humidity_rh', range: { min: 0, max: 100, step: 0.1, default: 50, unit: '%RH' } }
    ],
    ...overrides
  };
}

function build(overrides: Partial<SimDeviceSpec> = {}) {
  const harness = createDeviceHarness({ spec: spec(overrides) });
  const driver = harness.bind(createSht4xDriver(harness.ctx));
  return { harness, driver };
}

/** Decode the six bytes the way a program using the datasheet formulas would. */
function decode(bytes: Uint8Array): { celsius: number; humidity: number } {
  const t = (bytes[0]! << 8) | bytes[1]!;
  const rh = (bytes[3]! << 8) | bytes[4]!;
  return { celsius: -45 + (175 * t) / 65535, humidity: -6 + (125 * rh) / 65535 };
}

describe('sensor.sht4x@1', () => {
  it('registers on the bus at its configured address', () => {
    const { harness, driver } = build();
    expect(driver.driverId).toBe(SHT4X_DRIVER_ID);
    expect(harness.i2cAttachments).toEqual([{ sdaPin: 'SDA', sclPin: 'SCL', addresses: [ADDR] }]);
  });

  it('will not answer a read before the conversion has finished', () => {
    const { harness, driver } = build();
    expect(driver.onI2cRead!(ADDR, 6), 'no command was sent at all').toBeNull();
    expect(harness.codes()).toEqual(['i2c_nack']);
    expect(harness.diagnostics[0]!.message).toContain('0xFD');

    expect(driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true)).toBe('ack');
    harness.advance(8000);
    expect(driver.onI2cRead!(ADDR, 6), '8.0 ms in, the 8.3 ms conversion is not done').toBeNull();
    expect(harness.diagnostics.some((d) => d.message.includes('await sleep(10)'))).toBe(true);

    harness.advance(400);
    const bytes = driver.onI2cRead!(ADDR, 6);
    expect(bytes, 'past 8.3 ms it answers').not.toBeNull();
    expect(bytes!.length).toBe(6);
  });

  it('reports what the sliders say, with the datasheet encoding and CRC', () => {
    const { harness, driver } = build();
    driver.onControl!('temperature_c', 'slider', 21.5);
    driver.onControl!('humidity_rh', 'slider', 63.25);

    driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true);
    harness.advance(10_000);
    const bytes = driver.onI2cRead!(ADDR, 6)!;

    const { celsius, humidity } = decode(bytes);
    expect(celsius).toBeCloseTo(21.5, 2);
    expect(humidity).toBeCloseTo(63.25, 2);
    // the checksums are the ones a driver on the other end would verify
    expect(bytes[2]).toBe(sht4xCrc([bytes[0]!, bytes[1]!]));
    expect(bytes[5]).toBe(sht4xCrc([bytes[3]!, bytes[4]!]));
  });

  it('samples when the command arrives, not when the read does', () => {
    const { harness, driver } = build();
    driver.onControl!('temperature_c', 'slider', 10);
    driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true);
    // the world changes mid-conversion; the measurement already happened
    driver.onControl!('temperature_c', 'slider', 90);
    harness.advance(10_000);
    expect(decode(driver.onI2cRead!(ADDR, 6)!).celsius).toBeCloseTo(10, 2);

    // the next measurement does see the new value
    driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true);
    harness.advance(10_000);
    expect(decode(driver.onI2cRead!(ADDR, 6)!).celsius).toBeCloseTo(90, 2);
  });

  it('holds a slider inside the range the catalog declares', () => {
    const { harness, driver } = build();
    driver.onControl!('temperature_c', 'slider', 999);
    driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true);
    harness.advance(10_000);
    expect(decode(driver.onI2cRead!(ADDR, 6)!).celsius).toBeCloseTo(125, 1);

    driver.onControl!('humidity_rh', 'slider', -50);
    driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true);
    harness.advance(10_000);
    expect(decode(driver.onI2cRead!(ADDR, 6)!).humidity).toBeCloseTo(0, 1);
  });

  it('starts at the catalog default rather than at zero', () => {
    const { harness, driver } = build();
    driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true);
    harness.advance(10_000);
    const { celsius, humidity } = decode(driver.onI2cRead!(ADDR, 6)!);
    expect(celsius).toBeCloseTo(25, 1);
    expect(humidity).toBeCloseTo(50, 1);
  });

  it('answers a probe, accepts heater and reset, and warns once about a command it does not know', () => {
    const { harness, driver } = build();
    expect(driver.onI2cWrite!(ADDR, new Uint8Array(0), true)).toBe('ack');
    expect(driver.onI2cWrite!(ADDR, Uint8Array.from([0x39]), true), 'heater on').toBe('ack');
    expect(harness.codes(), 'a documented command is not a warning').toEqual([]);

    // a soft reset throws away a measurement in flight
    driver.onI2cWrite!(ADDR, Uint8Array.from([MEASURE_HIGH]), true);
    driver.onI2cWrite!(ADDR, Uint8Array.from([0x94]), true);
    harness.advance(10_000);
    expect(driver.onI2cRead!(ADDR, 6)).toBeNull();

    for (let i = 0; i < 10; i++) driver.onI2cWrite!(ADDR, Uint8Array.from([0x7f]), true);
    expect(harness.codes().filter((c) => c === 'i2c_unknown_command')).toHaveLength(1);
  });

  it('pins the datasheet conversions, so a correction has to break a test', () => {
    expect(temperatureTicks(-45)).toBe(0);
    expect(temperatureTicks(130)).toBe(65535);
    expect(temperatureTicks(25)).toBe(Math.round((70 * 65535) / 175));
    expect(humidityTicks(-6)).toBe(0);
    expect(humidityTicks(119)).toBe(65535);
    // CRC-8/NRSC-5: poly 0x31, init 0xFF. 0xBEEF is the datasheet's worked example byte pair.
    expect(sht4xCrc([0xbe, 0xef])).toBe(0x92);
    expect(sht4xCrc([0x00, 0x00])).toBe(0x81);
  });
});
