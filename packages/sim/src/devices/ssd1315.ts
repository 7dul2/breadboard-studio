/**
 * `display.ssd1315@1` — the 0.96" I²C OLED module (plan §7.4).
 *
 * The driver is a GDDRAM plus a command decoder. It never sees a wire: the bus
 * hands it whole transactions, and it answers with an ACK or a NACK. That is the
 * point — a cut SDA, a wrong address and an unpowered panel all fail *before* this
 * file runs, so none of them can be faked into a working screen.
 *
 * Frame format: `<control byte> <payload…>`. Bit 6 (D/C#) picks command or data,
 * bit 7 (Co) means "one byte only, then another control byte". The built-in client
 * library only ever sends Co=0, but Co=1 is decoded too and pinned by a test.
 *
 * GDDRAM is 128 columns × 8 pages; one byte is eight vertically stacked pixels with
 * the LSB on top. Where the pointer goes next depends on the addressing mode, which
 * is the part programs actually get wrong, so all three modes are modelled.
 *
 * **Orientation.** `0xA1` (segment remap) and `0xC8` (COM scan decrement) are treated
 * as the identity, because that pair is what every real module's init sequence sends
 * to get an upright image — the panel's own wiring is mirrored and these undo it.
 * `0xA0` and `0xC0` therefore mirror x and y respectively. Modelling the panel wiring
 * properly is not worth it; this way the standard init looks right and a program that
 * flips one of them sees the flip.
 *
 * The module has no reset pin, so the MCU's RST button does **not** clear it (§7.4).
 */
import type { DeviceContext, DeviceDriver, DevicePower, I2cAck } from '../contracts.js';
import type { DeviceVisualState, SimDeviceSpec } from '../types.js';
import { displayColorCss } from './paint.js';

export const SSD1315_DRIVER_ID = 'display.ssd1315@1';

/** Catalog `simulation.visuals[].channel` of the panel. */
export const SSD1315_FRAMEBUFFER_CHANNEL = 'framebuffer';
export const SSD1315_DEFAULT_FEATURE = '128×64 OLED';
export const SSD1315_DEFAULT_ADDRESS = 0x3c;

const COLUMNS = 128;
const PAGES = 8;

/** Commands that take one parameter byte, and the state each writes into. */
const ONE_ARG = new Set([0x20, 0x81, 0xa8, 0xd3, 0xd5, 0xd9, 0xdb, 0x8d, 0xda]);
/** Commands that take two parameter bytes (column window, page window). */
const TWO_ARG = new Set([0x21, 0x22]);

type Mode = 'horizontal' | 'vertical' | 'page';
const MODES: Record<number, Mode> = { 0: 'horizontal', 1: 'vertical', 2: 'page' };

function intProp(spec: SimDeviceSpec, key: string, fallback: number): number {
  const v = spec.properties?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
}

