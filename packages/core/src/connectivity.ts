import { holeAddress, parseAddress, terminalAddress } from './address.js';
import type { DesignModel, PlacedPin } from './model.js';

export class UnionFind {
  private parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    let k = key;
    if (!this.parent.has(k)) return k;
    while (this.parent.get(k) !== k) {
      const p = this.parent.get(k)!;
      const gp = this.parent.get(p)!;
      this.parent.set(k, gp);
      k = gp;
    }
    return k;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  connected(a: string, b: string): boolean {
    return this.find(a) === this.find(b);
  }

  keys(): IterableIterator<string> {
    return this.parent.keys();
  }
}

export interface Net {
  id: string;
  name: string;
  /** Names derived from net intents that fully resolve to this net. */
  intent_ids: string[];
  holes: string[];
  pins: string[];
  wires: string[];
}

export interface Connectivity {
  /** Where current can flow: board groups + inserted pins + internal nets + wires + passives. */
  full: UnionFind;
  /**
   * Node identity: everything in `full` *except* conduction through a passive.
   *
   * The two differ only where a resistor sits. `full` answers "can current get
   * from here to there", which is what net intents and the simulator need;
   * `direct` answers "is this the same electrical node", which is what a short
   * circuit means. A supply and a ground on one `direct` root is a dead short;
   * on one `full` root through a resistor it is a load, and the rules say so
   * with an estimated current instead of an error.
   */
  direct: UnionFind;
  /** Board groups + inserted pins only (no wires, no internal nets). */
  boardOnly: UnionFind;
  nets: Net[];
  netByRoot: Map<string, Net>;
  /** Conduction paths that actually joined two nodes, for rules that explain a `full` join. */
  conducted: ConductedPath[];
}

/** One passive that current is flowing through, as placed. */
export interface ConductedPath {
  componentId: string;
  kind: 'resistor';
  pins: [string, string];
  /** Ohms parsed from the marking, or null when it is missing or unreadable. */
  ohms: number | null;
  /** The raw marking, for diagnostics that quote it. */
  marking: string | null;
}

export function pinKey(componentId: string, pin: string): string {
  return terminalAddress(componentId, pin);
}

export function voltageName(v: number): string {
  if (Number.isInteger(v)) return `${v}V`;
  const [i, f] = v.toFixed(2).replace(/0+$/, '').split('.');
  return `${i}V${f ?? ''}`;
}

function roleName(pin: PlacedPin): string | null {
  const m = pin.meta;
  switch (m.role) {
    case 'ground':
      return 'GND';
    case 'power_out':
    case 'power_in':
      return typeof m.voltage_v === 'number' ? voltageName(m.voltage_v) : null;
    case 'i2c_sda':
      return 'SDA';
    case 'i2c_scl':
      return 'SCL';
    default:
      return null;
  }
}

/**
 * Ohms from a resistor marking. Accepts plain numbers (`"220"`), an SI suffix
 * (`"4.7k"`, `"1M"`) and the printed form that uses the multiplier as the decimal
 * point (`"4k7"`), which is what is actually written on a lot of parts. Returns
 * null for anything it cannot read, so the caller reports "unknown" rather than
 * inventing a current.
 */
export function parseResistance(marking: unknown): number | null {
  if (typeof marking === 'number') return Number.isFinite(marking) && marking >= 0 ? marking : null;
  if (typeof marking !== 'string') return null;
  const text = marking.trim().replace(/(ohms?|Ω|R$)/gi, '').trim();
  if (!text) return null;
  const MULT: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, m: 1e-3, R: 1, r: 1 };
  // "4k7" — the suffix stands in for the decimal point
  const embedded = /^(\d+)([kKMmRr])(\d+)$/.exec(text);
  if (embedded) {
    const scale = MULT[embedded[2]!]!;
    return Number(`${embedded[1]}.${embedded[3]}`) * scale;
  }
  const suffixed = /^(\d+(?:\.\d+)?)\s*([kKMmRr]?)$/.exec(text);
  if (!suffixed) return null;
  const value = Number(suffixed[1]);
  if (!Number.isFinite(value)) return null;
  return value * (suffixed[2] ? (MULT[suffixed[2]] ?? 1) : 1);
}

