/**
 * `sensor.sen6x@1` — Sensirion SEN66 air-quality module (阶段 4).
 *
 * Sensirion's other protocol shape: **16-bit command words**, and every 16-bit data
 * word followed by its own CRC. Between this, the SHT4x (8-bit commands) and the
 * LTR390 (register pointer), the three ways a real I²C part is addressed are all
 * modelled, which is what makes a program written against a real library work here.
 *
 * The module only answers measurement reads while it is measuring — `0x0021` starts
 * it, `0x0104` stops it — and a read before the first measurement period has elapsed
 * NACKs, exactly like the part. A program that starts the module and immediately
 * reads gets nothing, which is the bug it would hit on the bench.
 *
 * All nine quantities are independent sliders. Physically PM1 ≤ PM2.5 ≤ PM4 ≤ PM10,
 * and nothing here enforces that: the simulator reports what the sliders say, and
 * inventing atmospheric constraints would be a different kind of lie.
 *
 * **Command words and scale factors are from the datasheet and unverified against
 * silicon** (same status as the SSD1315, SHT4x and LTR390 encodings); tests pin them.
 */
import type { SimulationControlAction } from '@breadboard-studio/schema';
import type { DeviceContext, DeviceDriver, I2cAck } from '../contracts.js';
import type { SimDeviceSpec } from '../types.js';
import { sht4xCrc } from './sht4x.js';

export const SEN6X_DRIVER_ID = 'sensor.sen6x@1';
export const SEN6X_DEFAULT_ADDRESS = 0x6b;

const CMD = {
  START_MEASUREMENT: 0x0021,
  STOP_MEASUREMENT: 0x0104,
  DATA_READY: 0x0202,
  READ_VALUES: 0x0300,
  DEVICE_RESET: 0xd304
} as const;

/** First measurement is available about one period after the module starts. */
export const SEN6X_WARMUP_US = 1_100_000;

/**
 * The nine measured values, in the order the module reports them, with the scale
 * the datasheet applies: the wire carries an integer, the unit is the value ÷ scale.
 */
export const SEN6X_CHANNELS: readonly { channel: string; scale: number; fallback: number }[] = [
  { channel: 'pm1_ugm3', scale: 10, fallback: 8 },
  { channel: 'pm25_ugm3', scale: 10, fallback: 12 },
  { channel: 'pm4_ugm3', scale: 10, fallback: 14 },
  { channel: 'pm10_ugm3', scale: 10, fallback: 16 },
  { channel: 'humidity_rh', scale: 100, fallback: 45 },
  { channel: 'temperature_c', scale: 200, fallback: 22 },
  { channel: 'voc_index', scale: 10, fallback: 100 },
  { channel: 'nox_index', scale: 10, fallback: 1 },
  { channel: 'co2_ppm', scale: 1, fallback: 650 }
];

/** Sensirion frames: each 16-bit word is followed by a CRC over its two bytes. */
export function wordsWithCrc(words: readonly number[]): Uint8Array {
  const out = new Uint8Array(words.length * 3);
  words.forEach((word, i) => {
    const hi = (word >> 8) & 0xff;
    const lo = word & 0xff;
    out[i * 3] = hi;
    out[i * 3 + 1] = lo;
    out[i * 3 + 2] = sht4xCrc([hi, lo]);
  });
  return out;
}

