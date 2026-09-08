import { describe, expect, it } from 'vitest';
import { alsCounts, createLtr390Driver, uvsCounts, LTR390_DRIVER_ID, LTR390_PART_ID } from '../../src/devices/ltr390.js';
import type { SimDeviceSpec } from '../../src/types.js';
import { createDeviceHarness } from './harness.js';

const ADDR = 0x53;
const MAIN_CTRL = 0x00;
const GAIN = 0x05;
const PART_ID = 0x06;
const ALS_DATA = 0x0d;
const UVS_DATA = 0x10;
const ENABLE_ALS = 0x02;
const ENABLE_UVS = 0x0a; // enable + UV mode

function spec(overrides: Partial<SimDeviceSpec> = {}): SimDeviceSpec {
  return {
    componentId: 'ltr',
    model: 'ltr390_breakout@1',
    driver: LTR390_DRIVER_ID,
    pinNets: { SDA: 'net_sda', SCL: 'net_scl' },
    pinChannels: { SDA: 'sda', SCL: 'scl' },
    properties: { i2c_address: ADDR },
    i2c: { role: 'device', buses: [{ index: 0, sdaPin: 'SDA', sclPin: 'SCL', sdaNet: 'net_sda', sclNet: 'net_scl' }], address: ADDR },
    controls: [
      { id: 'lux', featureLabel: '传感器', action: 'slider', channel: 'ambient_lux', range: { min: 0, max: 50000, step: 10, default: 300, unit: 'lx' } },
      { id: 'uvi', featureLabel: '传感器', action: 'slider', channel: 'uv_index', range: { min: 0, max: 15, step: 0.1, default: 1, unit: 'UVI' } }
    ],
    ...overrides
  };
}

function build() {
  const harness = createDeviceHarness({ spec: spec() });
  const driver = harness.bind(createLtr390Driver(harness.ctx));
  const write = (...bytes: number[]) => driver.onI2cWrite!(ADDR, Uint8Array.from(bytes), true);
  /** Point at `reg`, then stream `length` bytes — how every register part is read. */
  const read = (reg: number, length: number) => {
    write(reg);
    return driver.onI2cRead!(ADDR, length)!;
  };
  const counts24 = (reg: number) => {
    const b = read(reg, 3);
    return b[0]! | (b[1]! << 8) | (b[2]! << 16);
  };
  return { harness, driver, write, read, counts24 };
}

describe('sensor.ltr390@1', () => {
  it('identifies itself and starts in standby', () => {
    const { harness, driver, read, counts24 } = build();
    expect(driver.driverId).toBe(LTR390_DRIVER_ID);
    expect(harness.i2cAttachments).toEqual([{ sdaPin: 'SDA', sclPin: 'SCL', addresses: [ADDR] }]);
    expect(read(PART_ID, 1)[0], 'the id a library checks first').toBe(LTR390_PART_ID);
    expect(counts24(ALS_DATA), 'standby means no conversion').toBe(0);
    expect(harness.diagnostics.some((d) => d.message.includes('待机'))).toBe(true);
  });

  it('streams consecutive registers from the pointer, like the real part', () => {
    const { write, read } = build();
    write(MAIN_CTRL, ENABLE_ALS);
    // one read starting at MAIN_CTRL walks 0x00..0x06 with auto-increment
    const block = read(MAIN_CTRL, 7);
    expect(block[0], 'MAIN_CTRL reads back what was written').toBe(ENABLE_ALS);
    expect(block[6], 'and 0x06 is still the part id').toBe(LTR390_PART_ID);
  });

  it('turns the slider into counts through the gain and resolution tables', () => {
    const { write, counts24 } = build();
    write(MAIN_CTRL, ENABLE_ALS);
    // defaults: gain 3, 18-bit (factor 1) → counts = lux · 3 / 0.6 = lux · 5
    expect(counts24(ALS_DATA)).toBe(alsCounts(300, 3, 1));
    expect(counts24(ALS_DATA)).toBe(1500);

    // a program that changes the gain must see the counts change with it
    write(GAIN, 0x04); // gain 18
    expect(counts24(ALS_DATA)).toBe(alsCounts(300, 18, 1));
    expect(counts24(ALS_DATA)).toBe(9000);
  });

  it('follows the slider', () => {
    const { driver, write, counts24 } = build();
    write(MAIN_CTRL, ENABLE_ALS);
    driver.onControl!('ambient_lux', 'slider', 12000);
    expect(counts24(ALS_DATA)).toBe(alsCounts(12000, 3, 1));
    driver.onControl!('ambient_lux', 'slider', 0);
    expect(counts24(ALS_DATA)).toBe(0);
  });

  it('only converts the mode that is selected', () => {
    const { driver, write, counts24 } = build();
    driver.onControl!('uv_index', 'slider', 7);
    write(MAIN_CTRL, ENABLE_ALS);
    expect(counts24(UVS_DATA), 'in ALS mode the UV register does not update').toBe(0);

    write(MAIN_CTRL, ENABLE_UVS);
    expect(counts24(UVS_DATA)).toBe(uvsCounts(7, 3, 1));
    expect(counts24(ALS_DATA), 'and now the ALS register is the idle one').toBe(0);
  });

  it('clamps a slider to the declared range and saturates the 20-bit register', () => {
    const { driver, write, counts24 } = build();
    write(MAIN_CTRL, ENABLE_ALS);
    driver.onControl!('ambient_lux', 'slider', 999_999);
    // clamped to the catalog's 50 000 lx, then × 5 at the default gain
    expect(counts24(ALS_DATA)).toBe(250_000);

    // turn the gain up and the same light saturates the 20-bit register, which is
    // what over-ranging looks like on the real part
    write(GAIN, 0x04); // gain 18
    expect(counts24(ALS_DATA)).toBe(0xfffff);
  });

  it('warns once about a write to a register it does not model', () => {
    const { harness, write } = build();
    for (let i = 0; i < 5; i++) write(0x21, 0x01);
    expect(harness.codes().filter((c) => c === 'i2c_unknown_command')).toHaveLength(1);
  });

  it('pins the datasheet tables so a correction has to break a test', () => {
    // lux = 0.6 · counts / (gain · time)
    expect(alsCounts(100, 1, 1)).toBe(Math.round(100 / 0.6));
    expect(alsCounts(100, 18, 4)).toBe(Math.round((100 * 18 * 4) / 0.6));
    expect(alsCounts(-5, 3, 1), 'never negative').toBe(0);
    // 2300 counts per UVI at gain 18, 20-bit
    expect(uvsCounts(1, 18, 4)).toBe(2300);
    expect(uvsCounts(2, 18, 4)).toBe(4600);
  });
});