export function buildConnectivity(model: DesignModel): Connectivity {
  const full = new UnionFind();
  const direct = new UnionFind();
  const boardOnly = new UnionFind();

  for (const pb of model.boards.values()) {
    for (const [, names] of pb.resolved.groups) {
      const addrs = names.map((n) => holeAddress(pb.instance.id, n));
      for (const a of addrs) {
        full.add(a);
        direct.add(a);
        boardOnly.add(a);
      }
      for (let i = 1; i < addrs.length; i++) {
        full.union(addrs[0]!, addrs[i]!);
        direct.union(addrs[0]!, addrs[i]!);
        boardOnly.union(addrs[0]!, addrs[i]!);
      }
    }
  }

  for (const pc of model.components.values()) {
    for (const p of pc.pins) {
      const key = pinKey(pc.instance.id, p.name);
      full.add(key);
      direct.add(key);
      boardOnly.add(key);
      if (p.hole) {
        const h = holeAddress(p.hole.board_id, p.hole.hole);
        full.union(key, h);
        direct.union(key, h);
        boardOnly.union(key, h);
      }
    }
    for (const group of pc.def.internal_nets ?? []) {
      const existing = group.filter((n) => pc.pins.some((p) => p.name === n));
      for (let i = 1; i < existing.length; i++) {
        full.union(pinKey(pc.instance.id, existing[0]!), pinKey(pc.instance.id, existing[i]!));
        direct.union(pinKey(pc.instance.id, existing[0]!), pinKey(pc.instance.id, existing[i]!));
      }
    }
  }

  for (const w of model.wires.values()) {
    if (!w.conducts || !w.from || !w.to) continue;
    full.union(w.from.address, w.to.address);
    direct.union(w.from.address, w.to.address);
  }

  // Passives last, and only into `full`: a resistor lets current through without
  // making its two legs one node. Wires are already in, so the path a resistor
  // completes is the one the user actually built.
  const conducted: ConductedPath[] = [];
  for (const pc of model.components.values()) {
    for (const path of pc.def.conduction ?? []) {
      const [a, b] = path.pins;
      if (!pc.pins.some((p) => p.name === a) || !pc.pins.some((p) => p.name === b)) continue;
      const marking = path.value_param ? (pc.resolved.params?.[path.value_param] as string | number | undefined) : undefined;
      full.union(pinKey(pc.instance.id, a), pinKey(pc.instance.id, b));
      conducted.push({
        componentId: pc.instance.id,
        kind: path.kind,
        pins: [a, b],
        ohms: parseResistance(marking),
        marking: marking === undefined || marking === null ? null : String(marking)
      });
    }
  }

  // ---- collect nets ----
  const members = new Map<string, { holes: string[]; pins: string[]; wires: Set<string> }>();
  const bucket = (root: string) => {
    let m = members.get(root);
    if (!m) {
      m = { holes: [], pins: [], wires: new Set() };
      members.set(root, m);
    }
    return m;
  };
  for (const addr of model.holes.keys()) bucket(full.find(addr)).holes.push(addr);
  const pinByKey = new Map<string, PlacedPin>();
  for (const pc of model.components.values()) {
    for (const p of pc.pins) {
      const key = pinKey(pc.instance.id, p.name);
      pinByKey.set(key, p);
      bucket(full.find(key)).pins.push(key);
    }
  }
  for (const w of model.wires.values()) {
    if (!w.conducts || !w.from) continue;
    bucket(full.find(w.from.address)).wires.add(w.instance.id);
  }

  // ---- intents ----
  const intentRoots = new Map<string, string[]>(); // root -> intent ids fully inside
  for (const intent of model.design.net_intents) {
    const roots = new Set<string>();
    let unknown = false;
    for (const ep of intent.endpoints) {
      const key = resolveAddressKey(model, ep);
      if (!key) {
        unknown = true;
        continue;
      }
      roots.add(full.find(key));
    }
    if (!unknown && roots.size === 1) {
      const r = [...roots][0]!;
      intentRoots.set(r, [...(intentRoots.get(r) ?? []), intent.id]);
    }
  }

  const nets: Net[] = [];
  const netByRoot = new Map<string, Net>();
  let n = 0;
  for (const [root, m] of members) {
    if (!m.wires.size && m.pins.length < 2) continue; // unused board group or a lone pin
    const ids = intentRoots.get(root) ?? [];
    let name: string | null = null;
    if (ids.length) {
      name = ids.map((id) => model.design.net_intents.find((i) => i.id === id)!.name).join('+');
    } else {
      for (const pk of m.pins) {
        const rn = roleName(pinByKey.get(pk)!);
        if (rn) {
          name = rn;
          break;
        }
      }
      if (!name) name = m.pins[0] ?? m.holes[0] ?? `net_${n}`;
    }
    n++;
    const net: Net = { id: `net_${n}`, name, intent_ids: ids, holes: m.holes.sort(), pins: m.pins.sort(), wires: [...m.wires].sort() };
    nets.push(net);
    netByRoot.set(root, net);
  }
  nets.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return { full, direct, boardOnly, nets, netByRoot, conducted };
}

/** Resolve a `board.hole` or `component.pin` address to a connectivity key, or null if unknown. */
export function resolveAddressKey(model: DesignModel, addr: string): string | null {
  const parsed = parseAddress(addr);
  if (!parsed) return null;
  if (model.boards.has(parsed.owner)) {
    return model.holes.has(addr) ? addr : null;
  }
  const pc = model.components.get(parsed.owner);
  if (pc && pc.pins.some((p) => p.name === parsed.name)) return addr;
  return null;
}

export function netOfAddress(model: DesignModel, conn: Connectivity, addr: string): Net | null {
  const key = resolveAddressKey(model, addr);
  if (!key) return null;
  return conn.netByRoot.get(conn.full.find(key)) ?? null;
}

/** Members of the full conductive set for an address (even when the set has no pins/wires). */
export function conductiveSet(model: DesignModel, conn: Connectivity, addr: string): { holes: string[]; pins: string[] } {
  const key = resolveAddressKey(model, addr);
  if (!key) return { holes: [], pins: [] };
  const root = conn.full.find(key);
  const holes: string[] = [];
  const pins: string[] = [];
  for (const h of model.holes.keys()) if (conn.full.find(h) === root) holes.push(h);
  for (const pc of model.components.values()) {
    for (const p of pc.pins) {
      const k = pinKey(pc.instance.id, p.name);
      if (conn.full.find(k) === root) pins.push(k);
    }
  }
  return { holes: holes.sort(), pins: pins.sort() };
}
