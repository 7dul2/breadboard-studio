import { describe, it, expect } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import type { DeviceVisualState, SimDeviceSpec } from '../../src/types.js';
import { ESP32S3_DRIVER_ID, Esp32S3Driver, MCU_FEATURES, PIN_MODE, isMcuHostApi } from '../../src/devices/esp32s3.js';
import { createDeviceHarness, fixtureSpec, type DeviceHarness } from './harness.js';

const N16R8 = fixtureSpec('mcu');

function mcu(spec: SimDeviceSpec = N16R8, power?: { powered?: boolean; railV?: number | null; groundOk?: boolean }): { harness: DeviceHarness; driver: Esp32S3Driver } {
  const harness = createDeviceHarness({ spec, ...(power ? { power } : {}) });
  const driver = harness.bind(new Esp32S3Driver(harness.ctx));
  return { harness, driver };
}

function led(states: DeviceVisualState[]): Extract<DeviceVisualState, { kind: 'led' }> | undefined {
  return states.find((state): state is Extract<DeviceVisualState, { kind: 'led' }> => state.kind === 'led');
}

function pressed(states: DeviceVisualState[], feature: string): boolean | undefined {
  const hit = states.find((state) => state.kind === 'pressed' && state.feature === feature);
  return hit && hit.kind === 'pressed' ? hit.active : undefined;
}

/** A devkit-shaped spec: the same driver, but a catalog entry with no controls and no visuals. */
function devkitSpec(): SimDeviceSpec {
  const def = builtinCatalog().getComponent('esp32s3_devkit_generic@1');
  if (!def?.simulation) throw new Error('catalog is missing esp32s3_devkit_generic@1');
  return {
    componentId: 'mcu',
    model: 'esp32s3_devkit_generic@1',
    driver: def.simulation.driver ?? null,
    pinNets: {},
    pinChannels: { ...(def.simulation.pins ?? {}) },
    properties: { ...(def.simulation.properties ?? {}) }
  };
}

