import { describe, expect, it } from 'vitest';
import {
  compensatePressure,
  compensateTemperature,
  createBmp390Driver,
  measurementDurationUs,
  odrPeriodUs,
  pressurePa,
  quantizeCalibration,
  rawFor,
  temperatureLin,
  BMP390_CHIP_ID,
  BMP390_DRIVER_ID,
  BMP390_LIMITS,
  BMP390_NVM
} from '../../src/devices/bmp390.js';
import type { SimDeviceSpec } from '../../src/types.js';
import { createDeviceHarness } from './harness.js';

const ADDR = 0x77;
const PWR_CTRL = 0x1b;
const CHIP_ID = 0x00;
const STATUS = 0x03;
const DATA = 0x04;
const CALIB = 0x31;
const CMD = 0x7e;
/** Enable pressure + temperature (bits 0,1) in normal mode (bits 4,5). */
const RUN = 0x33;
/** Enable both, forced mode — one conversion, then back to sleep. */
const FORCED = 0x13;
const EVENT = 0x10;
const OSR = 0x1c;
const ODR = 0x1d;
const CONFIG = 0x1f;

function spec(): SimDeviceSpec {
  return {
    componentId: 'bmp',
    model: 'bmp390_breakout@1',
    driver: BMP390_DRIVER_ID,
    pinNets: { SDA: 'net_sda', SCL: 'net_scl' },
    pinChannels: { SDA: 'sda', SCL: 'scl' },
    properties: { i2c_address: ADDR },
    i2c: { role: 'device', buses: [{ index: 0, sdaPin: 'SDA', sclPin: 'SCL', sdaNet: 'net_sda', sclNet: 'net_scl' }], address: ADDR },
    controls: [
      { id: 'pressure', featureLabel: '传感器', action: 'slider', channel: 'pressure_hpa', range: { min: 300, max: 1250, step: 0.1, default: 1013.2, unit: 'hPa' } },
      { id: 'temperature', featureLabel: '传感器', action: 'slider', channel: 'temperature_c', range: { min: -40, max: 85, step: 0.1, default: 25, unit: '°C' } }
    ]
  };
}

function build() {
  const harness = createDeviceHarness({ spec: spec() });
  const driver = harness.bind(createBmp390Driver(harness.ctx));
  const write = (...bytes: number[]) => driver.onI2cWrite!(ADDR, Uint8Array.from(bytes), true);
  const read = (reg: number, length: number) => {
    write(reg);
    return driver.onI2cRead!(ADDR, length)!;
  };
  /** Enter a mode and let its conversion finish, the way a program's delay would. */
  const runFor = (mode: number) => {
    write(0x1b, mode);
    harness.advance(200_000); // comfortably past the longest conversion any test configures
  };
  /**
   * Wait for the next sample. The device latches at conversion time, so a slider
   * moved after one conversion is only visible from the next one — like the part.
   */
  const settle = () => harness.advance(odrPeriodUs(0x00) * 2);
  return { harness, driver, write, read, runFor, settle };
}

/**
 * Decode the way the datasheet's §8.5 reference code and every vendor driver do:
 * the polynomial with **no saturation**.
 *
 * Decoding with the clamped form would re-apply the very saturation the device used
 * when it produced the bytes, so the two errors cancel and the test confirms itself.
 * That is exactly how a real bug survived here: at −40 °C the device served raw 0,
 * which an unclamped decoder reads as −40.13 °C.
 */
function readSensor(read: (reg: number, length: number) => Uint8Array): { celsius: number; pascals: number } {
  const calib = quantizeCalibration([...read(CALIB, 21)]);
  const data = read(DATA, 6);
  const rawPressure = data[0]! | (data[1]! << 8) | (data[2]! << 16);
  const rawTemperature = data[3]! | (data[4]! << 8) | (data[5]! << 16);
  const celsius = temperatureLin(rawTemperature, calib);
  return { celsius, pascals: pressurePa(rawPressure, celsius, calib) };
}

