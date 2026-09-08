import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesignDocument } from '@breadboard-studio/schema';
import { analyzeDesign, applyOps, type Op } from '@breadboard-studio/core';
import { buildSnapshot } from '../src/snapshot.js';
import { DigitalNetKernel } from '../src/digital-net.js';
import { PowerDomain, powerInputFromSnapshot, powerPreflight } from '../src/power.js';
import type { DevicePowerState } from '../src/contracts.js';
import type { DigitalValue, SimDiagnostic, SimulationSnapshot } from '../src/types.js';

/**
 * Plan §5.3, cases ⑰ – ㉖. Everything is driven off the real fixture; the test
 * file may reach for `core` (the import gate only constrains `src/`), which is
 * what keeps "remove this wire" cases honest instead of hand-tuned.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..');

function loadDesign(relative: string): DesignDocument {
  return JSON.parse(readFileSync(join(repoRoot, relative), 'utf8')) as DesignDocument;
}

function fixture(ops: Op[] = []): SimulationSnapshot {
  const base = loadDesign('examples/touch_display.breadboard.json');
  if (!ops.length) return buildSnapshot(base);
  const applied = applyOps(base, ops);
  if (!applied.ok) throw new Error(`夹具操作失败：${applied.error.message}`);
  return buildSnapshot(applied.design);
}

const RAIL_3V3 = 'net_dcbc2bbd3485';
const GND = 'net_f0c7541ccde0';

function domainOf(snapshot: SimulationSnapshot): PowerDomain {
  return new PowerDomain(powerInputFromSnapshot(snapshot));
}

function byId(states: DevicePowerState[]): Record<string, DevicePowerState | undefined> {
  return Object.fromEntries(states.map((state) => [state.componentId, state]));
}

describe('PowerDomain on the touch_display fixture', () => {
  it('⑰ baseline: all three components are powered with no diagnostics', () => {
    const domain = domainOf(fixture());
    const states = byId(domain.evaluate());

    expect(states.touch).toEqual({ componentId: 'touch', powered: true, supplyV: 3.3, reason: 'ok', sourceNetId: RAIL_3V3 });
    expect(states.oled).toEqual({ componentId: 'oled', powered: true, supplyV: 3.3, reason: 'ok', sourceNetId: RAIL_3V3 });
    // The board itself is fed over USB, so its rail is VBUS and not a net.
    expect(states.mcu).toEqual({ componentId: 'mcu', powered: true, supplyV: 5, reason: 'ok', sourceNetId: null });

    expect(domain.diagnostics()).toEqual([]);
    expect(domain.railVoltage(RAIL_3V3)).toBe(3.3);
    expect(domain.railVoltage(GND)).toBeNull();
    expect(domain.isPowered('oled')).toBe(true);
    expect(domain.supplyVoltage('oled')).toBe(3.3);
    expect(domain.isPowered('nobody')).toBe(false);
    expect(domain.supplyVoltage('nobody')).toBeNull();
  });

  it('⑱ a part with no declared supply range is powered, but leaves one supply_range_unknown', () => {
    const snapshot = fixture();
    // The sht41_breakout shape: catalog declares no supply_voltage_v.
    snapshot.devices.find((device) => device.componentId === 'oled')!.supply = null;

    const domain = domainOf(snapshot);
    const states = byId(domain.evaluate());
    expect(states.oled).toEqual({ componentId: 'oled', powered: true, supplyV: 3.3, reason: 'unknown_range', sourceNetId: RAIL_3V3 });
    expect(states.touch!.reason).toBe('ok');
    expect(states.mcu!.reason).toBe('ok');

    const diagnostics = domain.diagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('supply_range_unknown');
    expect(diagnostics[0]!.severity).toBe('info');
    expect(diagnostics[0]!.componentIds).toEqual(['oled']);
    expect(diagnostics[0]!.message).toContain('供电范围未知');
    expect(diagnostics[0]!.message).toContain('3.3');
  });

  it('⑲ a snapshot without the power field falls back to pinMeta with the same result', () => {
    const withPower = fixture();
    const withoutPower = fixture();
    delete withoutPower.power;

    const a = powerInputFromSnapshot(withPower);
    const b = powerInputFromSnapshot(withoutPower);
    expect(b.sources).toEqual(a.sources);
    expect(b.groundNets).toEqual(a.groundNets);
    expect(b.devices).toEqual(a.devices);

    const primary = new PowerDomain(a);
    const fallback = new PowerDomain(b);
    expect(fallback.evaluate()).toEqual(primary.evaluate());
    expect(fallback.diagnostics()).toEqual(primary.diagnostics());
  });

  it('⑳ evaluate() is a pure function of its input: two calls agree field for field', () => {
    const domain = domainOf(fixture());
    const first = domain.evaluate();
    const firstDiagnostics = [...domain.diagnostics()];
    const second = domain.evaluate();

    expect(second).not.toBe(first); // freshly built, not a cached reference
    expect(second).toEqual(first);
    expect(domain.diagnostics()).toEqual(firstDiagnostics);
  });

  it('㉑ with no board ticked, the mcu is usb_off and its rails stop feeding the peripherals', () => {
    const snapshot = fixture();
    delete snapshot.config.usb_powered_components;

    const domain = domainOf(snapshot);
    const states = byId(domain.evaluate());
    expect(states.mcu).toMatchObject({ powered: false, reason: 'usb_off', supplyV: null, sourceNetId: null });
    expect(states.touch).toMatchObject({ powered: false, reason: 'no_source' });
    expect(states.oled).toMatchObject({ powered: false, reason: 'no_source' });
    expect(domain.railVoltage(RAIL_3V3)).toBeNull();

    const diagnostics = domain.diagnostics();
    expect(diagnostics.map((d) => d.code)).toEqual(['device_unpowered', 'device_unpowered', 'device_unpowered']);
    expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(diagnostics[0]!.componentIds).toEqual(['mcu']);
    expect(diagnostics[0]!.message).toContain('仿真');
    // An empty array and an absent one are indistinguishable after ops.ts, so
    // both must mean "not powered" (plan §5.2).
    const explicitEmpty = fixture();
    explicitEmpty.config.usb_powered_components = [];
    expect(byId(domainOf(explicitEmpty).evaluate()).mcu!.reason).toBe('usb_off');
  });

  it('㉒ removing the oled VCC wire leaves only the oled without a source', () => {
    const snapshot = fixture([{ op: 'remove_wire', id: 'w5' }]);
    const domain = domainOf(snapshot);
    const states = byId(domain.evaluate());

    expect(states.oled).toMatchObject({ powered: false, reason: 'no_source', supplyV: null, sourceNetId: null });
    expect(states.touch).toMatchObject({ powered: true, reason: 'ok', supplyV: 3.3 });
    expect(states.mcu).toMatchObject({ powered: true, reason: 'ok' });

    const diagnostics = domain.diagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'device_unpowered', severity: 'warning', componentIds: ['oled'] });
    expect(diagnostics[0]!.pinAddresses).toEqual(['oled.VCC']);
  });

  it('㉓ cutting the ground feeders splits the ground into three nets; both peripherals lose common ground', () => {
    const snapshot = fixture([
      { op: 'remove_wire', id: 'w1' },
      { op: 'remove_wire', id: 'w2' }
    ]);
    expect(snapshot.power!.groundNets).toHaveLength(3);

    const domain = domainOf(snapshot);
    const states = byId(domain.evaluate());
    expect(states.mcu).toMatchObject({ powered: true, reason: 'ok' });
    expect(states.touch).toMatchObject({ powered: false, reason: 'no_common_ground', supplyV: 3.3 });
    expect(states.oled).toMatchObject({ powered: false, reason: 'no_common_ground', supplyV: 3.3 });

    const diagnostics = domain.diagnostics();
    expect(diagnostics.map((d) => d.code)).toEqual(['missing_common_ground', 'missing_common_ground']);
    expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(diagnostics.flatMap((d) => d.componentIds ?? []).sort()).toEqual(['oled', 'touch']);
  });

  it('㉓ a part whose ground pin reaches no net at all reports no_ground', () => {
    const snapshot = fixture();
    const oled = snapshot.devices.find((device) => device.componentId === 'oled')!;
    delete oled.pinNets.GND;

    const domain = domainOf(snapshot);
    expect(byId(domain.evaluate()).oled).toMatchObject({ powered: false, reason: 'no_ground' });
    expect(domain.diagnostics()[0]).toMatchObject({ code: 'missing_common_ground', severity: 'warning', componentIds: ['oled'], netIds: [] });
  });

  it('㉔ a 3.3 V-only part on a 5 V rail is out of range, and the message names both bounds', () => {
    const snapshot = fixture();
    for (const source of snapshot.power!.sources) if (source.netId === RAIL_3V3) source.voltageV = 5;
    snapshot.devices.find((device) => device.componentId === 'oled')!.supply = { min: 3.15, max: 3.45 };

    const domain = domainOf(snapshot);
    const states = byId(domain.evaluate());
    expect(states.oled).toMatchObject({ powered: false, reason: 'voltage_out_of_range', supplyV: 5, sourceNetId: RAIL_3V3 });
    // 2–5.5 V still covers 5 V, so the touch module is unaffected.
    expect(states.touch).toMatchObject({ powered: true, reason: 'ok', supplyV: 5 });

    const diagnostics = domain.diagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'device_unpowered', severity: 'warning', componentIds: ['oled'], netIds: [RAIL_3V3] });
    expect(diagnostics[0]!.message).toContain('3.15');
    expect(diagnostics[0]!.message).toContain('3.45');
    expect(diagnostics[0]!.message).toContain('5');
  });

  it('㉕ once the power domain says a device is off, its ends read Z and stop reporting floating_input', () => {
    const snapshot = fixture([{ op: 'remove_wire', id: 'w5' }]);
    const domain = domainOf(snapshot);
    domain.evaluate();
    expect(domain.isPowered('oled')).toBe(false);
    expect(domain.isPowered('mcu')).toBe(true);

    const diagnostics: SimDiagnostic[] = [];
    const net = new DigitalNetKernel({
      nets: snapshot.nets,
      pinToNet: snapshot.pinToNet,
      onDiagnostic: (d) => diagnostics.push(d),
      now: () => 0
    });
    const mcuSda = { componentId: 'mcu', pin: 'GPIO8' };
    const oledSda = { componentId: 'oled', pin: 'SDA' };
    const sdaNet = net.attach(mcuSda, { openDrain: true });
    expect(net.attach(oledSda, { openDrain: true })).toBe(sdaNet);

    net.drive(oledSda, 0);
    expect(net.valueOf(sdaNet)).toBe<DigitalValue>(0);

    for (const device of snapshot.devices) net.setDevicePowered(device.componentId, domain.isPowered(device.componentId));

    expect(net.valueOf(sdaNet)).toBe<DigitalValue>('Z');
    const oledDriver = net.view().find((v) => v.netId === sdaNet)!.drivers.find((d) => d.componentId === 'oled')!;
    expect(oledDriver.value).toBe<DigitalValue>('Z');

    // The unpowered device sees the expected Z without a diagnostic…
    expect(net.readPin(oledSda, { diagnose: true })).toBe<DigitalValue>('Z');
    expect(diagnostics).toEqual([]);
    // …while the powered controller still learns that the bus is floating.
    expect(net.readPin(mcuSda, { diagnose: true })).toBe<DigitalValue>('Z');
    expect(diagnostics.map((d) => d.code)).toEqual(['floating_input']);
  });
});

describe('powerPreflight', () => {
  it('㉖ a rail wired to ground is a simulation blocker even though core does not block it', () => {
    const design = loadDesign('examples/invalid/short_power_ground.breadboard.json');
    expect(analyzeDesign(design).hasBlocking).toBe(false);

    const snapshot = buildSnapshot(design);
    const blockers = powerPreflight(powerInputFromSnapshot(snapshot));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.code).toBe('simulation_blocked_by_design');
    expect(blockers[0]!.severity).toBe('error');
    expect(blockers[0]!.netIds).toEqual(snapshot.power!.groundNets);
    expect(blockers[0]!.pinAddresses).toContain('mcu.3V3_1');
    expect(blockers[0]!.componentIds).toContain('mcu');
  });

  it('㉖ a healthy design has no blockers', () => {
    expect(powerPreflight(powerInputFromSnapshot(fixture()))).toEqual([]);
    // Nothing the domain itself raises is fatal, so unpowered peripherals never
    // block a launch either.
    const off = fixture();
    delete off.config.usb_powered_components;
    expect(powerPreflight(powerInputFromSnapshot(off))).toEqual([]);
  });
});
