import { parseAddress } from './address.js';
import type { Connectivity } from './connectivity.js';
import type { DesignModel, ResolvedEndpoint } from './model.js';

export interface BuildStep {
  index: number;
  wire_id: string;
  name: string;
  color: string;
  route: 'flat' | 'elevated';
  from: string;
  from_label: string;
  to: string | null;
  to_label: string;
  length_mm: number | null;
  net: string | null;
  complete: boolean;
}

function endpointLabel(model: DesignModel, ep: ResolvedEndpoint | null): string {
  if (!ep) return '（未指定）';
  if (ep.kind === 'terminal') {
    const pc = model.components.get(ep.component_id);
    return `${pc?.instance.name ?? ep.component_id} 端子 ${ep.pin}`;
  }
  const pb = model.boards.get(ep.board_id);
  const st = model.holes.get(ep.address);
  let ctx = '';
  const parsed = parseAddress(ep.address)!;
  const hole = pb?.resolved.holes.get(parsed.name);
  if (hole && pb) {
    const groupHoles = pb.resolved.groups.get(hole.group) ?? [];
    for (const h of groupHoles) {
      const s = model.holes.get(`${pb.instance.id}.${h}`);
      if (s?.status === 'occupied') {
        const pc = model.components.get(s.component_id!);
        ctx = `，同组 ${pc?.instance.name ?? s.component_id}.${s.pin}`;
        break;
      }
    }
  }
  void st;
  return `${pb?.instance.name ?? ep.board_id} 孔 ${parsed.name}${ctx}`;
}

/** Wire-by-wire build guide. It is guidance only and never proves the physical circuit conducts. */
export function buildSteps(model: DesignModel, conn: Connectivity, done: string[] = []): BuildStep[] {
  const wires = [...model.wires.values()];
  wires.sort((a, b) => a.instance.id.localeCompare(b.instance.id, undefined, { numeric: true }));
  return wires.map((w, i) => {
    const net = w.from ? conn.netByRoot.get(conn.full.find(w.from.address)) : undefined;
    return {
      index: i + 1,
      wire_id: w.instance.id,
      name: w.instance.name ?? w.instance.id,
      color: w.instance.color,
      route: w.instance.route,
      from: w.from?.address ?? w.instance.from.hole ?? w.instance.from.terminal ?? '',
      from_label: endpointLabel(model, w.from),
      to: w.to?.address ?? null,
      to_label: endpointLabel(model, w.to),
      length_mm: w.to ? Math.round(w.length_um / 100) / 10 : null,
      net: net?.name ?? null,
      complete: done.includes(w.instance.id)
    };
  });
}
