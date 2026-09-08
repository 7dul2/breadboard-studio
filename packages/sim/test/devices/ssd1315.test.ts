import { describe, expect, it } from 'vitest';
import { createSsd1315Driver, SSD1315_DRIVER_ID } from '../../src/devices/ssd1315.js';
import { DISPLAY_COLOR_CSS } from '../../src/devices/paint.js';
import type { DeviceVisualState, SimDeviceSpec } from '../../src/types.js';
import { createDeviceHarness, fixtureSpec, type DeviceHarness } from './harness.js';

const OLED = 0x3c;

function screen(harness: DeviceHarness): Extract<DeviceVisualState, { kind: 'display' }> {
  const state = harness.lastVisual()[0];
  if (!state || state.kind !== 'display') throw new Error('the driver published no display state');
  return state;
}

function litPixels(harness: DeviceHarness): number {
  return screen(harness).pixels.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
}

function pixelAt(harness: DeviceHarness, x: number, y: number): number {
  const s = screen(harness);
  return s.pixels[y * s.width + x] ?? 0;
}

function build(overrides: Partial<SimDeviceSpec> = {}, power?: { powered: boolean }) {
  const spec = { ...fixtureSpec('oled'), ...overrides };
  const harness = createDeviceHarness({ spec, ...(power ? { power } : {}) });
  const driver = harness.bind(createSsd1315Driver(harness.ctx));
  return { harness, driver };
}

/** Commands as the real init sequence sends them: one control byte, then a run. */
const cmd = (...bytes: number[]) => Uint8Array.from([0x00, ...bytes]);
const data = (...bytes: number[]) => Uint8Array.from([0x40, ...bytes]);

