/**
 * DesignDocument → SimulationSnapshot (docs §6). Pure data: stable net ids,
 * pin → net map and one device spec per component. No behaviour is attached
 * here; drivers are resolved by the backend from `SimDeviceSpec.driver`.
 *
 * Everything the worker needs is precomputed on this side, reusing core's
 * connectivity graph and electrical helpers (plan §3). The worker never
 * imports core, so it only ever compares the ids produced here.
 */
import type { DesignDocument, JsonValue, PinMeta } from '@breadboard-studio/schema';
import { Catalog, builtinCatalog } from '@breadboard-studio/catalog';
import { analyzeDesign, designHash, i2cAddress, i2cBuses, i2cPins, sha256Hex, supplyRange, type Analysis, type PlacedComponent } from '@breadboard-studio/core';
import { SIM_PROTOCOL_VERSION, type SimDeviceSpec, type SimI2cBusBinding, type SimI2cSpec, type SimNet, type SimPinMeta, type SimPowerSource, type SimulationSnapshot } from './types.js';

/** Stable net id: short hash of the sorted member addresses, so the same wiring always yields the same id. */
export function netIdFor(members: readonly string[]): string {
  return `net_${sha256Hex([...members].sort().join('\n')).slice(0, 12)}`;
}

/**
 * Net id of a pin, or the `unconnected:` literal when it is not wired. Using a
 * literal rather than `undefined` means the worker never has to tell "no key"
 * apart from "wired wrong": both are simply a net nobody else is on.
 */
export function netIdOfPin(pinToNet: Record<string, string>, componentId: string, pin: string): string {
  return pinToNet[`${componentId}.${pin}`] ?? `unconnected:${componentId}.${pin}`;
}

function pinMetaOf(meta: PinMeta): SimPinMeta {
  const out: SimPinMeta = { role: meta.role };
  if (meta.direction !== undefined) out.direction = meta.direction;
  if (meta.drive !== undefined) out.drive = meta.drive;
  if (meta.voltage_v !== undefined) out.voltageV = meta.voltage_v;
  if (meta.io_voltage_v !== undefined) out.ioVoltageV = meta.io_voltage_v;
  if (meta.max_source_ma !== undefined) out.maxSourceMa = meta.max_source_ma;
  return out;
}

function i2cSpecOf(pc: PlacedComponent, pinToNet: Record<string, string>): SimI2cSpec | undefined {
  const pins = i2cPins(pc);
  if (!pins) return undefined;
  const id = pc.instance.id;
  const controller = pc.def.category === 'mcu';
  const bind = (index: number, sdaPin: string, sclPin: string): SimI2cBusBinding => ({
    index,
    sdaPin,
    sclPin,
    sdaNet: netIdOfPin(pinToNet, id, sdaPin),
    sclNet: netIdOfPin(pinToNet, id, sclPin)
  });
  const buses = controller ? i2cBuses(pc).map((bus) => bind(bus.index, bus.sda, bus.scl)) : [bind(0, pins.sda, pins.scl)];
  return { role: controller ? 'controller' : 'device', buses, address: i2cAddress(pc) };
}

export function buildSnapshot(design: DesignDocument, catalog: Catalog = builtinCatalog(), analysis: Analysis = analyzeDesign(design, catalog)): SimulationSnapshot {
  const nets: SimNet[] = [];
  const pinToNet: Record<string, string> = {};
  for (const net of analysis.connectivity.nets) {
    const members = [...net.holes, ...net.pins].sort();
    const id = netIdFor(members);
    nets.push({ id, members, pins: [...net.pins].sort(), ...(net.name ? { name: net.name } : {}) });
    for (const pin of net.pins) pinToNet[pin] = id;
  }
  nets.sort((a, b) => a.id.localeCompare(b.id));

  const devices: SimDeviceSpec[] = [];
  const sources: SimPowerSource[] = [];
  const groundNets = new Set<string>();

  for (const instance of design.components) {
    const pc = analysis.model.components.get(instance.id);
    const def = pc?.def;
    const pinNets: Record<string, string> = {};
    const pinMeta: Record<string, SimPinMeta> = {};
    for (const pin of pc?.pins ?? []) {
      const id = pinToNet[`${instance.id}.${pin.name}`];
      if (id) pinNets[pin.name] = id;
      pinMeta[pin.name] = pinMetaOf(pin.meta);

      // Power sources and ground nets are derived from pin roles only; the
      // runtime power domain decides what is actually energised (plan §5.2).
      if (pin.meta.role === 'power_out' && typeof pin.meta.voltage_v === 'number') {
        sources.push({
          address: `${instance.id}.${pin.name}`,
          componentId: instance.id,
          pin: pin.name,
          voltageV: pin.meta.voltage_v,
          netId: id ?? null,
          maxSourceMa: typeof pin.meta.max_source_ma === 'number' ? pin.meta.max_source_ma : null,
          enabled: true
        });
      }
      if (pin.meta.role === 'ground' && id) groundNets.add(id);
    }

    const properties: Record<string, unknown> = { ...(def?.simulation?.properties ?? {}), ...(pc?.resolved.config ?? instance.config ?? {}) };
    const spec: SimDeviceSpec = {
      componentId: instance.id,
      model: instance.model,
      driver: def?.simulation?.driver ?? null,
      pinNets,
      pinChannels: { ...(def?.simulation?.pins ?? {}) },
      properties: properties as Record<string, JsonValue>
    };
    if (pc) {
      spec.pinMeta = pinMeta;
      spec.supply = supplyRange(pc);
      const i2c = i2cSpecOf(pc, pinToNet);
      if (i2c) spec.i2c = i2c;
    }
    devices.push(spec);
  }

  sources.sort((a, b) => a.address.localeCompare(b.address));

  return {
    protocol: SIM_PROTOCOL_VERSION,
    designRevision: design.metadata.revision,
    designHash: designHash(design),
    nets,
    pinToNet,
    devices,
    programs: [...(design.programs ?? [])],
    config: { ...(design.simulation ?? {}) },
    power: { sources, groundNets: [...groundNets].sort() }
  };
}
