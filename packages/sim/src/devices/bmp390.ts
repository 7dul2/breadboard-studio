/**
 * `sensor.bmp390@1` — Bosch BMP390 barometric pressure sensor (阶段 4).
 *
 * This part was held back from the first sensor pass on purpose. The other three
 * report their measurement more or less directly; the BMP390 reports a **raw ADC
 * value** that only becomes a pressure after a 21-byte calibration block and a
 * degree-three polynomial. A driver that skipped that and returned a convenient
 * number would make every real BMP3xx library compute a wrong pressure — the exact
 * failure this simulator exists to prevent.
 *
 * So the compensation here is transcribed from Bosch's own reference implementation
 * (BMP3-Sensor-API `bmp3.c`, the `BMP3_FLOAT_COMPENSATION` variant), with the
 * register map cross-checked against the datasheet (BST-BMP390-DS002-07) and the
 * Linux kernel's `bmp280-core.c`. Two details are easy to get wrong from memory and
 * are worth naming: `par_t1` and `par_p5` are *divided* by 0.00390625 and 0.125,
 * i.e. multiplied by 256 and 8 — the source comments say "1 / 2^8" and "1 / 2^3",
 * which reads like the opposite.
 *
 * The calibration block the simulated part reports is chosen, not measured: every
 * real unit ships different NVM values, and no public source gives a typical set.
 * The higher-order coefficients are neutralised so the mapping stays well
 * conditioned across the whole measuring range; nothing in the model depends on the
 * values being any particular unit's, and a program reads them out of the registers
 * exactly as it would from a real device.
 *
 * Raw values are produced by **bisecting the compensation**, not by inverting it
 * algebraically. The compensation is monotonic in the raw value, so 40 halvings land
 * within one LSB — and it means the simulator and a real library are running the
 * same polynomial in the same direction, rather than two expressions that have to be
 * kept in agreement by hand.
 */
import type { SimulationControlAction } from '@breadboard-studio/schema';
import type { DeviceContext, DeviceDriver, I2cAck } from '../contracts.js';
import type { SimDeviceSpec } from '../types.js';

export const BMP390_DRIVER_ID = 'sensor.bmp390@1';

export const BMP390_PRESSURE_CHANNEL = 'pressure_hpa';
export const BMP390_TEMPERATURE_CHANNEL = 'temperature_c';
export const BMP390_DEFAULT_ADDRESS = 0x77;
/** `BMP390_CHIP_ID` in `bmp3_defs.h`; the BMP388 in the same family reports 0x50. */
export const BMP390_CHIP_ID = 0x60;

const REG = {
  CHIP_ID: 0x00,
  REV_ID: 0x01,
  ERR: 0x02,
  STATUS: 0x03,
  DATA: 0x04,
  EVENT: 0x10,
  INT_STATUS: 0x11,
  PWR_CTRL: 0x1b,
  OSR: 0x1c,
  ODR: 0x1d,
  CONFIG: 0x1f,
  CALIB: 0x31,
  CMD: 0x7e
} as const;

/** `BMP3_LEN_CALIB_DATA`. */
const CALIB_LENGTH = 21;
const RAW_MAX = 0xffffff;
/** Reset value of both DATA fields (datasheet Table 25: DATA_2 and DATA_5 default 0x80). */
const RAW_RESET = 0x800000;

/** STATUS bits, from `bmp3_defs.h`. */
const STATUS_CMD_RDY = 0x10;
const STATUS_DRDY_PRESS = 0x20;
const STATUS_DRDY_TEMP = 0x40;

/** PWR_CTRL: bits 0/1 enable the two measurements, bits 5:4 select the mode. */
const PWR_PRESS_EN = 0x01;
const PWR_TEMP_EN = 0x02;
const MODE_SLEEP = 0;
const MODE_FORCED = 1;
const MODE_NORMAL = 3;
const modeOf = (pwrCtrl: number): number => (pwrCtrl >> 4) & 0x03;

/**
 * Measurement duration, transcribed from `bmp3_get_meas_dur`: a fixed 234 µs plus,
 * for each enabled channel, its settle time plus 2^osr conversions of 2000 µs.
 */
export function measurementDurationUs(pwrCtrl: number, osr: number): number {
  let total = 234;
  if (pwrCtrl & PWR_PRESS_EN) total += 392 + 2 ** (osr & 0x07) * 2000;
  if (pwrCtrl & PWR_TEMP_EN) total += 313 + 2 ** ((osr >> 3) & 0x07) * 2000;
  return total;
}

/** ODR period, from the table in `bmp3_get_meas_dur`: 5 ms doubling per step. */
export function odrPeriodUs(odr: number): number {
  return 5000 * 2 ** Math.min(17, odr & 0x1f);
}

