/**
 * Colour tokens shared by the device drivers (plan §7.2, §7.4).
 *
 * The literals below are *copied* from `packages/core/src/component.ts` on
 * purpose: `src/devices/*` may not import core, otherwise core + ajv end up in
 * the worker chunk (plan §1.3). `test/devices/paint.test.ts` pins every value
 * against what core actually renders, so the copy cannot drift in silence.
 */

export type Rgb = [number, number, number];

/** Panel colours of the OLED modules (`config.display_color`). */
export type DisplayColorToken = 'white' | 'blue';

/** LED colour tokens accepted by `config.rgb_led_color` / LED `params.color`. */
export type LedColorToken = 'red' | 'green' | 'blue' | 'white' | 'off';

export const DISPLAY_COLOR_CSS: Readonly<Record<DisplayColorToken, string>> = Object.freeze({
  white: '#f8fafc',
  blue: '#38bdf8'
});

export const LED_COLOR_CSS: Readonly<Record<LedColorToken, string>> = Object.freeze({
  red: '#ef4444',
  green: '#22c55e',
  blue: '#3b82f6',
  white: '#f8fafc',
  off: '#475569'
});

export const LED_COLOR_RGB: Readonly<Record<LedColorToken, Rgb>> = Object.freeze({
  red: [239, 68, 68],
  green: [34, 197, 94],
  blue: [59, 130, 246],
  white: [248, 250, 252],
  off: [71, 85, 105]
});

export const DISPLAY_COLOR_TOKENS = Object.keys(DISPLAY_COLOR_CSS) as DisplayColorToken[];
export const LED_COLOR_TOKENS = Object.keys(LED_COLOR_CSS) as LedColorToken[];

export function isDisplayColorToken(value: unknown): value is DisplayColorToken {
  return value === 'white' || value === 'blue';
}

export function isLedColorToken(value: unknown): value is LedColorToken {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LED_COLOR_CSS, value);
}

/**
 * CSS colour of a display panel. Two of the three OLED definitions have no
 * `display_color`, so an unknown token falls back to white (plan §7.4).
 */
export function displayColorCss(value: unknown, fallback: DisplayColorToken = 'white'): string {
  return DISPLAY_COLOR_CSS[isDisplayColorToken(value) ? value : fallback];
}

/** Clamp to one 8-bit channel; non-finite input becomes 0. */
export function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function clampRgb(rgb: readonly [number, number, number]): Rgb {
  return [clampChannel(rgb[0]), clampChannel(rgb[1]), clampChannel(rgb[2])];
}

/** `rgb(r, g, b)` in exactly the shape core writes for an array-valued colour. */
export function cssRgb(rgb: readonly [number, number, number]): string {
  const [r, g, b] = clampRgb(rgb);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Resolve a colour value that may be a token (`'red'`) or an `[r, g, b]`
 * triple, the two shapes the catalog config schemas allow. Returns null when
 * the value is neither.
 */
export function ledRgb(value: unknown): Rgb | null {
  if (isLedColorToken(value)) return [...LED_COLOR_RGB[value]] as Rgb;
  if (Array.isArray(value) && value.length === 3 && value.every((channel) => typeof channel === 'number' && Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return null;
}
