/**
 * DesignDocument → SimulationSnapshot (docs §6). Pure data: stable net ids,
 * pin → net map and one device spec per component. No behaviour is attached
 * here; drivers are resolved by the backend from `SimDeviceSpec.driver`.
 */
import type { DesignDocument, JsonValue } from '@breadboard-studio/schema';
import { Catalog, builtinCatalog } from '@breadboard-studio/catalog';
import { analyzeDesign, designHash, sha256Hex, type Analysis } from '@breadboard-studio/core';
import { SIM_PROTOCOL_VERSION, type SimDeviceSpec, type SimNet, type SimulationSnapshot } from './types.js';

/** Stable net id: short hash of the sorted member addresses, so the same wiring always yields the same id. */
export function netIdFor(members: readonly string[]): string {
  return `net_${sha256Hex([...members].sort().join('\n')).slice(0, 12)}`;
}

export function buildSnapshot(design: DesignDocument, catalog: Catalog = builtinCatalog(), analysis: Analysis = analyzeDesign(design, catalog)): SimulationSnapshot {
  const nets: SimNet[] = [];
  const pinToNet: Record<string, string> = {};
  for (const net of analysis.connectivity.nets) {
    const members = [...net.holes, ...net.pins].sort();
    const id = netIdFor(members);
    nets.push({ id, members, ...(net.name ? { name: net.name } : {}) });
    for (const pin of net.pins) pinToNet[pin] = id;
  }
  nets.sort((a, b) => a.id.localeCompare(b.id));

  const devices: SimDeviceSpec[] = [];
  for (const instance of design.components) {
    const pc = analysis.model.components.get(instance.id);
    const def = pc?.def;
    const pinNets: Record<string, string> = {};
    for (const pin of pc?.pins ?? []) {
      const id = pinToNet[`${instance.id}.${pin.name}`];
      if (id) pinNets[pin.name] = id;
    }
    const properties: Record<string, unknown> = { ...(def?.simulation?.properties ?? {}), ...(pc?.resolved.config ?? instance.config ?? {}) };
    devices.push({
      componentId: instance.id,
      model: instance.model,
      driver: def?.simulation?.driver ?? null,
      pinNets,
      pinChannels: { ...(def?.simulation?.pins ?? {}) },
      properties: properties as Record<string, JsonValue>
    });
  }

  return {
    protocol: SIM_PROTOCOL_VERSION,
    designRevision: design.metadata.revision,
    designHash: designHash(design),
    nets,
    pinToNet,
    devices,
    programs: [...(design.programs ?? [])],
    config: { ...(design.simulation ?? {}) }
  };
}