export function createSsd1315Driver(ctx: DeviceContext): DeviceDriver {
  const spec = ctx.spec;
  const width = Math.max(1, intProp(spec, 'width', 128));
  const height = Math.max(1, intProp(spec, 'height', 64));
  const address = intProp(spec, 'i2c_address', SSD1315_DEFAULT_ADDRESS);
  const color = displayColorCss(spec.properties?.display_color);
  const feature = spec.visuals?.find((v) => v.channel === SSD1315_FRAMEBUFFER_CHANNEL)?.featureLabel ?? spec.visuals?.[0]?.featureLabel ?? SSD1315_DEFAULT_FEATURE;

  const gddram = new Uint8Array(COLUMNS * PAGES);
  let displayOn = false;
  let inverse = false;
  let entireOn = false;
  let contrast = 0xff;
  let mode: Mode = 'page';
  let column = 0;
  let page = 0;
  let colStart = 0;
  let colEnd = COLUMNS - 1;
  let pageStart = 0;
  let pageEnd = PAGES - 1;
  let segRemap = true; // 0xA1, the orientation every module ships with
  let comScanDec = true; // 0xC8, likewise
  let powered = ctx.power().powered;
  let dirty = true;

  /** Pending parameter bytes of a multi-byte command. */
  let awaiting: { opcode: number; need: number; args: number[] } | null = null;

  function paint(): void {
    const pixels = new Uint8Array(width * height);
    const lit = powered && displayOn;
    if (lit) {
      const level = Math.max(0, Math.min(255, contrast));
      for (let p = 0; p < PAGES; p++) {
        for (let c = 0; c < COLUMNS; c++) {
          const byte = gddram[p * COLUMNS + c]!;
          for (let bit = 0; bit < 8; bit++) {
            const x = segRemap ? c : COLUMNS - 1 - c;
            const yRaw = p * 8 + bit;
            const y = comScanDec ? yRaw : height - 1 - yRaw;
            if (x >= width || y >= height || y < 0) continue;
            let on = entireOn || ((byte >> bit) & 1) === 1;
            if (inverse) on = !on;
            if (on) pixels[y * width + x] = level;
          }
        }
      }
    }
    const state: DeviceVisualState = { kind: 'display', feature, width, height, pixels, color, enabled: lit };
    ctx.visual([state]);
    dirty = false;
  }

  function flushIfDirty(): void {
    if (dirty) paint();
  }

  function writeData(byte: number): void {
    gddram[page * COLUMNS + column] = byte & 0xff;
    dirty = true;
    // Pointer advance is the whole difference between the three modes.
    if (mode === 'vertical') {
      page++;
      if (page > pageEnd) {
        page = pageStart;
        column++;
        if (column > colEnd) column = colStart;
      }
      return;
    }
    // Page addressing ignores the column/page window entirely and wraps inside its
    // own page — the classic "why is my second line overwriting the first". Being
    // faithful here is the point: a program that forgets 0x20 must see that bug.
    if (mode === 'page') {
      column = (column + 1) % COLUMNS;
      return;
    }
    column++;
    if (column <= colEnd) return;
    column = colStart;
    page++;
    if (page > pageEnd) page = pageStart;
  }

  function applyCommand(opcode: number, args: number[]): void {
    if (opcode >= 0xb0 && opcode <= 0xb7) {
      page = opcode - 0xb0;
      return;
    }
    if (opcode <= 0x0f) {
      column = (column & 0xf0) | opcode;
      return;
    }
    if (opcode >= 0x10 && opcode <= 0x1f) {
      column = (column & 0x0f) | ((opcode - 0x10) << 4);
      return;
    }
    if (opcode >= 0x40 && opcode <= 0x7f) return; // display start line: accepted, not modelled
    switch (opcode) {
      case 0x20:
        mode = MODES[args[0]! & 0x03] ?? 'page';
        return;
      // The two window commands are documented as horizontal/vertical only; in page
      // mode the panel ignores them, so the pointer must not jump either.
      case 0x21:
        colStart = Math.min(COLUMNS - 1, args[0]! & 0x7f);
        colEnd = Math.min(COLUMNS - 1, args[1]! & 0x7f);
        if (colEnd < colStart) colEnd = COLUMNS - 1;
        if (mode !== 'page') column = colStart;
        return;
      case 0x22:
        pageStart = Math.min(PAGES - 1, args[0]! & 0x07);
        pageEnd = Math.min(PAGES - 1, args[1]! & 0x07);
        if (pageEnd < pageStart) pageEnd = PAGES - 1;
        if (mode !== 'page') page = pageStart;
        return;
      case 0x81:
        contrast = args[0]! & 0xff;
        dirty = true;
        return;
      case 0xa0:
      case 0xa1:
        segRemap = opcode === 0xa1;
        dirty = true;
        return;
      case 0xa4:
      case 0xa5:
        entireOn = opcode === 0xa5;
        dirty = true;
        return;
      case 0xa6:
      case 0xa7:
        inverse = opcode === 0xa7;
        dirty = true;
        return;
      case 0xae:
      case 0xaf:
        displayOn = opcode === 0xaf;
        dirty = true;
        return;
      case 0xc0:
      case 0xc8:
        comScanDec = opcode === 0xc8;
        dirty = true;
        return;
      // Accepted and stored nowhere: they configure panel electricals this model
      // has no opinion about. They are on the list because a standard init sends
      // them, and warning about a correct init sequence would be pure noise.
      case 0xa8: // multiplex ratio
      case 0xd3: // display offset
      case 0xd5: // clock divide
      case 0xd9: // pre-charge
      case 0xdb: // VCOMH deselect
      case 0x8d: // charge pump
      case 0xda: // COM pins hardware configuration
      case 0x2e: // deactivate scroll
      case 0x2f: // activate scroll
      case 0xe3: // NOP
        return;
      default:
        // State is kept: a panel that met one command it did not know is still
        // usable, and losing the framebuffer would be a far worse failure.
        ctx.diagnoseOnce(`cmd:${opcode}`, {
          code: 'i2c_unknown_command',
          severity: 'warning',
          message: `OLED 收到未实现的命令 0x${opcode.toString(16)}，已忽略（显示状态保留）。`
        });
    }
  }

  function feed(byte: number, isData: boolean): void {
    if (isData) {
      writeData(byte);
      return;
    }
    if (awaiting) {
      awaiting.args.push(byte);
      if (awaiting.args.length < awaiting.need) return;
      const { opcode, args } = awaiting;
      awaiting = null;
      applyCommand(opcode, args);
      return;
    }
    if (ONE_ARG.has(byte)) {
      awaiting = { opcode: byte, need: 1, args: [] };
      return;
    }
    if (TWO_ARG.has(byte)) {
      awaiting = { opcode: byte, need: 2, args: [] };
      return;
    }
    applyCommand(byte, []);
  }

  // Register on the bus and show the (blank, off) panel straight away, so an OLED
  // that is never addressed still reports itself as present but dark.
  const bus = spec.i2c?.buses?.[0];
  if (bus) ctx.attachI2c(bus.sdaPin, bus.sclPin, [address]);
  paint();

  return {
    driverId: SSD1315_DRIVER_ID,

    onPowerChange(next: DevicePower) {
      if (next.powered === powered) return;
      powered = next.powered;
      // Losing power blanks the panel but keeps GDDRAM, exactly like the real one:
      // the picture comes back the moment the rail does, without a redraw.
      dirty = true;
      paint();
    },

    onI2cWrite(_address: number, bytes: Uint8Array, _stop: boolean): I2cAck {
      // A zero-length write is a probe (`Wire.probe`), which only asks "are you there".
      if (bytes.length === 0) return 'ack';
      let i = 0;
      while (i < bytes.length) {
        const control = bytes[i++]!;
        const single = (control & 0x80) !== 0;
        const isData = (control & 0x40) !== 0;
        if (single) {
          if (i < bytes.length) feed(bytes[i++]!, isData);
          continue;
        }
        while (i < bytes.length) feed(bytes[i++]!, isData);
      }
      flushIfDirty();
      return 'ack';
    },

    onI2cRead(): Uint8Array | null {
      // The panel is write-only in this model; a read gets a data NACK rather than
      // zeros that a program might mistake for a status register.
      return null;
    },

    dispose() {
      awaiting = null;
    }
  };
}
