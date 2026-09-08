/**
 * `sensor.sht4x@1` — Sensirion SHT4x temperature / humidity sensor (阶段 4).
 *
 * This is the first device that ever *answers* an I²C read. Until now the only
 * `onI2cRead` in the tree was the OLED's, which always NACKs, so the read half of
 * the bus had unit tests and a timing formula but no device had exercised it end
 * to end. That is why this part was chosen to go first.
 *
 * The measurement model is deliberately literal about one thing real code gets
 * wrong: a measurement takes time. A command is acknowledged immediately, but the
 * result only exists after the conversion delay, and reading before then NACKs
 * exactly as the hardware does. A program that forgets its `sleep` therefore fails
 * here the same way it fails on the bench, instead of quietly getting stale data.
 *
 * **Command encodings and the conversion formulas are from the SHT4x datasheet and
 * are not verified against silicon** — same status as the SSD1315 command set
 * (plan §7.4). They are pinned by tests so a correction is a one-line change with
 * a failing test to prove it.
 */
import type { SimulationControlAction } from '@breadboard-studio/schema';
import type { DeviceContext, DeviceDriver, I2cAck } from '../contracts.js';
import type { SimDeviceSpec } from '../types.js';

export const SHT4X_DRIVER_ID = 'sensor.sht4x@1';

export const SHT4X_TEMPERATURE_CHANNEL = 'temperature_c';
export const SHT4X_HUMIDITY_CHANNEL = 'humidity_rh';
export const SHT4X_DEFAULT_ADDRESS = 0x44;

/** Measurement commands → conversion time in µs. High/medium/low precision. */
const MEASURE_US: Readonly<Record<number, number>> = { 0xfd: 8300, 0xf6: 4500, 0xe0: 1600 };
/** Heater commands: accepted, and they do not produce a measurement of their own. */
const HEATER = new Set([0x39, 0x32, 0x2f, 0x24, 0x21, 0x1e]);
const READ_SERIAL = 0x89;
const SOFT_RESET = 0x94;
const SOFT_RESET_US = 1000;

/** CRC-8, polynomial 0x31, initial value 0xFF — the checksum the sensor appends. */
export function sht4xCrc(bytes: readonly number[]): number {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** °C → the 16-bit tick value the sensor reports: `T = -45 + 175 · S / 65535`. */
export function temperatureTicks(celsius: number): number {
  return clampTicks(((celsius + 45) * 65535) / 175);
}

/** %RH → ticks: `RH = -6 + 125 · S / 65535`. */
export function humidityTicks(percent: number): number {
  return clampTicks(((percent + 6) * 65535) / 125);
}

function clampTicks(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}

function rangeDefault(spec: SimDeviceSpec, channel: string, fallback: number): number {
  const range = spec.controls?.find((c) => c.channel === channel)?.range;
  if (range && typeof range.default === 'number') return range.default;
  return fallback;
}

/** Keep a slider inside the part's declared bounds; the panel should, but the driver decides. */
function clampToRange(spec: SimDeviceSpec, channel: string, value: number): number {
  const range = spec.controls?.find((c) => c.channel === channel)?.range;
  if (!range) return value;
  return Math.max(range.min, Math.min(range.max, value));
}

interface Pending {
  /** Virtual time the conversion finishes; a read before this NACKs. */
  readyAtUs: number;
  bytes: Uint8Array;
}

export function createSht4xDriver(ctx: DeviceContext): DeviceDriver {
  const spec = ctx.spec;
  const address = typeof spec.properties?.i2c_address === 'number' ? spec.properties.i2c_address : SHT4X_DEFAULT_ADDRESS;

  let temperatureC = rangeDefault(spec, SHT4X_TEMPERATURE_CHANNEL, 25);
  let humidityRh = rangeDefault(spec, SHT4X_HUMIDITY_CHANNEL, 50);
  let pending: Pending | null = null;

  const bus = spec.i2c?.buses?.[0];
  if (bus) ctx.attachI2c(bus.sdaPin, bus.sclPin, [address]);

  /** The six bytes a measurement returns: T, CRC, RH, CRC. */
  function sample(): Uint8Array {
    const t = temperatureTicks(temperatureC);
    const rh = humidityTicks(humidityRh);
    const tBytes = [(t >> 8) & 0xff, t & 0xff];
    const rhBytes = [(rh >> 8) & 0xff, rh & 0xff];
    return Uint8Array.from([...tBytes, sht4xCrc(tBytes), ...rhBytes, sht4xCrc(rhBytes)]);
  }

  return {
    driverId: SHT4X_DRIVER_ID,

    onControl(channel: string, _action: SimulationControlAction, value: boolean | number) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      if (channel === SHT4X_TEMPERATURE_CHANNEL) temperatureC = clampToRange(spec, channel, value);
      else if (channel === SHT4X_HUMIDITY_CHANNEL) humidityRh = clampToRange(spec, channel, value);
      else {
        ctx.diagnoseOnce(`control:${channel}`, {
          code: 'unsupported_device',
          severity: 'info',
          message: `控件通道「${channel}」在 SHT4x 驱动中没有实现，已忽略。`
        });
      }
      // A slider moved mid-conversion does not rewrite a measurement already taken:
      // the sensor sampled the world when the command arrived, like the real one.
    },

    onI2cWrite(_address: number, bytes: Uint8Array, _stop: boolean): I2cAck {
      if (bytes.length === 0) return 'ack'; // a probe
      const command = bytes[0]!;
      const conversionUs = MEASURE_US[command];
      if (conversionUs !== undefined) {
        // Sampled now, readable later. That gap is the whole point.
        pending = { readyAtUs: ctx.nowUs() + conversionUs, bytes: sample() };
        return 'ack';
      }
      if (command === SOFT_RESET) {
        pending = null;
        return 'ack';
      }
      if (command === READ_SERIAL) {
        const serial = [0x0f, 0xa1, 0x0b, 0xee];
        pending = { readyAtUs: ctx.nowUs() + SOFT_RESET_US, bytes: Uint8Array.from([serial[0]!, serial[1]!, sht4xCrc([serial[0]!, serial[1]!]), serial[2]!, serial[3]!, sht4xCrc([serial[2]!, serial[3]!])]) };
        return 'ack';
      }
      if (HEATER.has(command)) return 'ack';
      ctx.diagnoseOnce(`cmd:${command}`, {
        code: 'i2c_unknown_command',
        severity: 'warning',
        message: `SHT4x 收到未实现的命令 0x${command.toString(16)}，已忽略。`
      });
      return 'ack';
    },

    onI2cRead(_address: number, length: number): Uint8Array | null {
      if (!pending) {
        ctx.diagnoseOnce('read:no-command', {
          code: 'i2c_nack',
          severity: 'warning',
          message: '读取 SHT4x 之前没有发送测量命令：先写入 0xFD（高精度）再读 6 字节。'
        });
        return null;
      }
      if (ctx.nowUs() < pending.readyAtUs) {
        // Exactly what the hardware does, and the reason a missing `sleep` is a bug.
        ctx.diagnoseOnce('read:too-early', {
          code: 'i2c_nack',
          severity: 'warning',
          message: `测量还没完成就来读取：SHT4x 高精度转换需要约 ${Math.round(MEASURE_US[0xfd]! / 1000)} ms，请在命令与读取之间 await sleep(10)。`
        });
        return null;
      }
      const bytes = pending.bytes;
      pending = null;
      return length >= bytes.length ? bytes : bytes.slice(0, length);
    }
  };
}
