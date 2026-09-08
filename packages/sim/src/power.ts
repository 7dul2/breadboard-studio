/**
 * Power domain (plan §5.2).
 *
 * Like the digital net solver this module never recomputes connectivity: rails
 * and grounds are `netId`s handed over by the snapshot, and "common ground"
 * simply means "same net id" because core already merged the internal nets.
 *
 * Power is constant for a whole session — changing `usb_powered_components`
 * changes the design hash, so the controller ends the session with
 * `stale_simulation_snapshot` instead of re-energising anything mid-run.
 */
import type { DevicePowerState, PowerReason, PowerView } from './contracts.js';
import type { SimDeviceSpec, SimDiagnostic, SimPowerSource, SimulationSnapshot } from './types.js';

/** Nominal USB VBUS handed to a host board that is ticked in the panel. */
export const USB_VBUS_V = 5;

/** One pin of a device and the net it reaches, or `null` when it is unwired. */
export interface PowerPinInput {
  pin: string;
  netId: string | null;
}

export interface PowerDeviceInput {
  componentId: string;
  /** Pins with `role === 'power_in'`. */
  powerIn: PowerPinInput[];
  /** Pins with `role === 'ground'`. */
  ground: PowerPinInput[];
  /** Allowed supply range; `null` means the catalog does not declare one. */
  supply: { min: number; max: number } | null;
  /**
   * Host board fed over USB. Derived from `driver` starting with `mcu.`,
   * because the worker never sees the catalog `category`.
   */
  usbPowered: boolean;
}

export interface PowerDomainInput {
  devices: PowerDeviceInput[];
  /** `enabled` is already resolved here: an MCU rail is live only while its board is. */
  sources: SimPowerSource[];
  /** Every net a `ground` pin sits on, design-wide. Used by `powerPreflight`. */
  groundNets: string[];
  /** `config.usb_powered_components`. `[]` and absent are indistinguishable (plan §5.2). */
  usbPoweredComponents: string[];
  /** Defaults to `USB_VBUS_V`. */
  usbVoltageV?: number;
}

/** A device is USB powered when its driver is an MCU driver (`mcu.*`). */
export function isUsbPoweredDevice(spec: Pick<SimDeviceSpec, 'driver'>): boolean {
  return typeof spec.driver === 'string' && spec.driver.startsWith('mcu.');
}

/**
 * Build the power-domain input from a snapshot.
 *
 * `snapshot.power` is preferred; when it is absent (hand-written snapshots and
 * anything produced before plan §3) the sources and ground nets are derived
 * from `SimDeviceSpec.pinMeta` instead, which yields the same result.
 */
export function powerInputFromSnapshot(snapshot: SimulationSnapshot): PowerDomainInput {
  const usbPoweredComponents = [...(snapshot.config.usb_powered_components ?? [])];
  const usbSet = new Set(usbPoweredComponents);

  const devices: PowerDeviceInput[] = snapshot.devices.map((spec) => {
    const powerIn: PowerPinInput[] = [];
    const ground: PowerPinInput[] = [];
    for (const [pin, meta] of Object.entries(spec.pinMeta ?? {})) {
      const netId = spec.pinNets[pin] ?? null;
      if (meta.role === 'power_in') powerIn.push({ pin, netId });
      else if (meta.role === 'ground') ground.push({ pin, netId });
    }
    return {
      componentId: spec.componentId,
      powerIn: powerIn.sort(byPin),
      ground: ground.sort(byPin),
      supply: spec.supply ?? null,
      usbPowered: isUsbPoweredDevice(spec)
    };
  });

  const fromSnapshot = snapshot.power;
  const rawSources = fromSnapshot ? [...fromSnapshot.sources] : derivedSources(snapshot);
  const groundNets = fromSnapshot ? [...fromSnapshot.groundNets] : derivedGroundNets(snapshot);
  const usbOwners = new Set(devices.filter((device) => device.usbPowered).map((device) => device.componentId));

  // A board's own rails are only live while the board is: an ESP32 that is not
  // ticked in the panel cannot feed 3V3 to anything (plan §5.2, case ㉑). A
  // source on a part nobody powers (`power_module_3v3`) stays enabled, because
  // its own VIN is not modelled (plan §5.4).
  const sources = rawSources
    .map((source) => ({ ...source, enabled: source.enabled && (usbOwners.has(source.componentId) ? usbSet.has(source.componentId) : true) }))
    .sort((a, b) => a.address.localeCompare(b.address));

  return { devices, sources, groundNets: [...new Set(groundNets)].sort(), usbPoweredComponents };
}