/** `BMP3_MIN/MAX_TEMP_DOUBLE` and `BMP3_MIN/MAX_PRES_DOUBLE`, which the compensation clamps to. */
export const BMP390_LIMITS = { minC: -40, maxC: 85, minPa: 30000, maxPa: 125000 } as const;

const u16le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const i8 = (value: number): number[] => [value & 0xff];

/**
 * The NVM block this part reports, little-endian in register order from 0x31.
 * Chosen, not measured — see the file comment.
 */
export const BMP390_NVM: readonly number[] = Object.freeze([
  ...u16le(21000), // par_t1
  ...u16le(8016), // par_t2
  ...i8(0), // par_t3
  ...u16le(25300), // par_p1
  ...u16le(16384), // par_p2 — 16384 makes the quantised value exactly zero
  ...i8(0), // par_p3
  ...i8(0), // par_p4
  ...u16le(3750), // par_p5 — the pressure offset, ×8 → 30000 Pa
  ...u16le(0), // par_p6
  ...i8(0), // par_p7
  ...i8(0), // par_p8
  ...u16le(0), // par_p9
  ...i8(0), // par_p10
  ...i8(0) // par_p11
]);

export interface Bmp390Calibration {
  t1: number;
  t2: number;
  t3: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  p7: number;
  p8: number;
  p9: number;
  p10: number;
  p11: number;
}

const s8 = (v: number): number => (v > 127 ? v - 256 : v);
const s16 = (v: number): number => (v > 32767 ? v - 65536 : v);
const u16 = (nvm: readonly number[], i: number): number => ((nvm[i + 1] ?? 0) << 8) | (nvm[i] ?? 0);

/**
 * `parse_calib_data` from `bmp3.c`, float variant. The divisors are transcribed
 * literally — several of them are fractions, so these are multiplications.
 */
export function quantizeCalibration(nvm: readonly number[]): Bmp390Calibration {
  return {
    t1: u16(nvm, 0) / 0.00390625,
    t2: u16(nvm, 2) / 1073741824.0,
    t3: s8(nvm[4] ?? 0) / 281474976710656.0,
    p1: (s16(u16(nvm, 5)) - 16384) / 1048576.0,
    p2: (s16(u16(nvm, 7)) - 16384) / 536870912.0,
    p3: s8(nvm[9] ?? 0) / 4294967296.0,
    p4: s8(nvm[10] ?? 0) / 137438953472.0,
    p5: u16(nvm, 11) / 0.125,
    p6: u16(nvm, 13) / 64.0,
    p7: s8(nvm[15] ?? 0) / 256.0,
    p8: s8(nvm[16] ?? 0) / 32768.0,
    p9: s16(u16(nvm, 17)) / 281474976710656.0,
    p10: s8(nvm[19] ?? 0) / 281474976710656.0,
    p11: s8(nvm[20] ?? 0) / 36893488147419103232.0
  };
}

/**
 * `compensate_temperature` without the saturation — the raw → °C mapping itself,
 * which is what the datasheet's own §8.5 reference code returns.
 *
 * The split matters more than it looks. Bosch's clamp is a *decode-side warning*
 * that a reading fell out of spec (it sets `BMP3_W_MIN_TEMP` alongside), not part
 * of the mapping. Bisecting the clamped form would search a function that is flat
 * below −40 °C, where the inverse is not unique: the search lands on raw 0, and a
 * decoder that does not clamp — the datasheet code, Adafruit's driver, any program
 * a user writes — reads −40.13 °C instead of −40.00 °C.
 */
export function temperatureLin(rawTemperature: number, calib: Bmp390Calibration): number {
  const partial1 = rawTemperature - calib.t1;
  const partial2 = partial1 * calib.t2;
  return partial2 + partial1 * partial1 * calib.t3;
}

/** `compensate_pressure` without the saturation. */
export function pressurePa(rawPressure: number, tLin: number, calib: Bmp390Calibration): number {
  const out1 = calib.p5 + calib.p6 * tLin + calib.p7 * tLin ** 2 + calib.p8 * tLin ** 3;
  const out2 = rawPressure * (calib.p1 + calib.p2 * tLin + calib.p3 * tLin ** 2 + calib.p4 * tLin ** 3);
  const rest = rawPressure ** 2 * (calib.p9 + calib.p10 * tLin) + rawPressure ** 3 * calib.p11;
  return out1 + out2 + rest;
}

/** `compensate_temperature`, float variant, saturation included — Bosch-equivalent. */
export function compensateTemperature(rawTemperature: number, calib: Bmp390Calibration): number {
  return Math.min(BMP390_LIMITS.maxC, Math.max(BMP390_LIMITS.minC, temperatureLin(rawTemperature, calib)));
}

