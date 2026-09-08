import { describe, it, expect } from 'vitest';
import type { DeviceDriver, DevicePower } from '../../src/contracts.js';
import type { DeviceVisualState, SimDeviceSpec } from '../../src/types.js';
import { TTP223_DEFAULT_FEATURE, TTP223_DRIVER_ID, Ttp223Driver } from '../../src/devices/ttp223.js';
import { createDeviceHarness, fixtureSpec, type DeviceHarness } from './harness.js';

/** The real catalog spec: `IO → out`, one `touch` control and one `touched` visual on 触摸区. */
const TOUCH = fixtureSpec('touch');
const PAD = '触摸区';

function specWith(properties: Record<string, unknown>, base: SimDeviceSpec = TOUCH): SimDeviceSpec {
  return { ...base, properties: { ...base.properties, ...properties } };
}

function ttp223(spec: SimDeviceSpec = TOUCH, power?: Partial<DevicePower>): { harness: DeviceHarness; driver: Ttp223Driver } {
  const harness = createDeviceHarness({ spec, ...(power ? { power } : {}) });
  const driver = harness.bind(new Ttp223Driver(harness.ctx));
  return { harness, driver };
}

function pad(states: DeviceVisualState[]): Extract<DeviceVisualState, { kind: 'pressed' }> | undefined {
  return states.find((state): state is Extract<DeviceVisualState, { kind: 'pressed' }> => state.kind === 'pressed');
}

/** What the IO pin currently drives, as a compact string for readable assertions. */
function io(harness: DeviceHarness): string {
  const held = harness.heldDrive('IO');
  return held === null ? 'Z' : `${held.value}/${held.strength}`;
}

