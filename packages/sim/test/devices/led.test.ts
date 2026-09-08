import { describe, expect, it } from 'vitest';
import { createLedDriver, LED_DRIVER_ID } from '../../src/devices/led.js';
import { LED_COLOR_RGB } from '../../src/devices/paint.js';
import type { SimDeviceSpec } from '../../src/types.js';
import { createDeviceHarness, type DeviceHarness } from './harness.js';

/** A discrete LED as `buildSnapshot` would produce it, without needing a placed design. */
function ledSpec(overrides: Partial<SimDeviceSpec> = {}): SimDeviceSpec {
  return {
    componentId: 'led1',
    model: 'led_5mm@1',
    driver: LED_DRIVER_ID,
    pinNets: { A: 'net_anode', K: 'net_cathode' },
    pinChannels: { A: 'anode', K: 'cathode' },
    properties: {},
    params: { color: 'red' },
    visuals: [{ id: 'glow', featureLabel: 'LED', kind: 'led', channel: 'glow' }],
    ...overrides
  };
}

function build(overrides: Partial<SimDeviceSpec> = {}) {
  const harness = createDeviceHarness({ spec: ledSpec(overrides) });
  const driver = harness.bind(createLedDriver(harness.ctx));
  return { harness, driver };
}

function glow(harness: DeviceHarness): { rgb: [number, number, number]; intensity: number } {
  const state = harness.lastVisual()[0];
  if (!state || state.kind !== 'led') throw new Error('the driver published no LED state');
  return { rgb: state.rgb, intensity: state.intensity };
}

describe('output.led@1', () => {
  it('lights only when it is forward-biased', () => {
    const { harness, driver } = build();
    expect(driver.driverId).toBe(LED_DRIVER_ID);
    expect(glow(harness).intensity, 'both legs floating').toBe(0);

    harness.setNet('A', 1);
    driver.onNetChange!('A', 1);
    expect(glow(harness).intensity, 'anode high but the cathode is floating').toBe(0);

    harness.setNet('K', 0);
    driver.onNetChange!('K', 0);
    expect(glow(harness).intensity, 'now current has somewhere to go').toBe(1);
    expect(glow(harness).rgb).toEqual([...LED_COLOR_RGB.red]);

    harness.setNet('A', 0);
    driver.onNetChange!('A', 0);
    expect(glow(harness).intensity, 'driven low at both ends').toBe(0);
  });

  it('stays dark when it is wired backwards', () => {
    const { harness, driver } = build();
    harness.setNet('A', 0);
    harness.setNet('K', 1);
    driver.onNetChange!('K', 1);
    expect(glow(harness).intensity, 'cathode high, anode low: reverse-biased').toBe(0);
  });

  it('stays dark on a contended or floating net rather than guessing', () => {
    for (const [a, k] of [
      ['X', 0],
      [1, 'X'],
      ['Z', 0],
      [1, 'Z'],
      ['Z', 'Z']
    ] as const) {
      const { harness, driver } = build();
      harness.setNet('A', a);
      harness.setNet('K', k);
      driver.onNetChange!('A', a);
      expect(glow(harness).intensity, `A=${a} K=${k}`).toBe(0);
    }
  });

  it('takes its colour from params, and never drives a net', () => {
    const green = build({ params: { color: 'green' } });
    expect(glow(green.harness).rgb).toEqual([...LED_COLOR_RGB.green]);

    const custom = build({ params: { color: [10, 20, 30] } });
    expect(glow(custom.harness).rgb).toEqual([10, 20, 30]);

    const missing = build({ params: {} });
    expect(glow(missing.harness).rgb, 'an unstated colour is red, not black').toEqual([...LED_COLOR_RGB.red]);

    // An LED is a load: it must never resolve a net, or it could mask a wiring fault.
    const { harness, driver } = build();
    harness.setNet('A', 1);
    harness.setNet('K', 0);
    driver.onNetChange!('A', 1);
    expect(harness.drives, 'the LED drove nothing').toEqual([]);
    expect(harness.heldDrive('A')).toBeNull();
    expect(harness.heldDrive('K')).toBeNull();
  });

  it('reports a definition with no anode/cathode binding instead of failing silently', () => {
    const { harness } = build({ pinChannels: {} });
    expect(harness.codes()).toEqual(['unsupported_device']);
    expect(harness.diagnostics[0]!.severity).toBe('info');
    expect(glow(harness).intensity).toBe(0);
  });
});
