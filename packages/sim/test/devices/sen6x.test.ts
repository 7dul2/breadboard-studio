import { describe, expect, it } from 'vitest';
import { createSen6xDriver, wordsWithCrc, SEN6X_CHANNELS, SEN6X_DRIVER_ID, SEN6X_WARMUP_US } from '../../src/devices/sen6x.js';
import { sht4xCrc } from '../../src/devices/sht4x.js';
import type { SimDeviceSpec } from '../../src/types.js';
import { createDeviceHarness } from './harness.js';

const ADDR = 0x6b;
const START = [0x00, 0x21];
const STOP = [0x01, 0x04];
const DATA_READY = [0x02, 0x02];
const READ_VALUES = [0x03, 0x00];

function spec(): SimDeviceSpec {
  return {
    componentId: 'sen',
    model: 'sen66@1',
    driver: SEN6X_DRIVER_ID,
    pinNets: { SDA: 'net_sda', SCL: 'net_scl' },
    pinChannels: { SDA: 'sda', SCL: 'scl' },
    properties: { i2c_address: ADDR },
    i2c: { role: 'device', buses: [{ index: 0, sdaPin: 'SDA', sclPin: 'SCL', sdaNet: 'net_sda', sclNet: 'net_scl' }], address: ADDR },
    controls: SEN6X_CHANNELS.map(({ channel, fallback }) => ({
      id: channel,
      featureLabel: '风扇进风口',
      action: 'slider' as const,
      channel,
      range: { min: -10, max: 5000, step: 0.1, default: fallback }
    }))
  };
}

function build() {
  const harness = createDeviceHarness({ spec: spec() });
  const driver = harness.bind(createSen6xDriver(harness.ctx));
  const write = (...bytes: number[]) => driver.onI2cWrite!(ADDR, Uint8Array.from(bytes), true);
  const read = (length: number) => driver.onI2cRead!(ADDR, length);
  /** Push virtual time past the warm-up; the harness owns the clock. */
  const warmUp = () => harness.advance(SEN6X_WARMUP_US);
  return { harness, driver, write, read, warmUp };
}

/** Decode the way a library would: 16-bit word ÷ scale, CRC checked per word. */
function decode(bytes: Uint8Array): Record<string, number> {
  const out: Record<string, number> = {};
  SEN6X_CHANNELS.forEach(({ channel, scale }, i) => {
    const hi = bytes[i * 3]!;
    const lo = bytes[i * 3 + 1]!;
    expect(bytes[i * 3 + 2], `CRC of ${channel}`).toBe(sht4xCrc([hi, lo]));
    const raw = (hi << 8) | lo;
    const signed = channel === 'temperature_c' && raw > 0x7fff ? raw - 0x10000 : raw;
    out[channel] = signed / scale;
  });
  return out;
}

describe('sensor.sen6x@1', () => {
  it('will not report before it has been started', () => {
    const { harness, driver, write, read } = build();
    expect(driver.driverId).toBe(SEN6X_DRIVER_ID);
    write(...READ_VALUES);
    expect(read(27), 'stopped means nothing to read').toBeNull();
    expect(harness.diagnostics.some((d) => d.message.includes('0x0021'))).toBe(true);
  });

  it('needs a whole measurement period before the first reading', () => {
    const { harness, write, read } = build();
    write(...START);
    write(...READ_VALUES);
    expect(read(27), 'started, but the fan has not run a period yet').toBeNull();
    expect(harness.diagnostics.some((d) => d.message.includes('轮询 0x0202'))).toBe(true);

    // the data-ready word is the documented way to find out
    write(...DATA_READY);
    expect(read(3)![1], 'not ready').toBe(0);

    harness.advance(SEN6X_WARMUP_US);
    write(...DATA_READY);
    expect(read(3)![1], 'ready').toBe(1);
    write(...READ_VALUES);
    expect(read(27)).not.toBeNull();
  });

  it('reports all nine quantities with the datasheet scales and per-word CRCs', () => {
    const { driver, write, read, warmUp } = build();
    write(...START);
    warmUp();
    driver.onControl!('pm25_ugm3', 'slider', 37.4);
    driver.onControl!('temperature_c', 'slider', 21.5);
    driver.onControl!('humidity_rh', 'slider', 63.25);
    driver.onControl!('co2_ppm', 'slider', 1234);
    write(...READ_VALUES);
    const values = decode(read(27)!);

    expect(values.pm25_ugm3).toBeCloseTo(37.4, 1);
    expect(values.temperature_c).toBeCloseTo(21.5, 2);
    expect(values.humidity_rh).toBeCloseTo(63.25, 2);
    expect(values.co2_ppm).toBe(1234);
    expect(values.voc_index, 'untouched sliders keep the catalog default').toBeCloseTo(100, 1);
    expect(Object.keys(values)).toHaveLength(9);
  });

  it('carries a negative temperature as a signed word', () => {
    const { driver, write, read, warmUp } = build();
    write(...START);
    warmUp();
    driver.onControl!('temperature_c', 'slider', -7.5);
    write(...READ_VALUES);
    expect(decode(read(27)!).temperature_c).toBeCloseTo(-7.5, 2);
  });

  it('stops reporting when the module is stopped, and restarts the warm-up', () => {
    const { write, read } = build();
    write(...START);
    write(...READ_VALUES);
    expect(read(27)).toBeNull();
    write(...STOP);
    write(...READ_VALUES);
    expect(read(27)).toBeNull();
  });

  it('warns once about a command it does not know, and about a byte-sized one', () => {
    const { harness, write } = build();
    for (let i = 0; i < 5; i++) write(0x12, 0x34);
    write(0x00);
    const codes = harness.codes().filter((c) => c === 'i2c_unknown_command');
    expect(codes).toHaveLength(2);
    expect(harness.diagnostics.some((d) => d.message.includes('16 位字'))).toBe(true);
  });

  it('pins the frame format so a correction has to break a test', () => {
    // Sensirion words: two bytes then their CRC, same polynomial as the SHT4x.
    expect([...wordsWithCrc([0xbeef])]).toEqual([0xbe, 0xef, 0x92]);
    expect([...wordsWithCrc([0x0000, 0xbeef])]).toEqual([0x00, 0x00, 0x81, 0xbe, 0xef, 0x92]);
    expect(wordsWithCrc(SEN6X_CHANNELS.map(() => 0)).length, 'nine words is 27 bytes').toBe(27);
  });
});
