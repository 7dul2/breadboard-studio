/**
 * `mcu.esp32s3.behavioral@1` — the behavioural ESP32-S3 (plan §7.2).
 *
 * The driver owns three things and nothing else: the GPIO registers (`mode` +
 * `out`) and how they resolve onto the nets, the BOOT button, and the on-board
 * RGB LED plus the UART line buffer. It does not model the two cores, the
 * flash/PSRAM sizes, Wi-Fi, or the WS2812 wire protocol of the RGB LED.
 *
 * Everything reaches the outside world through `DeviceContext`: there is no way
 * from here to another device, and `netId` is only ever compared for equality
 * (spec §3.4). The guest runtime addresses pins by GPIO *number*, so the driver
 * builds a reverse table from `spec.pinChannels` (36 entries on the N16R8,
 * including `TX → 43`, `RX → 44`, `GPIO48 → 48`).
 */
import type { SimulationControlAction } from '@breadboard-studio/schema';
import type { DeviceContext, DeviceDriver, DevicePower } from '../contracts.js';
import { SIM_DIAGNOSTIC_SEVERITY, type DeviceVisualState, type DigitalValue, type DriveStrength } from '../types.js';
import { clampRgb, type Rgb } from './paint.js';

export const ESP32S3_DRIVER_ID = 'mcu.esp32s3.behavioral@1';

/** Same numbering as `@bbs/runtime` (plan §6.3). */
export const PIN_MODE = { INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2 } as const;
export type PinMode = (typeof PIN_MODE)[keyof typeof PIN_MODE];

/**
 * Feature labels the driver paints on. They are catalog `feature_label`s, but
 * `SimDeviceSpec` carries no `controls`/`visuals` (plan §3), so the driver
 * names its own channels: BOOT/RST are `press` controls and may carry a
 * `pressed` visual without any `visuals[]` binding (plan §7.1).
 */
export const MCU_FEATURES = { rgb: 'RGB', boot: 'BOOT', reset: 'RST' } as const;

const RGB_ON: Rgb = [255, 255, 255];
const RGB_OFF: Rgb = [0, 0, 0];
const STRENGTH_RANK: Readonly<Record<DriveStrength, number>> = { weak: 0, pull: 1, strong: 2 };

/**
 * What the guest runtime's host bridge calls on the MCU driver. The pin
 * arguments are GPIO numbers, exactly what `gpio.pinMode(4, OUTPUT)` passes.
 * Anything the guest can get wrong (an unknown GPIO number, an illegal mode)
 * throws, so the sandbox turns it into a `program_runtime_error` at the guest's
 * own source location (plan §6.6).
 */
export interface McuHostApi {
  /** `board.model` in the guest. */
  readonly model: string;
  /** Pin name of a GPIO number. Throws when the board has no such GPIO. */
  pinNameOf(gpio: number): string;
  pinMode(gpio: number, mode: number): void;
  digitalWrite(gpio: number, value: number | boolean): void;
  /** `Z`/`X` read as 0; the kernel raises the warning on the way (plan §5.1). */
  digitalRead(gpio: number): 0 | 1;
  digitalReadRaw(gpio: number): DigitalValue;
  /** `board.rgb(r, g, b)`: the on-board LED, without decoding WS2812 timing. */
  rgb(r: number, g: number, b: number): void;
  serialBegin(baud: number): void;
  /** `Serial.print`/`println` text; lines are cut on `\n` here, not in the guest. */
  serialWrite(text: string): void;
  /** Emit the unterminated remainder (session end / dispose). */
  flushSerial(): void;
  /**
   * The RST button is consumed by the worker session, not dispatched to
   * drivers (plan §6.5), so the session mirrors both edges here to keep the
   * `pressed` visual complete.
   */
  setResetButton(held: boolean): void;
}

export function isMcuHostApi(driver: DeviceDriver | null): driver is DeviceDriver & McuHostApi {
  return driver !== null && typeof (driver as Partial<McuHostApi>).pinMode === 'function' && typeof (driver as Partial<McuHostApi>).digitalWrite === 'function';
}

function asGpioNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export class Esp32S3Driver implements DeviceDriver, McuHostApi {
  readonly driverId = ESP32S3_DRIVER_ID;

  private readonly ctx: DeviceContext;
  /** GPIO number → pin name. First entry wins when a board repeats a number. */
  private readonly byGpio = new Map<number, string>();
  private readonly modes = new Map<string, PinMode>();
  private readonly outs = new Map<string, 0 | 1>();
  /** Pins this driver currently holds a driving end on. */
  private readonly driven = new Set<string>();
  /** Pins whose pad level is indeterminate because two internal sources fight. */
  private readonly indeterminate = new Set<string>();
  /** Pins with a contention diagnostic already reported (edge triggered). */
  private readonly reportedContention = new Set<string>();
  /** Timer handle → token, so `onReset` can cancel every timer we armed. */
  private readonly timers = new Map<number, number>();

  private readonly bootGpio: number | null;
  private readonly bootPin: string | null;
  private readonly rgbGpio: number | null;

  private bootPressed = false;
  private resetHeld = false;
  private rgbColor: Rgb = RGB_OFF;
  private powered: boolean;
  private uart = '';
  private uartBaud = 0;

  constructor(ctx: DeviceContext) {
    this.ctx = ctx;
    for (const [pin, channel] of Object.entries(ctx.spec.pinChannels)) {
      const gpio = asGpioNumber(channel);
      if (gpio === null || this.byGpio.has(gpio)) continue;
      this.byGpio.set(gpio, pin);
    }
    this.bootGpio = asGpioNumber(ctx.spec.properties.boot_gpio);
    this.bootPin = this.bootGpio === null ? null : (this.byGpio.get(this.bootGpio) ?? null);
    this.rgbGpio = asGpioNumber(ctx.spec.properties.rgb_gpio);
    this.powered = ctx.power().powered;
    if (!this.powered) this.reportUnpowered();
    this.publish();
  }

  get baud(): number {
    return this.uartBaud;
  }

  // -------------------------------------------------------------------------
  // Host API
  // -------------------------------------------------------------------------

  get model(): string {
    return this.ctx.spec.model;
  }

  pinNameOf(gpio: number): string {
    const pin = this.byGpio.get(gpio);
    if (pin === undefined) throw new Error(`GPIO ${gpio} does not exist on ${this.ctx.spec.model}`);
    return pin;
  }

  pinMode(gpio: number, mode: number): void {
    const pin = this.pinNameOf(gpio);
    if (mode !== PIN_MODE.INPUT && mode !== PIN_MODE.OUTPUT && mode !== PIN_MODE.INPUT_PULLUP) {
      throw new Error(`pinMode: unknown mode ${mode} (expected INPUT, OUTPUT or INPUT_PULLUP)`);
    }
    this.modes.set(pin, mode);
    this.apply(pin);
  }

  digitalWrite(gpio: number, value: number | boolean): void {
    const pin = this.pinNameOf(gpio);
    const level: 0 | 1 = value === true || value === 1 ? 1 : 0;
    this.outs.set(pin, level);
    this.apply(pin);
    // The on-board LED hangs off the board, not off a net: GPIO48 has no entry
    // in `pinNets`, so its state is read back from this register (plan §7.2).
    if (this.rgbGpio !== null && gpio === this.rgbGpio) {
      this.rgbColor = level === 1 ? RGB_ON : RGB_OFF;
      this.publish();
    }
  }

  digitalRead(gpio: number): 0 | 1 {
    return this.digitalReadRaw(gpio) === 1 ? 1 : 0;
  }

  digitalReadRaw(gpio: number): DigitalValue {
    const pin = this.pinNameOf(gpio);
    if (!this.powered) return 'Z';
    if (this.indeterminate.has(pin)) return 'X';
    return this.ctx.read(pin);
  }

  rgb(r: number, g: number, b: number): void {
    if (this.rgbGpio === null) return;
    this.rgbColor = this.powered ? clampRgb([r, g, b]) : RGB_OFF;
    this.publish();
  }

  serialBegin(baud: number): void {
    this.uartBaud = Number.isFinite(baud) ? baud : 0;
  }

  serialWrite(text: string): void {
    this.uart += text;
    for (let cut = this.uart.indexOf('\n'); cut >= 0; cut = this.uart.indexOf('\n')) {
      const line = this.uart.slice(0, cut);
      this.uart = this.uart.slice(cut + 1);
      this.ctx.serial('stdout', line);
    }
  }

  flushSerial(): void {
    if (this.uart.length === 0) return;
    const rest = this.uart;
    this.uart = '';
    this.ctx.serial('stdout', rest);
  }

  setResetButton(held: boolean): void {
    if (this.resetHeld === held) return;
    this.resetHeld = held;
    this.publish();
  }

  /**
   * Arm a timer owned by this driver. Nothing in v0.2 needs one (WS2812 timing
   * is not decoded), but `onReset('host')` must cancel every timer the MCU
   * armed, so they all go through here.
   */
  armTimer(delayUs: number, token: number): number {
    const handle = this.ctx.after(delayUs, token);
    this.timers.set(handle, token);
    return handle;
  }

  // -------------------------------------------------------------------------
  // DeviceDriver
  // -------------------------------------------------------------------------

  onControl(channel: string, action: SimulationControlAction, value: boolean | number): void {
    const pressed = value === true || (typeof value === 'number' && value !== 0);
    if (channel === 'boot') {
      if (this.bootGpio === null || this.bootPin === null) {
        this.ctx.diagnoseOnce('boot:unbound', {
          code: 'unsupported_device',
          severity: SIM_DIAGNOSTIC_SEVERITY.unsupported_device,
          message: '该开发板没有声明 BOOT 按键对应的 GPIO（simulation.properties.boot_gpio），按键被忽略。'
        });
        return;
      }
      if (this.bootPressed === pressed) return;
      this.bootPressed = pressed;
      this.apply(this.bootPin);
      this.publish();
      return;
    }
    if (channel === 'reset') {
      // The session owns this channel (plan §6.5); if it forwards the control
      // anyway, only the visual is updated here — never the program state.
      this.setResetButton(pressed);
      return;
    }
    this.ctx.diagnoseOnce(`control:${channel}`, {
      code: 'unsupported_device',
      severity: SIM_DIAGNOSTIC_SEVERITY.unsupported_device,
      message: `控件通道「${channel}」（${action}）在 ESP32-S3 驱动中没有实现，已忽略。`
    });
  }

  onPowerChange(power: DevicePower): void {
    if (power.powered === this.powered) return;
    this.powered = power.powered;
    if (!this.powered) {
      this.reportUnpowered();
      this.indeterminate.clear();
      this.reportedContention.clear();
      this.driven.clear();
      this.rgbColor = RGB_OFF;
      this.publish();
      return;
    }
    // Power is constant for a whole session (plan §5.2); this path only exists
    // so a re-powered device restores exactly the register state it had.
    for (const pin of new Set([...this.modes.keys(), ...(this.bootPin !== null ? [this.bootPin] : [])])) this.apply(pin);
    this.publish();
  }

  onTimer(token: number): void {
    for (const [handle, armed] of this.timers) {
      if (armed !== token) continue;
      this.timers.delete(handle);
      break;
    }
  }

  /**
   * `host` is the RST button, `session` a full simulator reset. Both cancel the
   * MCU's own timers, return every GPIO to INPUT and reset the UART. External
   * devices are deliberately untouched: the OLED keeps its GDDRAM and the
   * TTP223 keeps its latch (plan §7.2).
   */
  onReset(_scope: 'session' | 'host'): void {
    for (const handle of this.timers.keys()) this.ctx.cancel(handle);
    this.timers.clear();
    for (const pin of this.driven) this.ctx.release(pin);
    this.driven.clear();
    this.modes.clear();
    this.outs.clear();
    this.indeterminate.clear();
    this.reportedContention.clear();
    this.uart = '';
    this.uartBaud = 0;
    this.rgbColor = RGB_OFF;
    // The BOOT button is a physical button: a reset does not un-press it, so
    // its pull-down is re-applied on top of the freshly cleared registers.
    if (this.bootPin !== null && this.bootPressed) this.apply(this.bootPin);
    this.publish();
  }

  dispose(): void {
    for (const handle of this.timers.keys()) this.ctx.cancel(handle);
    this.timers.clear();
    this.flushSerial();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve the driver's own sources for one pin: the GPIO register and, on
   * `boot_gpio`, the BOOT button (a real board pulls that pin to ground through
   * the button). Two strong sources with different values are a genuine short.
   */
  private resolvePin(pin: string): { value: 0 | 1; strength: DriveStrength } | 'contention' | null {
    const sources: { value: 0 | 1; strength: DriveStrength }[] = [];
    const mode = this.modes.get(pin) ?? PIN_MODE.INPUT;
    if (mode === PIN_MODE.OUTPUT) sources.push({ value: this.outs.get(pin) ?? 0, strength: 'strong' });
    else if (mode === PIN_MODE.INPUT_PULLUP) sources.push({ value: 1, strength: 'pull' });
    if (pin === this.bootPin && this.bootPressed) sources.push({ value: 0, strength: 'strong' });
    if (sources.length === 0) return null;
    let top = 0;
    for (const source of sources) top = Math.max(top, STRENGTH_RANK[source.strength]);
    const winners = sources.filter((source) => STRENGTH_RANK[source.strength] === top);
    const first = winners[0] as { value: 0 | 1; strength: DriveStrength };
    if (winners.some((source) => source.value !== first.value)) return 'contention';
    return first;
  }

  private apply(pin: string): void {
    // Unpowered devices drive `Z` on every end; the kernel enforces that, the
    // driver just stops pushing (plan §5.2).
    if (!this.powered) return;
    const resolved = this.resolvePin(pin);
    if (resolved === 'contention') {
      this.indeterminate.add(pin);
      // A pressed BOOT button is a hard short to ground: the pad cannot hold a
      // high level, so the end keeps driving 0 while `digitalReadRaw` reports
      // the pad as X. `DeviceContext.drive` rejects `X` by contract.
      this.ctx.drive(pin, 0, 'strong');
      this.driven.add(pin);
      if (!this.reportedContention.has(pin)) {
        this.reportedContention.add(pin);
        this.ctx.diagnose({
          code: 'digital_contention',
          severity: SIM_DIAGNOSTIC_SEVERITY.digital_contention,
          message: `${pin} 同时被程序驱动为高电平和被按键拉到地，等效短路，电平不确定（X）。`,
          pinAddresses: [`${this.ctx.componentId}.${pin}`],
          ...(this.ctx.spec.pinNets[pin] ? { netIds: [this.ctx.netIdOf(pin)] } : {})
        });
      }
      return;
    }
    this.indeterminate.delete(pin);
    this.reportedContention.delete(pin);
    if (resolved === null) {
      if (this.driven.delete(pin)) this.ctx.release(pin);
      return;
    }
    this.ctx.drive(pin, resolved.value, resolved.strength);
    this.driven.add(pin);
  }

  private reportUnpowered(): void {
    this.ctx.diagnoseOnce('power:unpowered', {
      code: 'device_unpowered',
      severity: SIM_DIAGNOSTIC_SEVERITY.device_unpowered,
      // Not "the program will not run" — it does run, and its own serial output is
      // the proof. What is dead is every effect it could have: the pins stay Z and
      // `Wire.begin()` refuses, so a program can look busy and change nothing.
      message: '开发板未上电：程序照常执行，但所有引脚保持高阻、I²C 不可用，任何输出都不会生效。请在“仿真”面板勾选 USB 供电，或检查供电接线。'
    });
  }

  /**
   * Every visual channel of this device, every time: the UI replaces the array
   * for a componentId wholesale, so sending the LED and the buttons separately
   * would make them erase each other (plan §7.1).
   */
  private publish(): void {
    const states: DeviceVisualState[] = [];
    if (this.rgbGpio !== null) {
      states.push({ kind: 'led', feature: MCU_FEATURES.rgb, rgb: [...this.rgbColor] as Rgb, intensity: this.rgbColor.some((channel) => channel > 0) ? 1 : 0 });
    }
    if (this.bootGpio !== null) states.push({ kind: 'pressed', feature: MCU_FEATURES.boot, active: this.bootPressed });
    states.push({ kind: 'pressed', feature: MCU_FEATURES.reset, active: this.resetHeld });
    this.ctx.visual(states);
  }
}

export const createEsp32S3Driver = (ctx: DeviceContext): DeviceDriver => new Esp32S3Driver(ctx);
