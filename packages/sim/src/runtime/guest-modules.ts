/**
 * Guest-visible module sources (plan §6.3, §6.4).
 *
 * These strings are the *entire* API surface a Studio TS program can import.
 * They run inside QuickJS, so they are plain ES2020 JavaScript — no TypeScript,
 * no host imports. Everything they need from the host arrives through the
 * `__bbs*` functions the sandbox installs on `globalThis`; every value that
 * crosses the boundary is a JSON string or a plain number.
 *
 * The host bridge is deliberately reachable from guest code. It exposes exactly
 * the same capabilities as `@bbs/runtime`, so calling it directly can only
 * break the caller's own program — it is not an escape hatch.
 */

/** I²C status codes shared by the guest runtime and the host bridge (plan §6.3). */
export const I2C_STATUS = {
  OK: 0,
  NACK_ADDRESS: 2,
  NACK_DATA: 3,
  ERR_BUS: 4,
  COLLISION: 5
} as const;

export type I2cStatusCode = (typeof I2C_STATUS)[keyof typeof I2C_STATUS];

/** `@bbs/runtime` — the Arduino-shaped API described by plan §6.3. */
export const BBS_RUNTIME_SOURCE = `const G = globalThis;

export const LOW = 0;
export const HIGH = 1;

export const INPUT = 0;
export const OUTPUT = 1;
export const INPUT_PULLUP = 2;

export const I2C_OK = ${I2C_STATUS.OK};
export const I2C_NACK_ADDRESS = ${I2C_STATUS.NACK_ADDRESS};
export const I2C_NACK_DATA = ${I2C_STATUS.NACK_DATA};
export const I2C_ERR_BUS = ${I2C_STATUS.ERR_BUS};
export const I2C_COLLISION = ${I2C_STATUS.COLLISION};

const HEX = '0123456789abcdef';

function toHex(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const n = bytes.length >>> 0;
  let out = '';
  for (let i = 0; i < n; i++) {
    const b = bytes[i] & 0xff;
    out += HEX[b >> 4] + HEX[b & 0x0f];
  }
  return out;
}

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length < 2) return new Uint8Array(0);
  const n = (hex.length / 2) | 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) & 0xff;
  return out;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (e) {
      return String(value);
    }
  }
  return String(value);
}

/** Virtual microseconds. The guest has no Date, so this is the only clock. */
export function micros() {
  return G.__bbsMicros();
}

export function millis() {
  return Math.floor(G.__bbsMicros() / 1000);
}

export function sleepUs(us) {
  return G.__bbsSleep(us);
}

export function sleep(ms) {
  return G.__bbsSleep(Math.round(ms * 1000));
}

export const gpio = {
  pinMode(pin, mode) {
    G.__bbsPinMode(pin, mode);
  },
  digitalWrite(pin, value) {
    G.__bbsDigitalWrite(pin, value ? 1 : 0);
  },
  /** Z and X read as 0; the host raises floating_input / digital_contention. */
  digitalRead(pin) {
    return JSON.parse(G.__bbsDigitalRead(pin)) === 1 ? 1 : 0;
  },
  digitalReadRaw(pin) {
    return JSON.parse(G.__bbsDigitalRead(pin));
  }
};

export const Serial = {
  begin(baud) {
    G.__bbsSerialBegin(baud);
  },
  print(value) {
    G.__bbsSerialWrite(textOf(value));
  },
  println(value) {
    G.__bbsSerialWrite(value === undefined ? '\\n' : textOf(value) + '\\n');
  },
  write(value) {
    G.__bbsSerialWrite(textOf(value));
  }
};

let lastStatus = I2C_OK;

export const Wire = {
  /** Synchronous: resolving the bus is static analysis, it costs no virtual time. */
  begin(options) {
    lastStatus = JSON.parse(G.__bbsWireBegin(JSON.stringify(options || {})));
    return lastStatus;
  },
  end() {
    G.__bbsWireEnd();
  },
  setClock(hz) {
    G.__bbsWireSetClock(hz);
  },
  async write(address, bytes) {
    lastStatus = JSON.parse(await G.__bbsWireWrite(address, toHex(bytes)));
    return lastStatus;
  },
  /** Returns a zero-length array when the transaction failed; check lastStatus. */
  async read(address, length) {
    const r = JSON.parse(await G.__bbsWireRead(address, length));
    lastStatus = r.status;
    return fromHex(r.hex);
  },
  async writeRead(address, bytes, readLength) {
    const r = JSON.parse(await G.__bbsWireWriteRead(address, toHex(bytes), readLength));
    lastStatus = r.status;
    return fromHex(r.hex);
  },
  async probe(address) {
    return (await Wire.write(address, [])) === I2C_OK;
  },
  async scan() {
    const found = [];
    for (let address = 0x08; address <= 0x77; address++) {
      if (await Wire.probe(address)) found.push(address);
    }
    return found;
  },
  get lastStatus() {
    return lastStatus;
  }
};

export const board = {
  get model() {
    return JSON.parse(G.__bbsBoardModel());
  },
  rgb(r, g, b) {
    G.__bbsBoardRgb(r, g, b);
  }
};
`;

/**
 * 5×7 glyphs for ASCII 0x20–0x7E: 95 characters × 5 columns = 475 bytes.
 * Column-major, bit 0 = top row — the same layout the SSD1306 GDDRAM uses.
 */