function derivedSources(snapshot: SimulationSnapshot): SimPowerSource[] {
  const out: SimPowerSource[] = [];
  for (const spec of snapshot.devices) {
    for (const [pin, meta] of Object.entries(spec.pinMeta ?? {})) {
      if (meta.role !== 'power_out' || typeof meta.voltageV !== 'number') continue;
      out.push({
        address: `${spec.componentId}.${pin}`,
        componentId: spec.componentId,
        pin,
        voltageV: meta.voltageV,
        netId: spec.pinNets[pin] ?? null,
        maxSourceMa: typeof meta.maxSourceMa === 'number' ? meta.maxSourceMa : null,
        enabled: true
      });
    }
  }
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

function derivedGroundNets(snapshot: SimulationSnapshot): string[] {
  const out = new Set<string>();
  for (const spec of snapshot.devices) {
    for (const [pin, meta] of Object.entries(spec.pinMeta ?? {})) {
      if (meta.role !== 'ground') continue;
      const netId = spec.pinNets[pin];
      if (netId) out.add(netId);
    }
  }
  return [...out].sort();
}

function byPin(a: PowerPinInput, b: PowerPinInput): number {
  return a.pin.localeCompare(b.pin);
}

/**
 * Simulation-level blockers that core's design analysis does not catch. Today
 * that is exactly one shape: a rail wired to ground. `analysis.hasBlocking` is
 * false for it, so without this check the session would start and every device
 * would look merely unpowered.
 */
export function powerPreflight(input: PowerDomainInput): SimDiagnostic[] {
  const grounds = new Set(input.groundNets);
  const shorted = new Map<string, SimPowerSource[]>();
  // A short is a wiring fault, so it counts whether or not the rail is enabled.
  for (const source of input.sources) {
    if (source.netId === null || !grounds.has(source.netId)) continue;
    const list = shorted.get(source.netId);
    if (list) list.push(source);
    else shorted.set(source.netId, [source]);
  }

  const out: SimDiagnostic[] = [];
  for (const netId of [...shorted.keys()].sort()) {
    const sources = shorted.get(netId)!;
    const groundPins = input.devices.flatMap((device) => device.ground.filter((pin) => pin.netId === netId).map((pin) => `${device.componentId}.${pin.pin}`));
    out.push({
      code: 'simulation_blocked_by_design',
      severity: 'error',
      message: `电源与地接在同一网络 ${netId}（${[...sources.map((source) => source.address), ...groundPins].join('、')}），仿真不能启动。`,
      componentIds: [...new Set([...sources.map((source) => source.componentId), ...input.devices.filter((device) => device.ground.some((pin) => pin.netId === netId)).map((device) => device.componentId)])].sort(),
      pinAddresses: [...sources.map((source) => source.address), ...groundPins].sort(),
      netIds: [netId]
    });
  }

  // Anything the domain itself considers fatal belongs here too; today it emits
  // only warnings and infos, so this contributes nothing.
  out.push(...new PowerDomain(input).diagnostics().filter((diagnostic) => diagnostic.severity === 'error'));
  return out;
}

export class PowerDomain implements PowerView {
  private readonly input: PowerDomainInput;
  private readonly usbVoltageV: number;
  private readonly rails = new Map<string, number>();
  private readonly systemGround: Set<string>;
  private states: DevicePowerState[] | null = null;
  private byId = new Map<string, DevicePowerState>();
  private diags: SimDiagnostic[] = [];

  constructor(input: PowerDomainInput) {
    this.input = input;
    this.usbVoltageV = input.usbVoltageV ?? USB_VBUS_V;

    for (const source of input.sources) {
      if (!source.enabled || source.netId === null) continue;
      const previous = this.rails.get(source.netId);
      if (previous === undefined || source.voltageV > previous) this.rails.set(source.netId, source.voltageV);
    }

    // System ground = the ground nets of every component that owns a live rail.
    const owners = new Set(input.sources.filter((source) => source.enabled).map((source) => source.componentId));
    this.systemGround = new Set();
    for (const device of input.devices) {
      if (!owners.has(device.componentId)) continue;
      for (const pin of device.ground) if (pin.netId !== null) this.systemGround.add(pin.netId);
    }
  }

  /** Voltage of a rail, or `null` when no enabled source sits on that net. */
  railVoltage(netId: string): number | null {
    return this.rails.get(netId) ?? null;
  }

  isPowered(componentId: string): boolean {
    return this.ensure().get(componentId)?.powered ?? false;
  }

  supplyVoltage(componentId: string): number | null {
    return this.ensure().get(componentId)?.supplyV ?? null;
  }

  diagnostics(): SimDiagnostic[] {
    this.ensure();
    return this.diags;
  }

  /** Recomputes from scratch every call: the result is a pure function of the input. */
  evaluate(): DevicePowerState[] {
    const states: DevicePowerState[] = [];
    const diagnostics: SimDiagnostic[] = [];
    for (const device of this.input.devices) {
      const state = this.evaluateDevice(device, diagnostics);
      states.push(state);
    }
    this.states = states;
    this.byId = new Map(states.map((state) => [state.componentId, state]));
    this.diags = diagnostics;
    return states;
  }

  private ensure(): Map<string, DevicePowerState> {
    if (!this.states) this.evaluate();
    return this.byId;
  }

  private evaluateDevice(device: PowerDeviceInput, diagnostics: SimDiagnostic[]): DevicePowerState {
    const id = device.componentId;
    const done = (reason: PowerReason, supplyV: number | null, sourceNetId: string | null, powered: boolean): DevicePowerState => ({
      componentId: id,
      powered,
      supplyV,
      reason,
      sourceNetId
    });

    let railV: number | null = null;
    let sourceNetId: string | null = null;

    if (device.usbPowered) {
      if (!this.input.usbPoweredComponents.includes(id)) {
        diagnostics.push({
          code: 'device_unpowered',
          severity: 'warning',
          message: `${id} 没有接 USB 供电：在“仿真”面板勾选它之后才会上电。`,
          componentIds: [id]
        });
        return done('usb_off', null, null, false);
      }
      railV = this.usbVoltageV;
    } else if (device.powerIn.length === 0) {
      // A resistor or a bare LED needs no supply of its own.
      return done('passive', null, null, false);
    } else {
      for (const pin of device.powerIn) {
        if (pin.netId === null) continue;
        const voltage = this.railVoltage(pin.netId);
        if (voltage === null) continue;
        // Several power_in pins on different rails: take the highest (plan §5.4).
        // `powerIn` is sorted by pin name, so ties resolve deterministically.
        if (railV === null || voltage > railV) {
          railV = voltage;
          sourceNetId = pin.netId;
        }
      }
      if (railV === null) {
        diagnostics.push({
          code: 'device_unpowered',
          severity: 'warning',
          message: `${id} 的电源引脚没有接到任何已使能的电源轨。`,
          componentIds: [id],
          pinAddresses: device.powerIn.map((pin) => `${id}.${pin.pin}`),
          netIds: device.powerIn.map((pin) => pin.netId).filter((netId): netId is string => netId !== null)
        });
        return done('no_source', null, null, false);
      }
    }

    if (device.supply && (railV < device.supply.min || railV > device.supply.max)) {
      diagnostics.push({
        code: 'device_unpowered',
        severity: 'warning',
        message: `${id} 的实测轨压 ${railV} V 不在允许的供电范围 ${device.supply.min}–${device.supply.max} V 内。`,
        componentIds: [id],
        pinAddresses: device.powerIn.map((pin) => `${id}.${pin.pin}`),
        netIds: sourceNetId === null ? [] : [sourceNetId]
      });
      return done('voltage_out_of_range', railV, sourceNetId, false);
    }

    const groundPins = device.ground.filter((pin) => pin.netId !== null);
    if (groundPins.length === 0) {
      diagnostics.push({
        code: 'missing_common_ground',
        severity: 'warning',
        message: `${id} 的地引脚没有接入任何网络。`,
        componentIds: [id],
        pinAddresses: device.ground.map((pin) => `${id}.${pin.pin}`),
        netIds: []
      });
      return done('no_ground', railV, sourceNetId, false);
    }
    if (!groundPins.some((pin) => this.systemGround.has(pin.netId!))) {
      diagnostics.push({
        code: 'missing_common_ground',
        severity: 'warning',
        message: `${id} 的地引脚与电源地不在同一网络，仿真不能把它当成已上电。`,
        componentIds: [id],
        pinAddresses: groundPins.map((pin) => `${id}.${pin.pin}`),
        netIds: groundPins.map((pin) => pin.netId!)
      });
      return done('no_common_ground', railV, sourceNetId, false);
    }

    if (!device.supply) {
      // Powered, but silently: without a declared range a 5 V rail on a 3.3 V
      // part leaves no trace at all, which is the silent success plan §1 bans.
      diagnostics.push({
        code: 'supply_range_unknown',
        severity: 'info',
        message: `${id} 的供电范围未知，仿真按已上电处理，供电电压不匹配不会被发现（实测轨压 ${railV} V）。`,
        componentIds: [id]
      });
      return done('unknown_range', railV, sourceNetId, true);
    }

    return done('ok', railV, sourceNetId, true);
  }
}