describe('display.ssd1315@1', () => {
  it('registers itself on the bus it is actually wired to', () => {
    const { harness, driver } = build();
    expect(driver.driverId).toBe(SSD1315_DRIVER_ID);
    expect(harness.i2cAttachments).toHaveLength(1);
    const attach = harness.i2cAttachments[0]!;
    expect(attach.sdaPin).toBe('SDA');
    expect(attach.sclPin).toBe('SCL');
    expect(attach.addresses).toEqual([OLED]);
    // Present but dark before anything addresses it.
    expect(screen(harness).enabled).toBe(false);
    expect(litPixels(harness)).toBe(0);
    expect(screen(harness)).toMatchObject({ width: 128, height: 64, color: DISPLAY_COLOR_CSS.white });
  });

  it('accepts a typical init sequence and turns the panel on', () => {
    const { harness, driver } = build();
    // Byte for byte what the built-in `@bbs/devices/ssd1306` client sends in begin().
    const init = [
      0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, 0x12,
      0x81, 0xcf, 0xd9, 0xf1, 0xdb, 0x40, 0xa4, 0xa6, 0x2e, 0xaf
    ];
    expect(driver.onI2cWrite!(OLED, cmd(...init), true)).toBe('ack');
    expect(screen(harness).enabled, 'the last command was 0xAF').toBe(true);
    // A correct init sequence must be silent: warning about it would be pure noise.
    expect(harness.codes()).toEqual([]);
    expect(litPixels(harness)).toBe(0);
  });

  it('lays one data byte out as eight vertical pixels with the LSB on top', () => {
    const { harness, driver } = build();
    driver.onI2cWrite!(OLED, cmd(0x20, 0x02, 0xb0, 0x00, 0x10, 0xa1, 0xc8, 0xaf), true);
    driver.onI2cWrite!(OLED, data(0b00000101), true);

    expect(pixelAt(harness, 0, 0), 'bit 0 is the top row').toBe(255);
    expect(pixelAt(harness, 0, 1)).toBe(0);
    expect(pixelAt(harness, 0, 2), 'bit 2, two rows down').toBe(255);
    expect(litPixels(harness)).toBe(2);
  });

  it('advances the pointer differently in each addressing mode', () => {
    // page mode: the column wraps at 127 inside the same page, and the window
    // commands are ignored — which is exactly the bug a program hits when it
    // forgets 0x20 and wonders why its second line landed on the first.
    const page = build();
    page.driver.onI2cWrite!(OLED, cmd(0x20, 0x02, 0x21, 0, 3, 0x22, 0, 1, 0xb0, 0x0e, 0x17, 0xa1, 0xc8, 0xaf), true);
    page.driver.onI2cWrite!(OLED, data(0x01, 0x01, 0x02), true);
    expect(pixelAt(page.harness, 126, 0), 'the column window did not move the pointer').toBe(255);
    expect(pixelAt(page.harness, 127, 0)).toBe(255);
    expect(pixelAt(page.harness, 0, 1), 'wrapped to column 0 of the same page').toBe(255);
    expect(pixelAt(page.harness, 0, 8), 'page mode never carried into page 1').toBe(0);
    expect(pixelAt(page.harness, 0, 0), 'the wrapped byte was 0x02, so bit 0 is clear').toBe(0);

    // horizontal mode: the same three bytes do carry into the next page
    const horiz = build();
    horiz.driver.onI2cWrite!(OLED, cmd(0x20, 0x00, 0x21, 126, 127, 0x22, 0, 1, 0xa1, 0xc8, 0xaf), true);
    horiz.driver.onI2cWrite!(OLED, data(0x01, 0x01, 0x02), true);
    expect(pixelAt(horiz.harness, 126, 0)).toBe(255);
    expect(pixelAt(horiz.harness, 127, 0)).toBe(255);
    expect(pixelAt(horiz.harness, 126, 9), 'page 1, bit 1').toBe(255);

    // vertical mode: the page moves first
    const vert = build();
    vert.driver.onI2cWrite!(OLED, cmd(0x20, 0x01, 0x21, 10, 11, 0x22, 0, 1, 0xa1, 0xc8, 0xaf), true);
    vert.driver.onI2cWrite!(OLED, data(0x01, 0x01), true);
    expect(pixelAt(vert.harness, 10, 0)).toBe(255);
    expect(pixelAt(vert.harness, 10, 8), 'second byte went down a page, not right a column').toBe(255);
    expect(pixelAt(vert.harness, 11, 0)).toBe(0);
  });

  it('clips writes to the column and page window', () => {
    const { harness, driver } = build();
    driver.onI2cWrite!(OLED, cmd(0x20, 0x00, 0x21, 0, 3, 0x22, 0, 0, 0xa1, 0xc8, 0xaf), true);
    driver.onI2cWrite!(OLED, data(0xff, 0xff, 0xff, 0xff, 0xff, 0xff), true);
    // six bytes into a four-column window: the last two wrapped back to the start
    for (let x = 0; x < 4; x++) expect(pixelAt(harness, x, 0), `column ${x}`).toBe(255);
    expect(pixelAt(harness, 4, 0), 'nothing escaped the window').toBe(0);
    expect(litPixels(harness)).toBe(4 * 8);
  });

  it('inverts, dims and blanks without losing the picture', () => {
    const { harness, driver } = build();
    driver.onI2cWrite!(OLED, cmd(0x20, 0x02, 0xb0, 0x00, 0x10, 0xa1, 0xc8, 0xaf), true);
    driver.onI2cWrite!(OLED, data(0xff), true);
    expect(litPixels(harness)).toBe(8);

    driver.onI2cWrite!(OLED, cmd(0xa7), true); // inverse
    expect(litPixels(harness), 'every pixel but the eight that were on').toBe(128 * 64 - 8);
    driver.onI2cWrite!(OLED, cmd(0xa6), true);
    expect(litPixels(harness)).toBe(8);

    driver.onI2cWrite!(OLED, cmd(0x81, 0x40), true); // contrast
    expect(pixelAt(harness, 0, 0)).toBe(0x40);

    driver.onI2cWrite!(OLED, cmd(0xa5), true); // entire display on
    expect(litPixels(harness)).toBe(128 * 64);
    driver.onI2cWrite!(OLED, cmd(0xa4), true);
    expect(litPixels(harness)).toBe(8);

    driver.onI2cWrite!(OLED, cmd(0xae), true); // display off
    expect(screen(harness).enabled).toBe(false);
    expect(litPixels(harness)).toBe(0);
    driver.onI2cWrite!(OLED, cmd(0xaf), true);
    expect(litPixels(harness), 'GDDRAM survived the blanking').toBe(8);
  });

  it('goes dark when the rail goes, and comes back unchanged', () => {
    const { harness, driver } = build();
    driver.onI2cWrite!(OLED, cmd(0x20, 0x02, 0xb0, 0x00, 0x10, 0xa1, 0xc8, 0xaf), true);
    driver.onI2cWrite!(OLED, data(0xff), true);
    expect(litPixels(harness)).toBe(8);

    harness.setPower({ powered: false, railV: 0 });
    expect(screen(harness).enabled).toBe(false);
    expect(litPixels(harness)).toBe(0);

    harness.setPower({ powered: true, railV: 3.3 });
    expect(screen(harness).enabled).toBe(true);
    expect(litPixels(harness), 'no redraw was needed').toBe(8);
  });

  it('decodes Co=1 single-byte framing as well as a plain run', () => {
    const { harness, driver } = build();
    // 0x80 = one command byte follows, then another control byte
    driver.onI2cWrite!(OLED, Uint8Array.from([0x80, 0x20, 0x80, 0x02, 0x80, 0xb0, 0x80, 0x00, 0x80, 0x10, 0x80, 0xa1, 0x80, 0xc8, 0x80, 0xaf]), true);
    expect(screen(harness).enabled).toBe(true);
    driver.onI2cWrite!(OLED, Uint8Array.from([0xc0, 0x0f]), true); // one data byte
    expect(litPixels(harness)).toBe(4);
  });

  it('mirrors when a program flips segment remap or COM scan', () => {
    const { harness, driver } = build();
    driver.onI2cWrite!(OLED, cmd(0x20, 0x02, 0xb0, 0x00, 0x10, 0xa1, 0xc8, 0xaf), true);
    driver.onI2cWrite!(OLED, data(0x01), true);
    expect(pixelAt(harness, 0, 0)).toBe(255);

    driver.onI2cWrite!(OLED, cmd(0xa0), true); // segment remap off → x mirrored
    expect(pixelAt(harness, 0, 0)).toBe(0);
    expect(pixelAt(harness, 127, 0)).toBe(255);

    driver.onI2cWrite!(OLED, cmd(0xa1, 0xc0), true); // COM scan up → y mirrored
    expect(pixelAt(harness, 0, 0)).toBe(0);
    expect(pixelAt(harness, 0, 63)).toBe(255);
  });

  it('reports an unknown command once and keeps working', () => {
    const { harness, driver } = build();
    driver.onI2cWrite!(OLED, cmd(0x20, 0x02, 0xb0, 0x00, 0x10, 0xa1, 0xc8, 0xaf), true);
    for (let i = 0; i < 20; i++) driver.onI2cWrite!(OLED, cmd(0xfe), true);
    expect(harness.codes().filter((c) => c === 'i2c_unknown_command')).toHaveLength(1);
    expect(harness.diagnostics.find((d) => d.code === 'i2c_unknown_command')!.severity).toBe('warning');
    driver.onI2cWrite!(OLED, data(0xff), true);
    expect(litPixels(harness), 'the panel still works afterwards').toBe(8);
  });

  it('answers a probe, refuses a read, and falls back to a white panel', () => {
    const { harness, driver } = build();
    expect(driver.onI2cWrite!(OLED, new Uint8Array(0), true), 'a zero-length write is Wire.probe').toBe('ack');
    expect(driver.onI2cRead!(OLED, 1), 'the panel is write-only in this model').toBeNull();

    const blue = build({ properties: { ...fixtureSpec('oled').properties, display_color: 'blue' } });
    expect(screen(blue.harness).color).toBe(DISPLAY_COLOR_CSS.blue);
    const unknown = build({ properties: { ...fixtureSpec('oled').properties, display_color: 'chartreuse' } });
    expect(screen(unknown.harness).color, 'an unknown token falls back to white').toBe(DISPLAY_COLOR_CSS.white);
    expect(harness.codes()).not.toContain('i2c_unknown_command');
  });
});