describe('mcu.esp32s3.behavioral@1', () => {
  it('E1 maps GPIO numbers to pin names from pinChannels, and throws on a number the board lacks', () => {
    const { driver } = mcu();
    expect(driver.driverId).toBe(ESP32S3_DRIVER_ID);
    expect(isMcuHostApi(driver)).toBe(true);
    expect(Object.keys(N16R8.pinChannels)).toHaveLength(36);
    expect(driver.pinNameOf(0)).toBe('GPIO0');
    expect(driver.pinNameOf(4)).toBe('GPIO4');
    expect(driver.pinNameOf(43)).toBe('TX');
    expect(driver.pinNameOf(44)).toBe('RX');
    expect(driver.pinNameOf(48)).toBe('GPIO48');
    expect(() => driver.pinNameOf(99)).toThrow(/GPIO 99 does not exist/);
    expect(() => driver.digitalWrite(22, 1)).toThrow(/GPIO 22 does not exist/);
    expect(() => driver.pinMode(4, 7)).toThrow(/unknown mode 7/);
  });

  it('E2 defends against a repeated GPIO number and ignores non-numeric channels', () => {
    const spec: SimDeviceSpec = {
      componentId: 'mcu',
      model: 'weird_board@1',
      driver: ESP32S3_DRIVER_ID,
      pinNets: {},
      pinChannels: { A: 7, B: 7, VCC: 'vcc' },
      properties: {}
    };
    const { driver, harness } = mcu(spec);
    expect(driver.pinNameOf(7)).toBe('A');
    driver.pinMode(7, PIN_MODE.OUTPUT);
    expect(harness.heldDrive('A')).toEqual({ value: 0, strength: 'strong' });
    expect(harness.heldDrive('B')).toBeNull();
    // A string channel is a name, not a GPIO number: it is simply not addressable.
    expect(() => driver.pinNameOf(Number.NaN)).toThrow();
    // No boot_gpio / rgb_gpio on this board: only the reset button is published.
    expect(harness.lastVisual()).toEqual([{ kind: 'pressed', feature: MCU_FEATURES.reset, active: false }]);
  });

  it('E3 resolves the three pin modes onto the net', () => {
    const { driver, harness } = mcu();
    driver.pinMode(4, PIN_MODE.OUTPUT);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 0, strength: 'strong' });
    driver.digitalWrite(4, 1);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 1, strength: 'strong' });
    driver.digitalWrite(4, false);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 0, strength: 'strong' });

    driver.pinMode(4, PIN_MODE.INPUT);
    expect(harness.heldDrive('GPIO4')).toBeNull();
    expect(harness.releases.at(-1)?.pin).toBe('GPIO4');

    driver.pinMode(4, PIN_MODE.INPUT_PULLUP);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 1, strength: 'pull' });

    // A write while the pin is an input only latches the register.
    driver.digitalWrite(4, 1);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 1, strength: 'pull' });
    driver.pinMode(4, PIN_MODE.OUTPUT);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 1, strength: 'strong' });
  });

  it('E4 reads Z/X as 0 through the diagnosing read path, and gives the four-valued level raw', () => {
    const { driver, harness } = mcu();
    driver.pinMode(4, PIN_MODE.INPUT);

    harness.setNet('GPIO4', 'Z');
    expect(driver.digitalRead(4)).toBe(0);
    expect(driver.digitalReadRaw(4)).toBe('Z');
    expect(harness.codes()).toEqual(['floating_input']);

    harness.setNet('GPIO4', 'X');
    expect(driver.digitalRead(4)).toBe(0);
    expect(driver.digitalReadRaw(4)).toBe('X');
    expect(harness.codes()).toEqual(['floating_input', 'digital_contention']);

    harness.setNet('GPIO4', 1);
    expect(driver.digitalRead(4)).toBe(1);
    expect(driver.digitalReadRaw(4)).toBe(1);
    harness.setNet('GPIO4', 0);
    expect(driver.digitalRead(4)).toBe(0);
    expect(driver.digitalReadRaw(4)).toBe(0);
    // Reading a defined level adds no diagnostics, and the session stays alive.
    expect(harness.codes()).toEqual(['floating_input', 'digital_contention']);
    expect(harness.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('E5 pulls GPIO0 down while BOOT is held and lets go on release', () => {
    const { driver, harness } = mcu();
    expect(harness.heldDrive('GPIO0')).toBeNull();

    driver.onControl('boot', 'press', true);
    expect(harness.heldDrive('GPIO0')).toEqual({ value: 0, strength: 'strong' });
    expect(pressed(harness.lastVisual(), MCU_FEATURES.boot)).toBe(true);
    expect(driver.digitalRead(0)).toBe(0);

    driver.onControl('boot', 'press', false);
    expect(harness.heldDrive('GPIO0')).toBeNull();
    expect(pressed(harness.lastVisual(), MCU_FEATURES.boot)).toBe(false);
  });

  it('E6 reports the real short when BOOT is held while GPIO0 is an output driven high', () => {
    const { driver, harness } = mcu();
    driver.pinMode(0, PIN_MODE.OUTPUT);
    driver.digitalWrite(0, 1);
    expect(harness.heldDrive('GPIO0')).toEqual({ value: 1, strength: 'strong' });

    driver.onControl('boot', 'press', true);
    expect(driver.digitalReadRaw(0)).toBe('X');
    expect(driver.digitalRead(0)).toBe(0);
    expect(harness.codes()).toEqual(['digital_contention']);
    const contention = harness.diagnostics[0]!;
    expect(contention.severity).toBe('warning');
    expect(contention.pinAddresses).toEqual(['mcu.GPIO0']);
    // Repeating the read does not repeat the diagnostic: it is edge triggered.
    driver.digitalReadRaw(0);
    expect(harness.codes()).toEqual(['digital_contention']);

    driver.onControl('boot', 'press', false);
    expect(driver.digitalReadRaw(0)).toBe(1);
    driver.onControl('boot', 'press', true);
    expect(harness.codes()).toEqual(['digital_contention', 'digital_contention']);
  });

  it('E7 drives the on-board RGB from its own register, with no net and no WS2812 decoding', () => {
    const { driver, harness } = mcu();
    expect(N16R8.pinNets.GPIO48).toBeUndefined();
    expect(N16R8.properties.rgb_gpio).toBe(48);

    driver.digitalWrite(48, 1);
    expect(led(harness.lastVisual())).toEqual({ kind: 'led', feature: MCU_FEATURES.rgb, rgb: [255, 255, 255], intensity: 1 });
    driver.digitalWrite(48, 0);
    expect(led(harness.lastVisual())).toEqual({ kind: 'led', feature: MCU_FEATURES.rgb, rgb: [0, 0, 0], intensity: 0 });

    driver.rgb(0, 128, 255);
    expect(led(harness.lastVisual())).toEqual({ kind: 'led', feature: MCU_FEATURES.rgb, rgb: [0, 128, 255], intensity: 1 });
    driver.rgb(-5, 300, 12.4);
    expect(led(harness.lastVisual())?.rgb).toEqual([0, 255, 12]);

    // No timing is decoded, so the driver never arms a timer for the LED.
    expect(harness.pendingTimers()).toBe(0);
  });

  it('E8 publishes every visual channel in one array, so the LED and the buttons cannot erase each other', () => {
    const { driver, harness } = mcu();
    driver.onControl('boot', 'press', true);
    driver.setResetButton(true);
    driver.digitalWrite(48, 1);

    const states = harness.lastVisual();
    expect(states.map((state) => state.feature)).toEqual([MCU_FEATURES.rgb, MCU_FEATURES.boot, MCU_FEATURES.reset]);
    expect(led(states)?.intensity).toBe(1);
    expect(pressed(states, MCU_FEATURES.boot)).toBe(true);
    expect(pressed(states, MCU_FEATURES.reset)).toBe(true);
    // Every publish carries the full set, not just the channel that changed.
    for (const published of harness.visuals) expect(published.map((state) => state.feature)).toEqual([MCU_FEATURES.rgb, MCU_FEATURES.boot, MCU_FEATURES.reset]);
  });

  it('E9 onReset(host) cancels its timers, returns the GPIOs to INPUT and resets the UART', () => {
    const { driver, harness } = mcu();
    driver.armTimer(1000, 7);
    driver.armTimer(2000, 8);
    driver.pinMode(4, PIN_MODE.OUTPUT);
    driver.digitalWrite(4, 1);
    driver.digitalWrite(48, 1);
    driver.serialBegin(115200);
    driver.serialWrite('half a line');
    driver.onControl('boot', 'press', true);
    expect(harness.pendingTimers()).toBe(2);

    driver.onReset('host');

    expect(harness.pendingTimers()).toBe(0);
    expect(harness.heldDrive('GPIO4')).toBeNull();
    expect(driver.baud).toBe(0);
    expect(led(harness.lastVisual())?.intensity).toBe(0);
    // The UART buffer is gone: the half line never reaches the console.
    driver.flushSerial();
    expect(harness.serial).toHaveLength(0);
    // A reset does not un-press a physical button, so BOOT still holds GPIO0 low.
    expect(harness.heldDrive('GPIO0')).toEqual({ value: 0, strength: 'strong' });
    expect(pressed(harness.lastVisual(), MCU_FEATURES.boot)).toBe(true);
    // The driver only ever touched its own pins, so nothing external was reset.
    for (const call of [...harness.drives, ...harness.releases]) expect(['GPIO0', 'GPIO4', 'GPIO48']).toContain(call.pin);

    // The program state really is gone: a fresh write starts from INPUT again.
    driver.digitalWrite(4, 1);
    expect(harness.heldDrive('GPIO4')).toBeNull();
    driver.pinMode(4, PIN_MODE.OUTPUT);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 1, strength: 'strong' });
  });

  it('E10 keeps every pin high-impedance while unpowered and reports it exactly once', () => {
    const { driver, harness } = mcu(N16R8, { powered: false, railV: null, groundOk: true });
    expect(harness.codes()).toEqual(['device_unpowered']);
    expect(harness.diagnostics[0]!.severity).toBe('warning');

    driver.pinMode(4, PIN_MODE.OUTPUT);
    driver.digitalWrite(4, 1);
    driver.pinMode(0, PIN_MODE.INPUT_PULLUP);
    driver.digitalWrite(48, 1);
    driver.rgb(255, 0, 0);
    expect(harness.drives).toHaveLength(0);
    expect(harness.heldDrive('GPIO4')).toBeNull();
    expect(driver.digitalReadRaw(4)).toBe('Z');
    expect(driver.digitalRead(4)).toBe(0);
    expect(led(harness.lastVisual())?.intensity).toBe(0);
    expect(harness.codes()).toEqual(['device_unpowered']);

    // Powering up restores exactly the register state the program had set.
    harness.setPower({ powered: true, railV: 3.3 });
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 1, strength: 'strong' });
    expect(harness.heldDrive('GPIO0')).toEqual({ value: 1, strength: 'pull' });
    expect(harness.codes()).toEqual(['device_unpowered']);
  });

  it('E11 survives a board whose catalog entry has no controls and no visuals', () => {
    const def = builtinCatalog().getComponent('esp32s3_devkit_generic@1');
    expect(def?.simulation?.controls).toBeUndefined();
    expect(def?.simulation?.visuals).toBeUndefined();

    const { driver, harness } = mcu(devkitSpec());
    expect(() => driver.digitalWrite(48, 1)).not.toThrow();
    expect(led(harness.lastVisual())?.intensity).toBe(1);
    expect(harness.codes()).toEqual([]);
    // GPIO4 is unwired here; driving it is still legal and lands on a private net.
    driver.pinMode(4, PIN_MODE.OUTPUT);
    expect(harness.heldDrive('GPIO4')).toEqual({ value: 0, strength: 'strong' });
    expect(harness.ctx.netIdOf('GPIO4')).toBe('unconnected:mcu.GPIO4');
  });

  it('E12 reports an unsupported control channel once, as info, without failing the session', () => {
    const noButton: SimDeviceSpec = { ...devkitSpec(), properties: { rgb_gpio: 48 } };
    const { driver, harness } = mcu(noButton);
    driver.onControl('boot', 'press', true);
    driver.onControl('boot', 'press', false);
    driver.onControl('boot', 'press', true);
    expect(harness.codes()).toEqual(['unsupported_device']);
    expect(harness.diagnostics[0]!.severity).toBe('info');
    expect(harness.drives).toHaveLength(0);

    driver.onControl('wheel', 'slider', 0.5);
    driver.onControl('wheel', 'slider', 0.9);
    expect(harness.codes()).toEqual(['unsupported_device', 'unsupported_device']);
    expect(harness.lastVisual().some((state) => state.kind === 'pressed' && state.feature === MCU_FEATURES.boot)).toBe(false);
  });

  it('E13 assembles UART lines on newlines and flushes the remainder on dispose', () => {
    const { driver, harness } = mcu();
    driver.serialBegin(115200);
    expect(driver.baud).toBe(115200);
    driver.serialWrite('a=');
    driver.serialWrite('2');
    expect(harness.serial).toHaveLength(0);
    driver.serialWrite(' done\n');
    expect(harness.serial).toEqual([{ stream: 'stdout', text: 'a=2 done', atUs: 0 }]);

    driver.serialWrite('one\ntwo\n');
    expect(harness.serial.map((line) => line.text)).toEqual(['a=2 done', 'one', 'two']);

    driver.serialWrite('tail');
    driver.dispose();
    expect(harness.serial.map((line) => line.text)).toEqual(['a=2 done', 'one', 'two', 'tail']);
  });

  it('E15 refuses to model a pin the board committed to its octal PSRAM, and says so once per pin', () => {
    // The fact travels catalog `pin_meta.reserved` → snapshot → driver; nothing
    // here knows the string "N16R8".
    expect(N16R8.pinMeta?.GPIO35?.reserved).toBe('psram');
    const { driver, harness } = mcu();

    driver.pinMode(35, PIN_MODE.OUTPUT);
    driver.digitalWrite(35, 1);
    // The call is accepted (a real board does not reject it either) but has no
    // effect: no end is driven, so the pin stays high-impedance.
    expect(harness.drives).toEqual([]);
    expect(harness.heldDrive('GPIO35')).toBeNull();
    expect(driver.digitalReadRaw(35)).toBe('Z');
    expect(driver.digitalRead(35)).toBe(0);

    const first = harness.diagnostics[0]!;
    expect(first.code).toBe('reserved_pin_used');
    expect(first.severity).toBe('warning');
    expect(first.pinAddresses).toEqual(['mcu.GPIO35']);
    // The message has to name the consequence, not just the prohibition.
    expect(first.message).toContain('PSRAM');
    expect(first.message).toContain('高阻');
    expect(first.message).toContain('崩溃');
    // Reads never reach the net, so the pin does not also collect a floating_input.
    expect(harness.codes()).toEqual(['reserved_pin_used']);

    // A loop that keeps doing it does not flood the panel; a second reserved pin
    // still gets its own line.
    driver.pinMode(35, PIN_MODE.INPUT_PULLUP);
    driver.digitalWrite(35, 0);
    driver.digitalRead(35);
    expect(harness.codes()).toEqual(['reserved_pin_used']);
    driver.digitalWrite(36, 1);
    expect(harness.codes()).toEqual(['reserved_pin_used', 'reserved_pin_used']);
    expect(harness.diagnostics[1]!.pinAddresses).toEqual(['mcu.GPIO36']);

    // Its free neighbour is untouched by all this.
    driver.pinMode(38, PIN_MODE.OUTPUT);
    driver.digitalWrite(38, 1);
    expect(harness.heldDrive('GPIO38')).toEqual({ value: 1, strength: 'strong' });
  });

  it('E16 restricts exactly the boards whose catalog entry says so, and no others', () => {
    // Second definition, same driver: the generic DevKit is modelled as N16R8 too.
    const devkit = mcu(fixtureSpec('mcu', 'desk_device.breadboard.json'));
    devkit.driver.pinMode(37, PIN_MODE.OUTPUT);
    expect(devkit.harness.heldDrive('GPIO37')).toBeNull();
    expect(devkit.harness.codes()).toEqual(['reserved_pin_used']);

    // The XIAO carries an R8 module as well, but does not break those lines out:
    // GPIO35 is simply not a pin, which is a different (and older) failure.
    const xiao = mcu(fixtureSpec('mcu', 'environment_node.breadboard.json'));
    expect(() => xiao.driver.pinMode(35, PIN_MODE.OUTPUT)).toThrow(/GPIO 35 does not exist/);
    expect(xiao.harness.codes()).toEqual([]);

    // A spec that carries no pinMeta at all restricts nothing: a driver that
    // hard-coded the GPIO numbers instead of reading the snapshot would fail here.
    const anonymous = mcu({ ...N16R8, pinMeta: undefined });
    anonymous.driver.pinMode(35, PIN_MODE.OUTPUT);
    anonymous.driver.digitalWrite(35, 1);
    expect(anonymous.harness.heldDrive('GPIO35')).toEqual({ value: 1, strength: 'strong' });
    expect(anonymous.harness.codes()).toEqual([]);
  });

  it('E14 stamps its timers with virtual time only, and fires them in order', () => {
    const { driver, harness } = mcu();
    const fired: number[] = [];
    harness.bind({ driverId: ESP32S3_DRIVER_ID, onTimer: (token: number) => fired.push(token) });
    driver.armTimer(500, 1);
    driver.armTimer(100, 2);
    harness.advance(99);
    expect(fired).toEqual([]);
    harness.advance(1);
    expect(fired).toEqual([2]);
    harness.advance(400);
    expect(fired).toEqual([2, 1]);
    expect(harness.nowUs()).toBe(500);
  });
});
