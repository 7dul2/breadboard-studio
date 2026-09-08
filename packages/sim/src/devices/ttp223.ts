/**
 * `input.ttp223@1` — the TTP223 capacitive touch breakout (plan §7.3).
 *
 * The whole part is one bit: a finger on the pad. Everything else is the two
 * solder-pad options the module ships with — `output_mode` (A pad: which level
 * means "touched") and `toggle_mode` (B pad: momentary or latching) — plus the
 * power domain, which decides whether `IO` drives at all.
 *
 * Three deliberate simplifications, all from §7.3:
 *
 * - `config.supply_v` is **ignored**. The catalog carries it because a real
 *   module's output level follows VDD, but the power domain already computes
 *   the rail the module sits on, and two sources of truth for one voltage is
 *   how they drift apart. `ctx.power()` decides, `supply_v` does not.
 * - Touch events are accepted whether or not the module is powered; only the
 *   *output* is gated. An unpowered module that is touched therefore comes back
 *   driving the right level the moment power returns, which is what a user who
 *   ticked the USB box after touching the pad expects to see.
 * - No `onReset`: the MCU's RST button must not clear the latch (§7.2 — the
 *   OLED keeps its GDDRAM and the TTP223 keeps its toggle bit). A full session
 *   reset rebuilds every driver, so there is nothing to clear there either.
 */
import type { SimulationControlAction } from '@breadboard-studio/schema';
import type { DeviceContext, DeviceDriver, DevicePower } from '../contracts.js';
import { SIM_DIAGNOSTIC_SEVERITY, type DeviceVisualState, type SimDeviceSpec } from '../types.js';

export const TTP223_DRIVER_ID = 'input.ttp223@1';

/** Catalog `simulation.pins` channel of the module's single output pin. */
export const TTP223_OUTPUT_CHANNEL = 'out';
/** Catalog `simulation.controls[].channel` of the touch pad. */
export const TTP223_TOUCH_CHANNEL = 'touch';
/** Fallback feature label, used only when the spec carries no binding at all. */
export const TTP223_DEFAULT_FEATURE = '触摸区';

/** Control actions that carry a boolean contact state rather than a number. */
const CONTACT_ACTIONS: ReadonlySet<SimulationControlAction> = new Set<SimulationControlAction>(['touch', 'press', 'toggle']);

/**
 * The feature the pad is drawn on. Taken from `spec.visuals` first — that is
 * the binding the canvas hit-tests against — then from `spec.controls`, so a
 * catalog entry that only declares the control still lights up (§7.1).
 */
function touchFeatureLabel(spec: SimDeviceSpec): string {
  const visual = spec.visuals?.find((binding) => binding.channel === TTP223_TOUCH_CHANNEL) ?? spec.visuals?.[0];
  if (visual) return visual.featureLabel;
  const control = spec.controls?.find((binding) => binding.channel === TTP223_TOUCH_CHANNEL) ?? spec.controls?.[0];
  return control?.featureLabel ?? TTP223_DEFAULT_FEATURE;
}

/** Channels that feed the contact bit: the catalog's own, plus the documented default. */
function contactChannels(spec: SimDeviceSpec): ReadonlySet<string> {
  const channels = new Set<string>([TTP223_TOUCH_CHANNEL]);
  for (const control of spec.controls ?? []) {
    if (CONTACT_ACTIONS.has(control.action)) channels.add(control.channel);
  }
  return channels;
}

/** Pin name behind the `out` channel. The module has exactly one output. */
function outputPinOf(spec: SimDeviceSpec): string | null {
  for (const [pin, channel] of Object.entries(spec.pinChannels)) {
    if (channel === TTP223_OUTPUT_CHANNEL) return pin;
  }
  return null;
}

export class Ttp223Driver implements DeviceDriver {
  readonly driverId = TTP223_DRIVER_ID;

  private readonly ctx: DeviceContext;
  private readonly outPin: string | null;
  private readonly contactChannels: ReadonlySet<string>;
  private readonly feature: string;
  private readonly toggleMode: boolean;
  /** `active_low` is the only inverting mode; anything else keeps the catalog default. */
  private readonly activeLow: boolean;

  /** Finger on the pad right now. */
  private contact = false;
  /** Latch bit. Only `toggle_mode` reads it. */
  private latched = false;
  private powered: boolean;
  /** Level currently driven onto `outPin`, or null while the end is released. */
  private level: 0 | 1 | null = null;

