import { describe, it, expect } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { resolveComponent } from '@breadboard-studio/core';
import type { ComponentDefinition, JsonValue, RenderPrimitiveDef } from '@breadboard-studio/schema';
import { DISPLAY_COLOR_CSS, LED_COLOR_CSS, LED_COLOR_RGB, LED_COLOR_TOKENS, clampChannel, cssRgb, displayColorCss, ledRgb } from '../../src/devices/paint.js';

function definition(ref: string): ComponentDefinition {
  const def = builtinCatalog().getComponent(ref);
  if (!def) throw new Error(`catalog is missing ${ref}`);
  return def;
}

function fillOf(primitive: RenderPrimitiveDef | undefined): string | undefined {
  return primitive && 'fill' in primitive ? (primitive.fill as string | undefined) : undefined;
}

/** What core actually paints for one `$token` placeholder in a definition's render. */
function corePaint(def: ComponentDefinition, token: string, config: Record<string, JsonValue>): string {
  const index = def.render.findIndex((primitive) => fillOf(primitive) === token);
  if (index < 0) throw new Error(`${def.id} has no render primitive filled with ${token}`);
  const resolved = resolveComponent(def, undefined, config);
  expect(resolved.issues).toEqual([]);
  const paint = fillOf(resolved.render[index]);
  if (paint === undefined) throw new Error(`${def.id} resolved ${token} to nothing`);
  return paint;
}

describe('device colour tokens', () => {
  it('P1 keeps the display palette byte-identical to core', () => {
    // `src/devices/*` may not import core (plan §1.3), so the two literals are
    // copied — this test is what stops the copy from drifting.
    const oled = definition('oled_0_96_ssd1315_i2c@1');
    expect(DISPLAY_COLOR_CSS.white).toBe(corePaint(oled, '$display_color', { display_color: 'white' }));
    expect(DISPLAY_COLOR_CSS.blue).toBe(corePaint(oled, '$display_color', { display_color: 'blue' }));
    expect(DISPLAY_COLOR_CSS).toEqual({ white: '#f8fafc', blue: '#38bdf8' });
  });

  it('P2 keeps the LED palette byte-identical to core, tokens and triples alike', () => {
    const board = definition('esp32s3_n16r8_dual_usb@1');
    for (const token of LED_COLOR_TOKENS) {
      expect(LED_COLOR_CSS[token], token).toBe(corePaint(board, '$rgb_led_color', { rgb_led_color: token }));
    }
    expect(cssRgb([12, 34, 56])).toBe(corePaint(board, '$rgb_led_color', { rgb_led_color: [12, 34, 56] }));
    expect(LED_COLOR_RGB).toEqual({ red: [239, 68, 68], green: [34, 197, 94], blue: [59, 130, 246], white: [248, 250, 252], off: [71, 85, 105] });
  });

  it('P3 states each LED token as the RGB triple of its own hex string', () => {
    for (const token of LED_COLOR_TOKENS) {
      const hex = LED_COLOR_CSS[token];
      const triple: [number, number, number] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
      expect(LED_COLOR_RGB[token], token).toEqual(triple);
    }
  });

  it('P4 falls back to white for the OLEDs that declare no display_color', () => {
    expect(definition('oled_0_91_i2c@1').config_default?.display_color).toBeUndefined();
    expect(displayColorCss(undefined)).toBe('#f8fafc');
    expect(displayColorCss('chartreuse')).toBe('#f8fafc');
    expect(displayColorCss(undefined, 'blue')).toBe('#38bdf8');
    expect(displayColorCss('blue')).toBe('#38bdf8');
  });

  it('P5 resolves colour values that are either a token or an [r, g, b] triple', () => {
    expect(ledRgb('red')).toEqual([239, 68, 68]);
    expect(ledRgb([0, 0, 0])).toEqual([0, 0, 0]);
    expect(ledRgb([1, 2, 3])).toEqual([1, 2, 3]);
    expect(ledRgb('nonsense')).toBeNull();
    expect(ledRgb([1, 2])).toBeNull();
    expect(ledRgb([1, 2, 300])).toBeNull();
    expect(ledRgb(null)).toBeNull();
    // The returned triple is a copy: a driver may not mutate the table.
    const red = ledRgb('red')!;
    red[0] = 0;
    expect(LED_COLOR_RGB.red).toEqual([239, 68, 68]);
  });

  it('P6 clamps channels to one byte', () => {
    expect(clampChannel(-1)).toBe(0);
    expect(clampChannel(300)).toBe(255);
    expect(clampChannel(12.4)).toBe(12);
    expect(clampChannel(Number.NaN)).toBe(0);
    expect(cssRgb([-1, 12.4, 300])).toBe('rgb(0, 12, 255)');
  });
});
