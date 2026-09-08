/**
 * `sensor.ltr390@1` — LiteOn LTR-390UV ambient-light / UV sensor (阶段 4).
 *
 * Unlike the SHT4x, this part is **register-based**: a write sets the address
 * pointer (and optionally writes bytes), a read streams from that pointer with
 * auto-increment. Modelling both shapes matters — nearly every I²C part in the
 * wild is one or the other, and a program written against a real library exercises
 * the pointer, not just a command byte.
 *
 * The raw counts are derived from the sliders through the datasheet's own gain and
 * resolution tables, so changing `ALS_UVS_GAIN` or the resolution really does change
 * the number a program reads back. A driver that ignored those registers would make
 * every library's lux calculation wrong in a way that looks like a hardware fault.
 *
 * **Register map, gain/resolution tables and the lux formula are from the datasheet
 * and unverified against silicon** (same status as the SSD1315 command set and the
 * SHT4x formulas). They are pinned by tests, so a correction has to break one.
 */
import type { SimulationControlAction } from '@breadboard-studio/schema';
import type { DeviceContext, DeviceDriver, I2cAck } from '../contracts.js';
import type { SimDeviceSpec } from '../types.js';

export const LTR390_DRIVER_ID = 'sensor.ltr390@1';

export const LTR390_LUX_CHANNEL = 'ambient_lux';
export const LTR390_UVI_CHANNEL = 'uv_index';
export const LTR390_DEFAULT_ADDRESS = 0x53;
export const LTR390_PART_ID = 0xb2;

const REG = {
  MAIN_CTRL: 0x00,
  MEAS_RATE: 0x04,
  GAIN: 0x05,
  PART_ID: 0x06,
  MAIN_STATUS: 0x07,
  ALS_DATA_0: 0x0d,
  UVS_DATA_0: 0x10
} as const;

/** `ALS_UVS_GAIN` field → gain factor. */
const GAIN_TABLE: readonly number[] = [1, 3, 6, 9, 18];
/** Resolution field → (bits, integration time factor). 20-bit is the slowest and largest. */
const RESOLUTION_TABLE: readonly { bits: number; factor: number }[] = [
  { bits: 20, factor: 4 },
  { bits: 19, factor: 2 },
  { bits: 18, factor: 1 },
  { bits: 17, factor: 0.5 },
  { bits: 16, factor: 0.25 },
  { bits: 13, factor: 0.03125 }
];

/** Counts a given lux reading produces: `lux = 0.6 · counts / (gain · time)`. */
export function alsCounts(lux: number, gain: number, factor: number): number {
  return clamp20((lux * gain * factor) / 0.6);
}

/** Counts for a UV index: the datasheet's sensitivity is 2300 counts per UVI at gain 18, 20-bit. */
export function uvsCounts(uvi: number, gain: number, factor: number): number {
  return clamp20((uvi * 2300 * (gain / 18) * (factor / 4)));
}

function clamp20(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0xfffff, Math.round(value)));
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

export function createLtr390Driver(ctx: DeviceContext): DeviceDriver {
  const spec = ctx.spec;
  const address = typeof spec.properties?.i2c_address === 'number' ? spec.properties.i2c_address : LTR390_DEFAULT_ADDRESS;

  let lux = rangeDefault(spec, LTR390_LUX_CHANNEL, 300);
  let uvi = rangeDefault(spec, LTR390_UVI_CHANNEL, 1);

  // Register state. Defaults are the datasheet's power-on values.
  let mainCtrl = 0x00; // sensor in standby, ALS mode
  let measRate = 0x22; // 18-bit, 100 ms
  let gainField = 0x01; // gain 3
  let pointer: number = REG.PART_ID;

  const bus = spec.i2c?.buses?.[0];
  if (bus) ctx.attachI2c(bus.sdaPin, bus.sclPin, [address]);

  const enabled = () => (mainCtrl & 0x02) !== 0;
  const uvMode = () => (mainCtrl & 0x08) !== 0;
  const gain = () => GAIN_TABLE[gainField & 0x07] ?? 3;
  const resolution = () => RESOLUTION_TABLE[(measRate >> 4) & 0x07] ?? RESOLUTION_TABLE[2]!;

  /** One register's current value; the data registers are computed on read. */
  function readRegister(reg: number): number {
    if (reg === REG.PART_ID) return LTR390_PART_ID;
    if (reg === REG.MAIN_CTRL) return mainCtrl;
    if (reg === REG.MEAS_RATE) return measRate;
    if (reg === REG.GAIN) return gainField;
    // Bit 3 is "new data ready"; it is only ever set while the sensor is running.
    if (reg === REG.MAIN_STATUS) return enabled() ? 0x08 : 0x00;
    // Only the selected mode converts, which is why a program that forgets to set
    // MAIN_CTRL bit 3 before reading UVS gets zeros instead of a plausible number.
    if (reg >= REG.ALS_DATA_0 && reg <= REG.ALS_DATA_0 + 2) {
      const counts = enabled() && !uvMode() ? alsCounts(lux, gain(), resolution().factor) : 0;
      return (counts >> (8 * (reg - REG.ALS_DATA_0))) & 0xff;
    }
    if (reg >= REG.UVS_DATA_0 && reg <= REG.UVS_DATA_0 + 2) {
      const counts = enabled() && uvMode() ? uvsCounts(uvi, gain(), resolution().factor) : 0;
      return (counts >> (8 * (reg - REG.UVS_DATA_0))) & 0xff;
    }
    return 0;
  }

  return {
    driverId: LTR390_DRIVER_ID,

    onControl(channel: string, _action: SimulationControlAction, value: boolean | number) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      if (channel === LTR390_LUX_CHANNEL) lux = clampToRange(spec, channel, value);
      else if (channel === LTR390_UVI_CHANNEL) uvi = clampToRange(spec, channel, value);
      else {
        ctx.diagnoseOnce(`control:${channel}`, {
          code: 'unsupported_device',
          severity: 'info',
          message: `控件通道「${channel}」在 LTR390 驱动中没有实现，已忽略。`
        });
      }
    },

    onI2cWrite(_address: number, bytes: Uint8Array, _stop: boolean): I2cAck {
      if (bytes.length === 0) return 'ack'; // a probe
      pointer = bytes[0]! & 0xff;
      // Anything after the address is written into consecutive registers.
      for (let i = 1; i < bytes.length; i++) {
        const reg = (pointer + i - 1) & 0xff;
        const value = bytes[i]! & 0xff;
        if (reg === REG.MAIN_CTRL) mainCtrl = value;
        else if (reg === REG.MEAS_RATE) measRate = value;
        else if (reg === REG.GAIN) gainField = value;
        else {
          ctx.diagnoseOnce(`reg:${reg}`, {
            code: 'i2c_unknown_command',
            severity: 'warning',
            message: `LTR390 收到对只读或未实现寄存器 0x${reg.toString(16)} 的写入，已忽略。`
          });
        }
      }
      return 'ack';
    },

    onI2cRead(_address: number, length: number): Uint8Array | null {
      // Auto-increment from the pointer, exactly like the real part.
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = readRegister((pointer + i) & 0xff);
      if (!enabled()) {
        ctx.diagnoseOnce('read:standby', {
          code: 'i2c_nack',
          severity: 'warning',
          message: 'LTR390 还在待机：先往 MAIN_CTRL（0x00）写入 0x02 使能，否则数据寄存器恒为 0。'
        });
      }
      return out;
    },

    dispose() {
      pointer = REG.PART_ID;
    }
  };
}
