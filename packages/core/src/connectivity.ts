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
  /** Full conductivity: board groups + inserted pins + internal nets + wires. */
  full: UnionFind;
  /** Board groups + inserted pins only (no wires, no internal nets). */
  boardOnly: UnionFind;
  nets: Net[];
  netByRoot: Map<string, Net>;
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

export function buildConnectivity(model: DesignModel): Connectivity {
  const full = new UnionFind();
  const boardOnly = new UnionFind();

  for (const pb of model.boards.values()) {
    for (const [, names] of pb.resolved.groups) {
      const addrs = names.map((n) => holeAddress(pb.instance.id, n));
      for (const a of addrs) {
        full.add(a);
        boardOnly.add(a);
      }
      for (let i = 1; i < addrs.length; i++) {
        full.union(addrs[0]!, addrs[i]!);
        boardOnly.union(addrs[0]!, addrs[i]!);
      }
    }
  }

  for (const pc of model.components.values()) {
    for (const p of pc.pins) {
      const key = pinKey(pc.instance.id, p.name);
      full.add(key);
      boardOnly.add(key);
      if (p.hole) {
        const h = holeAddress(p.hole.board_id, p.hole.hole);
        full.union(key, h);
        boardOnly.union(key, h);
      }
    }
    for (const group of pc.def.internal_nets ?? []) {
      const existing = group.filter((n) => pc.pins.some((p) => p.name === n));
      for (let i = 1; i < existing.length; i++) full.union(pinKey(pc.instance.id, existing[0]!), pinKey(pc.instance.id, existing[i]!));
    }
  }

  for (const w of model.wires.values()) {
    if (!w.conducts || !w.from || !w.to) continue;
    full.union(w.from.address, w.to.address);
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

  return { full, boardOnly, nets, netByRoot };
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