const FONT5X7_HEX =
  '000000000000005f00000007000700147f147f14242a7f2a12231308646236495522500005030000001c2241000041221c00' +
  '14083e081408083e080800503000000808080808006060000020100804023e5149453e00427f400042615149462141454b31' +
  '1814127f1027454545393c4a49493001710905033649494936064949291e0036360000005636000000081422411414141414' +
  '41221408000201510906324979413e7e1111117e7f494949363e414141227f4141221c7f494949417f090901013e41415132' +
  '7f0808087f00417f41002040413f017f081422417f404040407f0204027f7f0408107f3e4141413e7f090909063e4151215e' +
  '7f09192946464949493101017f01013f4040403f1f2040201f7f2018207f63140814630304780403615149454300007f4141' +
  '020408102041417f000004020102044040404040000102040020545454787f484444383844444420384444487f3854545418' +
  '087e0901020c5252523e7f0804047800447d40002040443d007f1028440000417f40007c041804787c080404783844444438' +
  '7c14141408081414187c7c080404084854545420043f4440203c4040207c1c2040201c3c4030403c44281028440c5050503c' +
  '4464544c44000836410000007f0000004136080008082a1c08';

/**
 * `@bbs/devices/ssd1306` — plan §6.4.
 *
 * The framebuffer lives here, in the guest, and every byte reaches the panel
 * through `Wire.write`. There is deliberately no direct channel to the display
 * driver: a cut SDA wire, a wrong address and an unpowered panel have to stay
 * distinguishable, and a back door would make all three look like success.
 */
export const BBS_SSD1306_SOURCE = `import { I2C_OK } from '@bbs/runtime';

const FONT = '${FONT5X7_HEX}';
const FIRST_CHAR = 0x20;
const LAST_CHAR = 0x7e;
const FALLBACK_CHAR = 0x3f;

function glyphColumn(code, col) {
  let c = code;
  if (!(c >= FIRST_CHAR && c <= LAST_CHAR)) c = FALLBACK_CHAR;
  const at = ((c - FIRST_CHAR) * 5 + col) * 2;
  return parseInt(FONT.slice(at, at + 2), 16);
}

export class SSD1306 {
  constructor(wire, address, width, height) {
    this.wire = wire;
    this.address = address === undefined ? 0x3c : address;
    this.width = width === undefined ? 128 : width;
    this.height = height === undefined ? 64 : height;
    this.pages = this.height >> 3;
    this.buffer = new Uint8Array(this.width * this.pages);
    this.pen = 1;
    this.ready = false;
  }

  async writeCommands(bytes) {
    const payload = new Uint8Array(bytes.length + 1);
    payload[0] = 0x00;
    payload.set(bytes, 1);
    return (await this.wire.write(this.address, payload)) === I2C_OK;
  }

  /** True when the first transaction was acknowledged; false marks the panel unusable. */
  async begin() {
    this.ready = await this.writeCommands([
      0xae, 0xd5, 0x80, 0xa8, (this.height - 1) & 0xff, 0xd3, 0x00, 0x40,
      0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, this.height === 32 ? 0x02 : 0x12,
      0x81, 0xcf, 0xd9, 0xf1, 0xdb, 0x40, 0xa4, 0xa6, 0x2e, 0xaf
    ]);
    return this.ready;
  }

  clear() {
    this.buffer.fill(0);
  }

  setColor(pen) {
    this.pen = pen === 'white' || pen === 1 ? 1 : 0;
  }

  /** \`on === false\` erases with the opposite of the current pen. */
  pixel(x, y, on) {
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const bit = on === false ? (this.pen ? 0 : 1) : this.pen;
    const at = (py >> 3) * this.width + px;
    const mask = 1 << (py & 7);
    if (bit) this.buffer[at] |= mask;
    else this.buffer[at] &= ~mask & 0xff;
  }

  text(x, y, s) {
    const str = String(s);
    const top = y | 0;
    let cx = x | 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      for (let col = 0; col < 5; col++) {
        const bits = glyphColumn(code, col);
        for (let row = 0; row < 7; row++) {
          if (bits & (1 << row)) this.pixel(cx + col, top + row, true);
        }
      }
      cx += 6;
      if (cx >= this.width) break;
    }
  }

  /** One command transaction to set the window, then one data transaction per page. */
  async show() {
    if (!this.ready) return false;
    if (!(await this.writeCommands([0x21, 0, (this.width - 1) & 0xff, 0x22, 0, (this.pages - 1) & 0xff]))) {
      return false;
    }
    for (let page = 0; page < this.pages; page++) {
      const chunk = new Uint8Array(this.width + 1);
      chunk[0] = 0x40;
      chunk.set(this.buffer.subarray(page * this.width, (page + 1) * this.width), 1);
      if ((await this.wire.write(this.address, chunk)) !== I2C_OK) return false;
    }
    return true;
  }

  async displayOn(on) {
    return this.writeCommands([on ? 0xaf : 0xae]);
  }

  async invert(on) {
    return this.writeCommands([on ? 0xa7 : 0xa6]);
  }

  async setContrast(v) {
    return this.writeCommands([0x81, v & 0xff]);
  }
}
`;

/**
 * The module whitelist handed to `rt.setModuleLoader`. Anything not keyed here
 * is refused — that loader is the real gate; the scan in `compile.ts` only
 * moves the same error earlier so the user sees a line number.
 */
export const GUEST_MODULES: Readonly<Record<string, string>> = Object.freeze({
  '@bbs/runtime': BBS_RUNTIME_SOURCE,
  '@bbs/devices/ssd1306': BBS_SSD1306_SOURCE
});

/** Importable specifiers, in a stable order for messages and tests. */
export const GUEST_MODULE_SPECIFIERS: readonly string[] = Object.freeze(Object.keys(GUEST_MODULES));

export function isGuestModuleSpecifier(specifier: string): boolean {
  return Object.prototype.hasOwnProperty.call(GUEST_MODULES, specifier);
}