/** Signed 16-bit on the wire: temperature can be negative. */
function toWord(value: number, scale: number): number {
  const raw = Math.round(value * scale);
  const clamped = Math.max(-32768, Math.min(65535, raw));
  return clamped < 0 ? (clamped + 0x10000) & 0xffff : clamped & 0xffff;
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

export function createSen6xDriver(ctx: DeviceContext): DeviceDriver {
  const spec = ctx.spec;
  const address = typeof spec.properties?.i2c_address === 'number' ? spec.properties.i2c_address : SEN6X_DEFAULT_ADDRESS;

  const values = new Map<string, number>();
  for (const { channel, fallback } of SEN6X_CHANNELS) values.set(channel, rangeDefault(spec, channel, fallback));

  /** Virtual time the first reading becomes available, or null while stopped. */
  let readyAtUs: number | null = null;
  let lastCommand = 0;

  const bus = spec.i2c?.buses?.[0];
  if (bus) ctx.attachI2c(bus.sdaPin, bus.sclPin, [address]);

  const measuring = () => readyAtUs !== null;
  const dataReady = () => readyAtUs !== null && ctx.nowUs() >= readyAtUs;

  function measurement(): Uint8Array {
    return wordsWithCrc(SEN6X_CHANNELS.map(({ channel, scale }) => toWord(values.get(channel) ?? 0, scale)));
  }

  return {
    driverId: SEN6X_DRIVER_ID,

    onControl(channel: string, _action: SimulationControlAction, value: boolean | number) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      if (!values.has(channel)) {
        ctx.diagnoseOnce(`control:${channel}`, {
          code: 'unsupported_device',
          severity: 'info',
          message: `控件通道「${channel}」在 SEN6x 驱动中没有实现，已忽略。`
        });
        return;
      }
      values.set(channel, clampToRange(spec, channel, value));
    },

    onI2cWrite(_address: number, bytes: Uint8Array, _stop: boolean): I2cAck {
      if (bytes.length === 0) return 'ack'; // a probe
      if (bytes.length < 2) {
        ctx.diagnoseOnce('cmd:short', {
          code: 'i2c_unknown_command',
          severity: 'warning',
          message: 'SEN6x 的命令是 16 位字：只发了一个字节，已忽略。'
        });
        return 'ack';
      }
      const command = ((bytes[0]! << 8) | bytes[1]!) & 0xffff;
      lastCommand = command;
      if (command === CMD.START_MEASUREMENT) {
        // Starting again while running does not restart the warm-up.
        if (readyAtUs === null) readyAtUs = ctx.nowUs() + SEN6X_WARMUP_US;
        return 'ack';
      }
      if (command === CMD.STOP_MEASUREMENT || command === CMD.DEVICE_RESET) {
        readyAtUs = null;
        return 'ack';
      }
      if (command === CMD.DATA_READY || command === CMD.READ_VALUES) return 'ack';
      ctx.diagnoseOnce(`cmd:${command}`, {
        code: 'i2c_unknown_command',
        severity: 'warning',
        message: `SEN6x 收到未实现的命令 0x${command.toString(16).padStart(4, '0')}，已忽略。`
      });
      return 'ack';
    },

    onI2cRead(_address: number, length: number): Uint8Array | null {
      if (lastCommand === CMD.DATA_READY) {
        return wordsWithCrc([dataReady() ? 1 : 0]).slice(0, Math.min(length, 3));
      }
      if (lastCommand !== CMD.READ_VALUES) {
        ctx.diagnoseOnce('read:no-command', {
          code: 'i2c_nack',
          severity: 'warning',
          message: '读取 SEN6x 之前没有发送命令：先写 0x0300（读测量值）再读 27 字节。'
        });
        return null;
      }
      if (!measuring()) {
        ctx.diagnoseOnce('read:stopped', {
          code: 'i2c_nack',
          severity: 'warning',
          message: 'SEN6x 还没有开始测量：先写 0x0021 启动，再等一个测量周期。'
        });
        return null;
      }
      if (!dataReady()) {
        ctx.diagnoseOnce('read:too-early', {
          code: 'i2c_nack',
          severity: 'warning',
          message: `第一次测量还没完成：SEN6x 启动后约需 ${Math.round(SEN6X_WARMUP_US / 1000)} ms，请先轮询 0x0202 或等待再读。`
        });
        return null;
      }
      const bytes = measurement();
      return length >= bytes.length ? bytes : bytes.slice(0, length);
    }
  };
}