/** `compensate_pressure`, float variant, saturation included — Bosch-equivalent. */
export function compensatePressure(rawPressure: number, tLin: number, calib: Bmp390Calibration): number {
  return Math.min(BMP390_LIMITS.maxPa, Math.max(BMP390_LIMITS.minPa, pressurePa(rawPressure, tLin, calib)));
}

/**
 * Smallest raw value whose compensation reaches `target`, by bisection.
 *
 * Must be given the **unclamped** mapping: the clamped one is flat outside the
 * device's range, and a flat region has no unique inverse — the search would return
 * whichever end the tie-break happened to pick. The unclamped polynomial is strictly
 * monotonic across the whole 24-bit range for this part's calibration, so 40
 * halvings land within one LSB, and running the *same* polynomial in both directions
 * is what keeps the simulated device and a real library from drifting apart.
 */
export function rawFor(target: number, compensate: (raw: number) => number): number {
  let lo = 0;
  let hi = RAW_MAX;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (compensate(mid) < target) lo = mid;
    else hi = mid;
  }
  return Math.abs(compensate(lo) - target) <= Math.abs(compensate(hi) - target) ? lo : hi;
}

function rangeDefault(spec: SimDeviceSpec, channel: string, fallback: number): number {
  const range = spec.controls?.find((c) => c.channel === channel)?.range;
  return range && typeof range.default === 'number' ? range.default : fallback;
}

function clampToRange(spec: SimDeviceSpec, channel: string, value: number): number {
  const range = spec.controls?.find((c) => c.channel === channel)?.range;
  if (!range) return value;
  return Math.max(range.min, Math.min(range.max, value));
}