describe('sensor.bmp390@1', () => {
  it('identifies itself and starts asleep', () => {
    const { harness, driver, read } = build();
    expect(driver.driverId).toBe(BMP390_DRIVER_ID);
    expect(harness.i2cAttachments).toEqual([{ sdaPin: 'SDA', sclPin: 'SCL', addresses: [ADDR] }]);
    expect(read(CHIP_ID, 1)[0], 'BMP390 is 0x60; the BMP388 in the same family is 0x50').toBe(BMP390_CHIP_ID);
    // cmd_rdy is set even asleep: Bosch's `bmp3_soft_reset`, which `bmp3_init`
    // calls, refuses to write the reset command without it.
    expect(read(STATUS, 1)[0], 'command decoder ready, nothing converted yet').toBe(0x10);
    expect([...read(DATA, 6)], 'the documented reset value is 0x800000, not zero').toEqual([0x00, 0x00, 0x80, 0x00, 0x00, 0x80]);
    expect(read(EVENT, 1)[0], 'por_detected after power-up').toBe(0x01);
    expect(read(EVENT, 1)[0], 'and it is clear-on-read').toBe(0x00);
    expect(harness.diagnostics.some((d) => d.message.includes('PWR_CTRL'))).toBe(true);
  });

  it('round-trips a program using the datasheet compensation, across the whole range', () => {
    const { driver, read, runFor, settle } = build();
    runFor(RUN);
    expect(read(STATUS, 1)[0] & 0x60, 'both conversions ready').toBe(0x60);

    for (const [hpa, celsius] of [
      [1013.2, 25],
      [300, -40],
      [1250, 85],
      [500, 0],
      [900, -12.5],
      [1100, 40]
    ] as const) {
      driver.onControl!('pressure_hpa', 'slider', hpa);
      driver.onControl!('temperature_c', 'slider', celsius);
      settle();
      const got = readSensor(read);
      // Within a raw LSB: the driver bisects the very polynomial the program runs.
      expect(got.celsius, `${celsius} °C`).toBeCloseTo(celsius, 3);
      expect(got.pascals / 100, `${hpa} hPa`).toBeCloseTo(hpa, 2);
    }
  });

  it('serves the calibration block a real library expects to burst-read', () => {
    const { read } = build();
    const nvm = read(CALIB, 21);
    expect([...nvm], '21 bytes from 0x31, little-endian in register order').toEqual([...BMP390_NVM]);
    // The two scalings that read like their own opposite in Bosch's source.
    const calib = quantizeCalibration([...nvm]);
    expect(calib.t1, 'par_t1 is divided by 1/2^8, i.e. multiplied by 256').toBe(21000 * 256);
    expect(calib.p5, 'par_p5 is divided by 1/2^3, i.e. multiplied by 8').toBe(3750 * 8);
  });

  it('streams consecutive registers from the pointer', () => {
    const { read, runFor } = build();
    runFor(RUN);
    const block = read(CHIP_ID, 4);
    expect(block[0]).toBe(BMP390_CHIP_ID);
    expect(block[1], 'REV_ID').toBe(0x01);
    expect(block[2], 'ERR is clean').toBe(0x00);
    expect(block[3] & 0x60, 'STATUS says ready').toBe(0x60);
  });

  it('takes a multi-byte write as (register, value) pairs, not an incrementing block', () => {
    // The BMP390 has no write auto-increment; Bosch builds address/data pairs in
    // `interleave_reg_addr`. Under an incrementing model this exact transfer —
    // which Adafruit's `set_odr_filter_settings` emits — lands every value one
    // register late, so ODR ends up holding 0x1D and CONFIG holding 0x1F.
    const { write, read } = build();
    write(OSR, 0x0b, ODR, 0x02, CONFIG, 0x04);
    expect(read(OSR, 1)[0]).toBe(0x0b);
    expect(read(ODR, 1)[0]).toBe(0x02);
    expect(read(CONFIG, 1)[0]).toBe(0x04);
  });

  it('restores every user register on a soft reset, not just the mode', () => {
    const { write, read, runFor } = build();
    write(OSR, 0x0b, ODR, 0x03, CONFIG, 0x04);
    runFor(RUN);
    expect(read(DATA, 6).some((b, i) => b !== [0x00, 0x00, 0x80, 0x00, 0x00, 0x80][i])).toBe(true);

    write(CMD, 0xb6);
    expect(read(PWR_CTRL, 1)[0]).toBe(0x00);
    expect(read(OSR, 1)[0], 'back to the power-on value').toBe(0x02);
    expect(read(ODR, 1)[0]).toBe(0x00);
    expect(read(CONFIG, 1)[0]).toBe(0x00);
    expect([...read(DATA, 6)], 'and the sample is gone').toEqual([0x00, 0x00, 0x80, 0x00, 0x00, 0x80]);
    expect(read(EVENT, 1)[0], 'por_detected is set again').toBe(0x01);
  });

  it('forced mode converts once and returns to sleep, holding the sample', () => {
    const { harness, driver, write, read } = build();
    write(PWR_CTRL, FORCED);
    expect(read(PWR_CTRL, 1)[0] & 0x30, 'still converting').toBe(0x10);
    expect([...read(DATA, 6)], 'and nothing to read yet').toEqual([0x00, 0x00, 0x80, 0x00, 0x00, 0x80]);

    harness.advance(measurementDurationUs(FORCED, 0x02) + 10);
    expect(read(PWR_CTRL, 1)[0] & 0x30, 'the mode bits self-cleared to sleep').toBe(0x00);
    const held = readSensor(read);
    expect(held.pascals / 100).toBeCloseTo(1013.2, 2);

    // The held sample does not follow the slider: the conversion already happened.
    driver.onControl!('pressure_hpa', 'slider', 700);
    expect(readSensor(read).pascals / 100).toBeCloseTo(1013.2, 2);
  });

  it('clears each ready flag when its own data is read, and sets it again next period', () => {
    const { harness, read, runFor } = build();
    runFor(RUN);
    expect(read(STATUS, 1)[0]).toBe(0x10 | 0x20 | 0x40);
    read(DATA, 3); // pressure only
    expect(read(STATUS, 1)[0], 'pressure consumed, temperature still pending').toBe(0x10 | 0x40);
    read(DATA + 3, 3);
    expect(read(STATUS, 1)[0], 'both consumed').toBe(0x10);

    harness.advance(odrPeriodUs(0x00) + 10);
    expect(read(STATUS, 1)[0], 'the next ODR tick makes a new sample ready').toBe(0x10 | 0x20 | 0x40);
  });

  it('reports ready only for the channels PWR_CTRL enables', () => {
    for (const [pwr, expected] of [
      [0x33, 0x20 | 0x40],
      [0x31, 0x20],
      [0x32, 0x40],
      [0x30, 0x00]
    ] as const) {
      const { read, runFor } = build();
      runFor(pwr);
      expect(read(STATUS, 1)[0], `PWR_CTRL 0x${pwr.toString(16)}`).toBe(0x10 | expected);
    }
    // and a mode of sleep never converts, whatever the enable bits say
    const idle = build();
    idle.write(PWR_CTRL, 0x03);
    idle.harness.advance(1_000_000);
    expect(idle.read(STATUS, 1)[0]).toBe(0x10);
  });

  it('clamps to the limits the compensation itself enforces', () => {
    const { driver, read, runFor, settle } = build();
    runFor(RUN);
    driver.onControl!('pressure_hpa', 'slider', 99_999);
    driver.onControl!('temperature_c', 'slider', 999);
    settle();
    const hot = readSensor(read);
    expect(hot.celsius).toBeCloseTo(BMP390_LIMITS.maxC, 2);
    expect(hot.pascals).toBeCloseTo(BMP390_LIMITS.maxPa, 0);

    driver.onControl!('pressure_hpa', 'slider', -500);
    driver.onControl!('temperature_c', 'slider', -500);
    settle();
    const cold = readSensor(read);
    expect(cold.celsius).toBeCloseTo(BMP390_LIMITS.minC, 2);
    expect(cold.pascals).toBeCloseTo(BMP390_LIMITS.minPa, 0);
  });

  it('keeps the saturation as a separate, Bosch-equivalent wrapper', () => {
    // Bosch's clamp is a decode-side warning about an out-of-spec reading, not part
    // of the raw→value mapping — so both forms exist and only the unclamped one may
    // be inverted. Losing that distinction is what put raw 0 at −40 °C.
    const calib = quantizeCalibration([...BMP390_NVM]);
    expect(temperatureLin(0, calib), 'the mapping itself runs past the limit').toBeLessThan(BMP390_LIMITS.minC);
    expect(compensateTemperature(0, calib), 'the wrapper saturates, as Bosch does').toBe(BMP390_LIMITS.minC);
    expect(temperatureLin(0xffffff, calib)).toBeGreaterThan(BMP390_LIMITS.maxC);
    expect(compensateTemperature(0xffffff, calib)).toBe(BMP390_LIMITS.maxC);

    const tLin = temperatureLin(rawFor(25, (raw) => temperatureLin(raw, calib)), calib);
    expect(pressurePa(0xffffff, tLin, calib)).toBeGreaterThan(BMP390_LIMITS.maxPa);
    expect(compensatePressure(0xffffff, tLin, calib)).toBe(BMP390_LIMITS.maxPa);
    // In between, the two agree exactly.
    expect(compensatePressure(8_000_000, tLin, calib)).toBe(pressurePa(8_000_000, tLin, calib));
  });

  it('exercises the full degree-three polynomial, not just its linear restriction', () => {
    // The shipped NVM neutralises the higher-order coefficients on purpose, which
    // means no device test can tell the implemented polynomial from a linear one.
    // This fixture makes every coefficient non-zero, two of them negative.
    const nvm = [
      0x10, 0x27, 0x50, 0x1f, 0xfd, // t1 = 10000, t2 = 8016, t3 = -3
      0x64, 0x4e, 0x00, 0x41, 0x05, 0xfb, // p1 = 20068, p2 = 16640 (the −16384 offset must not zero it), p3 = 5, p4 = -5
      0xa6, 0x0e, 0x39, 0x05, 0x07, 0xf9, // p5 = 3750, p6 = 1337, p7 = 7, p8 = -7
      0x0b, 0x00, 0x03, 0xfe // p9 = 11, p10 = 3, p11 = -2
    ];
    expect(nvm).toHaveLength(21);
    const calib = quantizeCalibration(nvm);
    for (const [name, value] of Object.entries(calib)) expect(value, name).not.toBe(0);
    expect(calib.t3, 'int8 0xFD is −3').toBeLessThan(0);
    expect(calib.p4).toBeLessThan(0);
    expect(calib.p8).toBeLessThan(0);
    expect(calib.p11).toBeLessThan(0);

    // Every cubic term now contributes: drop any one of them and the value moves.
    const tLin = temperatureLin(9_000_000, calib);
    const full = pressurePa(6_000_000, tLin, calib);
    const withoutCubic = pressurePa(6_000_000, tLin, { ...calib, p8: 0, p4: 0, p11: 0 });
    expect(full).not.toBeCloseTo(withoutCubic, 6);
    const withoutQuadratic = pressurePa(6_000_000, tLin, { ...calib, p7: 0, p3: 0, p9: 0, p10: 0 });
    expect(full).not.toBeCloseTo(withoutQuadratic, 6);
    // and the temperature polynomial's quadratic term likewise
    expect(temperatureLin(9_000_000, calib)).not.toBeCloseTo(temperatureLin(9_000_000, { ...calib, t3: 0 }), 6);
  });

  it('pins the measurement timing against `bmp3_get_meas_dur`', () => {
    // 234 µs fixed, plus per enabled channel its settle time and 2^osr × 2000 µs.
    expect(measurementDurationUs(0x33, 0x00), 'both channels at ×1').toBe(234 + 392 + 2000 + 313 + 2000);
    expect(measurementDurationUs(0x31, 0x00), 'pressure only').toBe(234 + 392 + 2000);
    expect(measurementDurationUs(0x33, 0x0b), 'osr_p ×8, osr_t ×2').toBe(234 + 392 + 8 * 2000 + 313 + 2 * 2000);
    expect(odrPeriodUs(0x00)).toBe(5000);
    expect(odrPeriodUs(0x03), '5 ms doubling per step').toBe(40000);
  });

  it('warns once about a write to a register it does not model', () => {
    const { harness, write } = build();
    for (let i = 0; i < 5; i++) write(0x50, 0x01);
    expect(harness.codes().filter((c) => c === 'i2c_unknown_command')).toHaveLength(1);
  });

  it('pins the transcribed compensation against Bosch’s own source', () => {
    const calib = quantizeCalibration([...BMP390_NVM]);
    // Every divisor, exactly as `parse_calib_data` writes it.
    expect(calib.t2).toBeCloseTo(8016 / 1073741824, 15);
    expect(calib.p1).toBeCloseTo((25300 - 16384) / 1048576, 15);
    expect(calib.p2, 'a raw 16384 makes par_p2 exactly zero').toBe(0);

    // Signedness: par_t3 / par_p3..p4 / p7..p8 / p10..p11 are int8, par_p1/p2/p9 int16.
    const signed = quantizeCalibration([...BMP390_NVM].map((_, i) => (i === 4 ? 0xff : BMP390_NVM[i]!)));
    expect(signed.t3, '0xFF is −1, not 255').toBeCloseTo(-1 / 281474976710656, 20);

    // The compensation is monotonic in the raw value, which is what makes bisection valid.
    let previous = -Infinity;
    for (let raw = 0; raw <= 0xffffff; raw += 0x40000) {
      const value = compensateTemperature(raw, calib);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(rawFor(25, (raw) => compensateTemperature(raw, calib))).toBeGreaterThan(0);
  });
});