describe('input.ttp223@1', () => {
  it('T0 starts from the catalog spec: idle low, one full visual array, no diagnostics', () => {
    const { harness, driver } = ttp223();
    expect(driver.driverId).toBe(TTP223_DRIVER_ID);
    // The output is defined from t=0 rather than floating: an untouched
    // active_high module holds a strong 0.
    expect(io(harness)).toBe('0/strong');
    expect(harness.diagnostics).toHaveLength(0);
    // §7.1: one array carrying every visual channel of the device — and the
    // TTP223 has exactly one, deduplicated by feature label between the
    // `touch` control and the `touched` state visual.
    expect(harness.lastVisual()).toEqual([{ kind: 'pressed', feature: PAD, active: false }]);
    expect(harness.releases).toHaveLength(0);
  });

  it('T1 momentary: the output follows the finger and drops again on release', () => {
    const { harness, driver } = ttp223(specWith({ toggle_mode: false }));
    driver.onControl('touch', 'touch', true);
    expect(io(harness)).toBe('1/strong');
    expect(driver.active).toBe(true);
    expect(pad(harness.lastVisual())).toEqual({ kind: 'pressed', feature: PAD, active: true });

    // Holding repeats the same value through the canvas' pointer capture.
    driver.onControl('touch', 'touch', true);
    expect(harness.drives.filter((call) => call.value === 1)).toHaveLength(1);

    driver.onControl('touch', 'touch', false);
    expect(io(harness)).toBe('0/strong');
    expect(driver.active).toBe(false);
    expect(pad(harness.lastVisual())?.active).toBe(false);
    expect(harness.diagnostics).toHaveLength(0);
  });

  it('T2 toggle: the latch flips on the press edge only, and holding or releasing never flips it again', () => {
    const { harness, driver } = ttp223(specWith({ toggle_mode: true }));
    expect(io(harness)).toBe('0/strong');

    driver.onControl('touch', 'touch', true);
    expect(io(harness)).toBe('1/strong');
    expect(driver.active).toBe(true);

    // Held down: repeats must not re-toggle.
    driver.onControl('touch', 'touch', true);
    driver.onControl('touch', 'touch', 1);
    expect(io(harness)).toBe('1/strong');
    expect(driver.contacted).toBe(true);

    // Release leaves the latch alone — that is the whole point of the B pad.
    driver.onControl('touch', 'touch', false);
    expect(io(harness)).toBe('1/strong');
    expect(driver.active).toBe(true);
    expect(driver.contacted).toBe(false);
    expect(pad(harness.lastVisual())?.active).toBe(true);

    // The next press edge flips it back.
    driver.onControl('touch', 'touch', true);
    expect(io(harness)).toBe('0/strong');
    driver.onControl('touch', 'touch', false);
    expect(io(harness)).toBe('0/strong');
    expect(harness.drives.map((call) => call.value)).toEqual([0, 1, 0]);
  });

  it('T3 active_low inverts the output while the visual keeps reporting the pad itself', () => {
    const { harness, driver } = ttp223(specWith({ output_mode: 'active_low' }));
    expect(io(harness)).toBe('1/strong');

    driver.onControl('touch', 'touch', true);
    expect(io(harness)).toBe('0/strong');
    // The visual is the state of the pad, not of the wire: an active_low module
    // that is being touched still shows a pressed pad.
    expect(pad(harness.lastVisual())?.active).toBe(true);

    driver.onControl('touch', 'touch', false);
    expect(io(harness)).toBe('1/strong');
    expect(pad(harness.lastVisual())?.active).toBe(false);
  });

  it('T3b active_low and toggle_mode compose', () => {
    const { harness, driver } = ttp223(specWith({ output_mode: 'active_low', toggle_mode: true }));
    expect(io(harness)).toBe('1/strong');
    driver.onControl('touch', 'touch', true);
    driver.onControl('touch', 'touch', false);
    expect(io(harness)).toBe('0/strong');
    driver.onControl('touch', 'touch', true);
    driver.onControl('touch', 'touch', false);
    expect(io(harness)).toBe('1/strong');
  });

  it('T4 unpowered: IO stays high-impedance and exactly one device_unpowered is raised', () => {
    const { harness, driver } = ttp223(TOUCH, { powered: false, railV: null });
    expect(io(harness)).toBe('Z');
    expect(harness.drives).toHaveLength(0);
    expect(harness.codes()).toEqual(['device_unpowered']);
    expect(harness.diagnostics[0]?.severity).toBe('warning');
    expect(harness.diagnostics[0]?.componentIds).toEqual(['touch']);

    // Touching an unpowered module changes nothing electrically, and the
    // warning is edge-triggered: still exactly one.
    driver.onControl('touch', 'touch', true);
    driver.onControl('touch', 'touch', false);
    driver.onControl('touch', 'touch', true);
    expect(io(harness)).toBe('Z');
    expect(harness.drives).toHaveLength(0);
    expect(harness.codes()).toEqual(['device_unpowered']);
  });

  it('T5 losing power releases the end, and power coming back restores the level the state implies', () => {
    const { harness, driver } = ttp223(specWith({ toggle_mode: true }));
    driver.onControl('touch', 'touch', true);
    driver.onControl('touch', 'touch', false);
    expect(io(harness)).toBe('1/strong');

    harness.advance(1_000);
    harness.setPower({ powered: false, railV: null });
    expect(io(harness)).toBe('Z');
    expect(harness.releases.map((call) => call.pin)).toEqual(['IO']);
    expect(harness.codes()).toEqual(['device_unpowered']);
    // The pad still reports the latch: the module did not forget it, it simply
    // cannot drive.
    expect(pad(harness.lastVisual())?.active).toBe(true);

    harness.advance(1_000);
    harness.setPower({ powered: true, railV: 3.3 });
    expect(io(harness)).toBe('1/strong');
    expect(harness.drives[harness.drives.length - 1]).toEqual({ pin: 'IO', value: 1, strength: 'strong', atUs: 2_000 });
    // A second power cycle must not add a second warning.
    harness.setPower({ powered: false });
    harness.setPower({ powered: true });
    expect(harness.codes()).toEqual(['device_unpowered']);
    expect(io(harness)).toBe('1/strong');
  });

  it('T5b a module touched while unpowered comes up driving the touched level', () => {
    const { harness, driver } = ttp223(TOUCH, { powered: false, railV: null });
    driver.onControl('touch', 'touch', true);
    expect(io(harness)).toBe('Z');
    harness.setPower({ powered: true, railV: 3.3 });
    expect(io(harness)).toBe('1/strong');
    expect(pad(harness.lastVisual())?.active).toBe(true);
  });

  it('T6 the same event sequence produces the same drives and visuals', () => {
    const spec = specWith({ toggle_mode: true, output_mode: 'active_low' });
    const run = (): { drives: unknown; visuals: unknown; codes: string[] } => {
      const { harness, driver } = ttp223(spec);
      for (const [delayUs, value] of [
        [0, true],
        [500, true],
        [500, false],
        [1_000, true],
        [250, false],
        [750, true]
      ] as [number, boolean][]) {
        harness.advance(delayUs);
        driver.onControl('touch', 'touch', value);
      }
      harness.setPower({ powered: false });
      harness.advance(400);
      harness.setPower({ powered: true });
      return { drives: harness.drives.map((call) => ({ ...call })), visuals: harness.visuals.map((states) => [...states]), codes: harness.codes() };
    };
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    // Guard against a vacuous comparison of two empty logs.
    expect((first.drives as unknown[]).length).toBeGreaterThan(3);
  });

  it('T7 an unbound control channel is reported once as info and changes nothing', () => {
    const { harness, driver } = ttp223();
    driver.onControl('touch', 'touch', true);
    const before = io(harness);
    const visualCount = harness.visuals.length;

    expect(() => driver.onControl('boot', 'press', true)).not.toThrow();
    expect(() => driver.onControl('boot', 'press', false)).not.toThrow();
    expect(() => driver.onControl('brightness', 'slider', 42)).not.toThrow();

    expect(io(harness)).toBe(before);
    expect(harness.visuals).toHaveLength(visualCount);
    expect(harness.codes()).toEqual(['unsupported_device', 'unsupported_device']);
    expect(harness.diagnostics.every((d) => d.severity === 'info')).toBe(true);
    expect(harness.diagnostics[0]?.message).toContain('boot');
  });

  it('T8 takes the feature label from the bindings instead of a literal', () => {
    const renamed: SimDeviceSpec = { ...TOUCH, visuals: [{ id: 'touched', featureLabel: 'PAD', kind: 'state', channel: 'touch' }] };
    const { harness } = ttp223(renamed);
    expect(pad(harness.lastVisual())?.feature).toBe('PAD');

    // No visuals in the catalog entry: the control binding still names the pad.
    const controlOnly: SimDeviceSpec = { ...TOUCH, visuals: [], controls: [{ id: 'touch', featureLabel: 'TOUCH AREA', action: 'touch', channel: 'pad' }] };
    const bare = ttp223(controlOnly);
    expect(pad(bare.harness.lastVisual())?.feature).toBe('TOUCH AREA');
    // …and the channel it declares feeds the contact bit, next to the default one.
    bare.driver.onControl('pad', 'touch', true);
    expect(io(bare.harness)).toBe('1/strong');
    expect(bare.harness.codes()).toEqual([]);

    const nothing: SimDeviceSpec = { ...TOUCH, visuals: [], controls: [] };
    expect(pad(ttp223(nothing).harness.lastVisual())?.feature).toBe(TTP223_DEFAULT_FEATURE);
  });

  it('T9 a spec without an out channel reports unsupported_device once and drives nothing', () => {
    const noOutput: SimDeviceSpec = { ...TOUCH, pinChannels: { VCC: 'vcc', GND: 'gnd' } };
    const { harness, driver } = ttp223(noOutput);
    expect(harness.codes()).toEqual(['unsupported_device']);
    driver.onControl('touch', 'touch', true);
    expect(harness.drives).toHaveLength(0);
    expect(harness.releases).toHaveLength(0);
    // The pad is still operable, so the canvas keeps showing the press.
    expect(pad(harness.lastVisual())?.active).toBe(true);
    expect(harness.codes()).toEqual(['unsupported_device']);
  });

  it('T10 ignores config.supply_v: the power domain alone decides whether IO drives', () => {
    // A 5 V solder option on a 3.3 V rail changes nothing in v0.2 (§7.3).
    const { harness, driver } = ttp223(specWith({ supply_v: 5 }));
    driver.onControl('touch', 'touch', true);
    expect(io(harness)).toBe('1/strong');
    expect(harness.power().railV).toBe(3.3);

    const unpowered = ttp223(specWith({ supply_v: 5 }), { powered: false, railV: null });
    unpowered.driver.onControl('touch', 'touch', true);
    expect(io(unpowered.harness)).toBe('Z');
  });

  it('T11 does not implement onReset: the MCU RST button must not clear the latch (§7.2)', () => {
    const { driver } = ttp223(specWith({ toggle_mode: true }));
    const asDriver: DeviceDriver = driver;
    expect(asDriver.onReset).toBeUndefined();
  });
});