export function createBmp390Driver(ctx: DeviceContext): DeviceDriver {
  const spec = ctx.spec;
  const address = typeof spec.properties?.i2c_address === 'number' ? spec.properties.i2c_address : BMP390_DEFAULT_ADDRESS;
  const calib = quantizeCalibration(BMP390_NVM);

  let pressureHpa = rangeDefault(spec, BMP390_PRESSURE_CHANNEL, 1013.2);
  let temperatureC = rangeDefault(spec, BMP390_TEMPERATURE_CHANNEL, 25);

  // Power-on defaults from the datasheet register map (Table 25).
  let pwrCtrl = 0x00;
  let osr = 0x02;
  let odr = 0x00;
  let config = 0x00;
  let event = 0x01; // por_detected, set after power-up and after every soft reset
  let pointer: number = REG.CHIP_ID;

  /** The last converted sample, or null before the first conversion. */
  let latched: { pressure: number; temperature: number } | null = null;
  let drdyPress = false;
  let drdyTemp = false;
  /** Handle of the pending conversion (forced) or the repeating ODR tick (normal). */
  let timer: number | null = null;
  let token = 0;

  const bus = spec.i2c?.buses?.[0];
  if (bus) ctx.attachI2c(bus.sdaPin, bus.sclPin, [address]);

  /** Raw values for the current sliders, by bisecting the *unclamped* polynomial. */
  function sample(): { pressure: number; temperature: number } {
    const rawTemperature = rawFor(temperatureC, (raw) => temperatureLin(raw, calib));
    const tLin = temperatureLin(rawTemperature, calib);
    const rawPressure = rawFor(pressureHpa * 100, (raw) => pressurePa(raw, tLin, calib));
    return { pressure: rawPressure, temperature: rawTemperature };
  }

  function convert(): void {
    latched = sample();
    if (pwrCtrl & PWR_PRESS_EN) drdyPress = true;
    if (pwrCtrl & PWR_TEMP_EN) drdyTemp = true;
  }

  function cancelTimer(): void {
    if (timer !== null) ctx.cancel(timer);
    timer = null;
  }

  /**
   * Arm whatever the mode calls for. Forced mode converts once and returns to sleep,
   * which is the behaviour a program relies on when it polls PWR_CTRL to find out
   * whether its one-shot finished; normal mode re-converts every ODR period.
   */
  function armFor(mode: number): void {
    cancelTimer();
    if (mode === MODE_FORCED) {
      timer = ctx.after(measurementDurationUs(pwrCtrl, osr), ++token);
    } else if (mode === MODE_NORMAL) {
      timer = ctx.after(measurementDurationUs(pwrCtrl, osr), ++token);
    }
  }

  function rawByte(offset: number): number {
    const value = latched ? (offset < 3 ? latched.pressure : latched.temperature) : RAW_RESET;
    return (value >> (8 * (offset % 3))) & 0xff;
  }

  function readRegister(reg: number): number {
    if (reg === REG.CHIP_ID) return BMP390_CHIP_ID;
    if (reg === REG.REV_ID) return 0x01;
    if (reg === REG.ERR) return 0x00;
    if (reg === REG.STATUS) {
      // cmd_rdy is always set: this part never has a command in flight. Bosch's
      // `bmp3_soft_reset` — which `bmp3_init` itself calls — refuses to write the
      // reset command without it, and the Linux driver fails probe with -EBUSY.
      return STATUS_CMD_RDY | (drdyPress ? STATUS_DRDY_PRESS : 0) | (drdyTemp ? STATUS_DRDY_TEMP : 0);
    }
    if (reg === REG.EVENT) {
      const value = event;
      event = 0x00; // por_detected is clear-on-read
      return value;
    }
    if (reg === REG.PWR_CTRL) return pwrCtrl;
    if (reg === REG.OSR) return osr;
    if (reg === REG.ODR) return odr;
    if (reg === REG.CONFIG) return config;
    if (reg >= REG.CALIB && reg < REG.CALIB + CALIB_LENGTH) return BMP390_NVM[reg - REG.CALIB] ?? 0;
    if (reg >= REG.DATA && reg < REG.DATA + 6) {
      const offset = reg - REG.DATA;
      const byte = rawByte(offset);
      // Reading a channel consumes its ready flag, which is what makes a
      // "wait for drdy" polling loop terminate once per sample rather than spin.
      if (offset < 3) drdyPress = false;
      else drdyTemp = false;
      return byte;
    }
    return 0;
  }

  function writeRegister(reg: number, value: number): void {
    if (reg === REG.PWR_CTRL) {
      pwrCtrl = value;
      const mode = modeOf(value);
      if (mode === MODE_SLEEP) cancelTimer();
      else armFor(mode);
      return;
    }
    if (reg === REG.OSR) {
      osr = value;
      return;
    }
    if (reg === REG.ODR) {
      odr = value;
      return;
    }
    if (reg === REG.CONFIG) {
      config = value;
      return;
    }
    if (reg === REG.CMD) {
      if (value === 0xb6) {
        // A soft reset restores every user register, not just the mode.
        cancelTimer();
        pwrCtrl = 0x00;
        osr = 0x02;
        odr = 0x00;
        config = 0x00;
        latched = null;
        drdyPress = false;
        drdyTemp = false;
        event = 0x01;
      }
      return;
    }
    ctx.diagnoseOnce(`reg:${reg}`, {
      code: 'i2c_unknown_command',
      severity: 'warning',
      message: `BMP390 收到对只读或未实现寄存器 0x${reg.toString(16)} 的写入，已忽略。`
    });
  }

  return {
    driverId: BMP390_DRIVER_ID,

    onTimer(fired: number) {
      if (fired !== token) return;
      timer = null;
      convert();
      if (modeOf(pwrCtrl) === MODE_NORMAL) {
        timer = ctx.after(odrPeriodUs(odr), ++token);
      } else {
        // Forced mode is one shot: the mode bits self-clear back to sleep, and the
        // data registers keep holding the sample that was just taken.
        pwrCtrl &= ~0x30;
      }
    },

    onControl(channel: string, _action: SimulationControlAction, value: boolean | number) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      if (channel === BMP390_PRESSURE_CHANNEL) pressureHpa = clampToRange(spec, channel, value);
      else if (channel === BMP390_TEMPERATURE_CHANNEL) temperatureC = clampToRange(spec, channel, value);
      else {
        ctx.diagnoseOnce(`control:${channel}`, {
          code: 'unsupported_device',
          severity: 'info',
          message: `控件通道「${channel}」在 BMP390 驱动中没有实现，已忽略。`
        });
      }
    },

    onI2cWrite(_address: number, bytes: Uint8Array, _stop: boolean): I2cAck {
      if (bytes.length === 0) return 'ack'; // a probe
      pointer = bytes[0]! & 0xff;
      // The BMP390 does **not** auto-increment on write: a multi-byte write is a
      // sequence of (register, value) pairs. Bosch builds exactly that in
      // `interleave_reg_addr`, so a driver configuring OSR/ODR/CONFIG in one
      // transfer would land its values one register late under an incrementing model.
      for (let i = 1; i < bytes.length; i += 2) {
        writeRegister(bytes[i - 1]! & 0xff, bytes[i]! & 0xff);
      }
      return 'ack';
    },

    onI2cRead(_address: number, length: number): Uint8Array | null {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = readRegister((pointer + i) & 0xff);
      if (pointer >= REG.DATA && pointer < REG.DATA + 6 && latched === null) {
        ctx.diagnoseOnce('read:asleep', {
          code: 'i2c_nack',
          severity: 'warning',
          message: 'BMP390 还没有测量过：先往 PWR_CTRL（0x1B）写入 0x33（使能温压 + normal 模式），否则数据寄存器保持复位值 0x800000。'
        });
      }
      return out;
    },

    dispose() {
      cancelTimer();
      pointer = REG.CHIP_ID;
    }
  };
}
