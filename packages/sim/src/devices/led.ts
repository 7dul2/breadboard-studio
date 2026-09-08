/**
 * `output.led@1` — a discrete LED (plan §7.6, deferred out of M-S1 and landing now
 * that a resistor conducts).
 *
 * The whole part is one question: is it forward-biased? The four-valued kernel
 * answers that directly — the anode has to be driven high and the cathode low.
 * Anything else (either side floating, both sides at the same level, the anode
 * low) is a dark LED, which is exactly what you would see on the bench.
 *
 * It drives nothing. An LED is a load: it takes current, it does not decide a
 * net's value. That also means it cannot mask a wiring mistake — if the anode net
 * is floating it stays floating, and the LED simply reports dark.
 *
 * Deliberately not modelled: forward voltage, brightness against current, colour
 * shift. `intensity` is 1 or 0. The current *is* estimated, but in the static
 * rules where the resistor value lives, not here.
 */
import type { DeviceContext, DeviceDriver } from '../contracts.js';
import type { DeviceVisualState, DigitalValue, SimDeviceSpec } from '../types.js';
import { LED_COLOR_RGB, ledRgb, type Rgb } from './paint.js';

export const LED_DRIVER_ID = 'output.led@1';

/** Catalog `simulation.pins` channels of the two legs. */
export const LED_ANODE_CHANNEL = 'anode';
export const LED_CATHODE_CHANNEL = 'cathode';
export const LED_GLOW_CHANNEL = 'glow';
export const LED_DEFAULT_FEATURE = 'LED';

function pinForChannel(spec: SimDeviceSpec, channel: string): string | null {
  for (const [pin, bound] of Object.entries(spec.pinChannels)) if (bound === channel) return pin;
  return null;
}

export function createLedDriver(ctx: DeviceContext): DeviceDriver {
  const spec = ctx.spec;
  const anode = pinForChannel(spec, LED_ANODE_CHANNEL);
  const cathode = pinForChannel(spec, LED_CATHODE_CHANNEL);
  const feature = spec.visuals?.find((v) => v.channel === LED_GLOW_CHANNEL)?.featureLabel ?? spec.visuals?.[0]?.featureLabel ?? LED_DEFAULT_FEATURE;
  // `params.color`, not `config`: the colour is what the part *is*, not how it is wired.
  const colour: Rgb = ledRgb(spec.params?.color) ?? [...LED_COLOR_RGB.red];

  let lit = false;

  if (anode === null || cathode === null) {
    ctx.diagnoseOnce('pins:unbound', {
      code: 'unsupported_device',
      severity: 'info',
      message: `${spec.model} 没有声明 anode/cathode 引脚通道（simulation.pins），LED 不会点亮。`
    });
  } else {
    ctx.watch(anode);
    ctx.watch(cathode);
  }

  function evaluate(): void {
    if (anode === null || cathode === null) return;
    const a: DigitalValue = ctx.read(anode);
    const k: DigitalValue = ctx.read(cathode);
    // Forward-biased and only then. `X` on either side is a contention the net
    // kernel already reported; the LED stays dark rather than guessing.
    const next = a === 1 && k === 0;
    if (next === lit) return;
    lit = next;
    publish();
  }

  function publish(): void {
    const state: DeviceVisualState = { kind: 'led', feature, rgb: [...colour] as Rgb, intensity: lit ? 1 : 0 };
    ctx.visual([state]);
  }

  publish();
  evaluate();

  return {
    driverId: LED_DRIVER_ID,
    onNetChange() {
      evaluate();
    },
    onPowerChange() {
      // The LED has no supply pin of its own; its two legs are the whole story.
      evaluate();
    }
  };
}