  constructor(ctx: DeviceContext) {
    this.ctx = ctx;
    this.outPin = outputPinOf(ctx.spec);
    this.contactChannels = contactChannels(ctx.spec);
    this.feature = touchFeatureLabel(ctx.spec);
    this.toggleMode = ctx.spec.properties.toggle_mode === true;
    this.activeLow = ctx.spec.properties.output_mode === 'active_low';
    this.powered = ctx.power().powered;
    if (this.outPin === null) {
      this.ctx.diagnoseOnce('pins:no-output', {
        code: 'unsupported_device',
        severity: SIM_DIAGNOSTIC_SEVERITY.unsupported_device,
        message: `${ctx.spec.model} 没有声明输出引脚（simulation.pins 中缺少「${TTP223_OUTPUT_CHANNEL}」通道），触摸模块只会显示按压状态，不驱动任何网络。`
      });
    }
    if (!this.powered) this.reportUnpowered();
    this.apply();
    this.publish();
  }

  /** Logical pad state: the contact itself when momentary, the latch when toggling. */
  get active(): boolean {
    return this.toggleMode ? this.latched : this.contact;
  }

  /** Whether a finger is on the pad, regardless of `toggle_mode`. */
  get contacted(): boolean {
    return this.contact;
  }

  // -------------------------------------------------------------------------
  // DeviceDriver
  // -------------------------------------------------------------------------

  onControl(channel: string, action: SimulationControlAction, value: boolean | number): void {
    if (!this.contactChannels.has(channel)) {
      this.ctx.diagnoseOnce(`control:${channel}`, {
        code: 'unsupported_device',
        severity: SIM_DIAGNOSTIC_SEVERITY.unsupported_device,
        message: `控件通道「${channel}」（${action}）在 TTP223 驱动中没有实现，已忽略。`
      });
      return;
    }
    const contact = value === true || (typeof value === 'number' && value !== 0);
    // Level-triggered on the way in: holding the pad repeats the same `true`
    // through the canvas' pointer capture, and a repeat must not toggle again.
    if (contact === this.contact) return;
    this.contact = contact;
    // Latching happens on the press edge only; letting go leaves the bit alone.
    if (this.toggleMode && contact) this.latched = !this.latched;
    this.apply();
    this.publish();
  }

  onPowerChange(power: DevicePower): void {
    if (power.powered === this.powered) return;
    this.powered = power.powered;
    if (!this.powered) this.reportUnpowered();
    // Power is constant for a whole session (§5.2); this path exists so that a
    // module powered back up restores the level its current state implies.
    this.apply();
    this.publish();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve the output. Unpowered means high-impedance: the kernel forces `Z`
   * on every end of an unpowered device anyway (§5.2), and releasing here keeps
   * the driver's own bookkeeping honest instead of leaving a stale level behind.
   */
  private apply(): void {
    if (this.outPin === null) return;
    if (!this.powered) {
      if (this.level === null) return;
      this.level = null;
      this.ctx.release(this.outPin);
      return;
    }
    const level: 0 | 1 = this.active === this.activeLow ? 0 : 1;
    // Releasing the pad in `toggle_mode` changes the pad but not the wire, so
    // the resolved level is compared before touching the net: the driving log
    // then holds transitions only.
    if (this.level === level) return;
    this.level = level;
    // `pin_meta.IO.drive === 'push_pull'`: the module sources and sinks, so both
    // levels are strong. There is no pull-up option on the part.
    this.ctx.drive(this.outPin, level, 'strong');
  }

  private reportUnpowered(): void {
    this.ctx.diagnoseOnce('power:unpowered', {
      code: 'device_unpowered',
      severity: SIM_DIAGNOSTIC_SEVERITY.device_unpowered,
      message: '触摸模块未上电：IO 保持高阻，触摸不会产生任何电平变化。请检查 VCC/GND 接线，或在仿真面板勾选 USB 供电。'
    });
  }

  /**
   * Every visual channel of this device, every time (§7.1): the UI replaces the
   * array for a componentId wholesale. The TTP223 has exactly one — the pad —
   * and its label comes from the binding rather than a literal, so a catalog
   * that renames the feature keeps working. The `touched` visual (`kind:'state'`)
   * and the `touch` control share that label, so the deduplicated result is the
   * single `pressed` entry below.
   */
  private publish(): void {
    const states: DeviceVisualState[] = [{ kind: 'pressed', feature: this.feature, active: this.active }];
    this.ctx.visual(states);
  }
}

export const createTtp223Driver = (ctx: DeviceContext): DeviceDriver => new Ttp223Driver(ctx);
