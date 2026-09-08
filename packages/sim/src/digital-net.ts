/**
 * Digital net solver (plan §5.1).
 *
 * This module never recomputes connectivity: the net partition comes from the
 * snapshot and every value here is resolved on a given `netId`. A driving end
 * is `(componentId, pin)` carrying one `DigitalValue` and one `DriveStrength`;
 * `resolveNet` looks only at the highest strength tier that is actually
 * driving, so `strong 0` + `pull 1` is `0` while `strong 0` + `strong 1` is a
 * contention.
 *
 * Propagation is synchronous and stays on the host: `drive()` marks the net
 * dirty, re-solves it and calls subscribers in registration order without ever
 * entering the guest VM or moving `nowUs`. A device that wants to react later
 * schedules its own event.
 */
import type { DigitalNet, DriverKey, NetChange } from './contracts.js';
import type { DigitalValue, DriveStrength, NetDriverView, NetRuntimeView, SimDiagnostic, SimNet } from './types.js';

/** `strong > pull > weak`. Only the highest tier that is driving decides the value. */
const STRENGTH_RANK: Readonly<Record<DriveStrength, number>> = { weak: 0, pull: 1, strong: 2 };

/** Oscillation guard: more settle rounds than this is a feedback loop, not a design. */
export const DEFAULT_MAX_SETTLE_ROUNDS = 64;

/** Prefix of the private single-point net synthesised for an unwired pin. */
export const UNCONNECTED_NET_PREFIX = 'unconnected:';

export interface DigitalNetOptions {
  /** Snapshot nets, used for `name` lookup only — the partition itself is never recomputed. */
  nets: readonly SimNet[];
  /** `"<componentId>.<pin>"` → net id. Missing keys become private `unconnected:` nets. */
  pinToNet: Readonly<Record<string, string>>;
  onDiagnostic: (diagnostic: SimDiagnostic) => void;
  /** Current virtual time in µs. The kernel never advances it. */
  now: () => number;
  /**
   * Nets tied to 0 V. They resolve to a strong `0` with no driver of their own,
   * because that is what a ground net *is* — every part connected to it reads low.
   * Without this a grounded input reads `Z`: an LED whose cathode is on GND would
   * never light, and `digitalRead` of a grounded pin would warn about floating.
   */
  groundNets?: readonly string[];
  maxSettleRounds?: number;
}

interface Endpoint {
  readonly componentId: string;
  readonly pin: string;
  readonly address: string;
  readonly netId: string;
  openDrain: boolean;
  /** Last requested value, before the unpowered clamp. */
  value: DigitalValue;
  strength: DriveStrength;
}

interface Subscription {
  componentId: string;
  listener: (change: NetChange) => void;
}

/**
 * Resolve one net from its driving ends. Pure, so the truth table in plan §5.1
 * can be unit-tested without a kernel.
 *
 * `pull 0` + `pull 1` resolves to `X` as well: v0.2 does not model resistor
 * values, so there is no honest divider result to report.
 */
export function resolveNet(drivers: readonly { value: DigitalValue; strength: DriveStrength }[]): { value: DigitalValue; contention: boolean } {
  let top = -1;
  for (const driver of drivers) {
    if (driver.value === 'Z') continue;
    const rank = STRENGTH_RANK[driver.strength] ?? 0;
    if (rank > top) top = rank;
  }
  if (top < 0) return { value: 'Z', contention: false };

  let has0 = false;
  let has1 = false;
  let hasX = false;
  for (const driver of drivers) {
    if (driver.value === 'Z' || (STRENGTH_RANK[driver.strength] ?? 0) !== top) continue;
    if (driver.value === 0) has0 = true;
    else if (driver.value === 1) has1 = true;
    else hasX = true;
  }
  if (hasX || (has0 && has1)) return { value: 'X', contention: true };
  return { value: has1 ? 1 : 0, contention: false };
}

export class DigitalNetKernel implements DigitalNet {
  private readonly options: DigitalNetOptions;
  private readonly maxSettleRounds: number;
  private readonly netNames = new Map<string, string>();
  private readonly endpoints = new Map<string, Endpoint>();
  /** Attach order per net — the order drivers appear to `resolveNet`. */
  private readonly netEndpoints = new Map<string, Endpoint[]>();
  private readonly deviceEndpoints = new Map<string, Endpoint[]>();
  private readonly netValue = new Map<string, DigitalValue>();
  /** Registration order per net; subscribers are called in exactly this order. */
  private readonly subscriptions = new Map<string, Subscription[]>();
  private readonly powered = new Map<string, boolean>();
  /** Edge-triggered diagnostic dedup: `${code}|${netId}|${componentId}|${pin}`. */
  private readonly armed = new Set<string>();
  private readonly armedByNet = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private settling = false;

  private readonly groundNets: ReadonlySet<string>;

  constructor(options: DigitalNetOptions) {
    this.options = options;
    this.maxSettleRounds = options.maxSettleRounds ?? DEFAULT_MAX_SETTLE_ROUNDS;
    this.groundNets = new Set(options.groundNets ?? []);
    // Seed them: a net is only re-solved when something drives it, and nothing
    // ever drives ground. Without this the value stays `Z` until an unrelated
    // change happens to touch the net, and a grounded cathode reads floating.
    for (const netId of this.groundNets) this.netValue.set(netId, 0);
    for (const net of options.nets) if (net.name) this.netNames.set(net.id, net.name);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  attach(key: DriverKey, options?: { openDrain?: boolean }): string {
    const address = addressOf(key);
    const existing = this.endpoints.get(address);
    if (existing) {
      if (options?.openDrain !== undefined) existing.openDrain = options.openDrain;
      return existing.netId;
    }
    const netId = this.netIdOf(key);
    const endpoint: Endpoint = {
      componentId: key.componentId,
      pin: key.pin,
      address,
      netId,
      openDrain: options?.openDrain === true,
      value: 'Z',
      strength: 'strong'
    };
    this.endpoints.set(address, endpoint);
    pushInto(this.netEndpoints, netId, endpoint);
    pushInto(this.deviceEndpoints, key.componentId, endpoint);
    if (!this.netValue.has(netId)) this.netValue.set(netId, 'Z');
    return netId;
  }

  netIdOf(key: DriverKey): string {
    const address = addressOf(key);
    const existing = this.endpoints.get(address);
    if (existing) return existing.netId;
    return this.options.pinToNet[address] ?? `${UNCONNECTED_NET_PREFIX}${address}`;
  }

  subscribe(netId: string, componentId: string, listener: (change: NetChange) => void): () => void {
    const list = this.subscriptions.get(netId) ?? [];
    const entry: Subscription = { componentId, listener };
    list.push(entry);
    this.subscriptions.set(netId, list);
    return () => {
      const current = this.subscriptions.get(netId);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index >= 0) current.splice(index, 1);
    };
  }

  // -------------------------------------------------------------------------
  // Driving
  // -------------------------------------------------------------------------

  drive(key: DriverKey, value: DigitalValue, strength: DriveStrength = 'strong'): void {
    if (value === 'X') throw new Error(`不能主动驱动 X：${addressOf(key)}（这是内核缺陷，不是用户错误）`);
    const endpoint = this.endpointFor(key);
    // Open-drain ends are clamped where they are written, so nothing downstream
    // has to know the pin cannot source a high level (plan §5.1).
    endpoint.value = endpoint.openDrain && value === 1 ? 'Z' : value;
    endpoint.strength = strength;
    this.markDirty(endpoint.netId);
    this.settle();
  }

  setDevicePowered(componentId: string, powered: boolean): void {
    if ((this.powered.get(componentId) ?? true) === powered) return;
    this.powered.set(componentId, powered);
    for (const endpoint of this.deviceEndpoints.get(componentId) ?? []) this.markDirty(endpoint.netId);
    this.settle();
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  valueOf(netId: string): DigitalValue {
    return this.netValue.get(netId) ?? 'Z';
  }

  /**
   * Four-valued read. Never throws: an unknown level has to stay survivable, so
   * the caller gets `Z`/`X` back plus (with `diagnose`) one warning per edge.
   */
  readPin(key: DriverKey, opts?: { diagnose?: boolean }): DigitalValue {
    const endpoint = this.endpointFor(key);
    const value = this.valueOf(endpoint.netId);
    if (!opts?.diagnose) return value;
    // An unpowered device reads Z by definition; that is expected, not a fault.
    if (!this.isPowered(endpoint.componentId)) return value;
    if (value === 'Z') {
      this.emitOnce(endpoint.netId, `floating_input|${endpoint.netId}|${endpoint.componentId}|${endpoint.pin}`, {
        code: 'floating_input',
        severity: 'warning',
        message: `${endpoint.address} 读到浮空电平：这一网络上没有任何驱动端。`,
        atUs: this.options.now(),
        componentIds: [endpoint.componentId],
        pinAddresses: [endpoint.address],
        netIds: [endpoint.netId]
      });
    } else if (value === 'X') {
      this.emitOnce(endpoint.netId, `digital_contention|${endpoint.netId}|${endpoint.componentId}|${endpoint.pin}`, {
        code: 'digital_contention',
        severity: 'warning',
        message: `${endpoint.address} 读到冲突电平：这一网络上同时有驱动 0 与驱动 1 的端。`,
        atUs: this.options.now(),
        componentIds: [endpoint.componentId],
        pinAddresses: [endpoint.address],
        netIds: [endpoint.netId]
      });
    }
    return value;
  }

  /**
   * Stable projection for the UI. Only nets that actually have a driving end
   * attached appear; `unconnected:` private nets are filtered unless asked for.
   */
  view(opts?: { includeUnconnected?: boolean }): NetRuntimeView[] {
    const out: NetRuntimeView[] = [];
    for (const [netId, endpoints] of this.netEndpoints) {
      if (!opts?.includeUnconnected && netId.startsWith(UNCONNECTED_NET_PREFIX)) continue;
      const drivers: NetDriverView[] = endpoints
        .map((endpoint) => ({
          componentId: endpoint.componentId,
          pin: endpoint.pin,
          value: this.effectiveValue(endpoint),
          strength: endpoint.strength
        }))
        .sort((a, b) => a.componentId.localeCompare(b.componentId) || a.pin.localeCompare(b.pin));
      const name = this.netNames.get(netId);
      out.push({ netId, ...(name ? { name } : {}), value: this.valueOf(netId), drivers });
    }
    return out.sort((a, b) => a.netId.localeCompare(b.netId));
  }

  isPowered(componentId: string): boolean {
    return this.powered.get(componentId) ?? true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private endpointFor(key: DriverKey): Endpoint {
    const existing = this.endpoints.get(addressOf(key));
    if (existing) return existing;
    this.attach(key);
    return this.endpoints.get(addressOf(key))!;
  }

  private effectiveValue(endpoint: Endpoint): DigitalValue {
    return this.isPowered(endpoint.componentId) ? endpoint.value : 'Z';
  }

  private markDirty(netId: string): void {
    this.dirty.add(netId);
  }

  /**
   * Re-solve every dirty net and notify. Re-entrancy from a listener only adds
   * to the current dirty set: the outer call keeps draining it.
   */
  private settle(): void {
    if (this.settling) return;
    this.settling = true;
    try {
      let rounds = 0;
      while (this.dirty.size) {
        if (rounds >= this.maxSettleRounds) {
          const netIds = [...this.dirty].sort();
          this.dirty.clear();
          this.options.onDiagnostic({
            code: 'execution_budget_exceeded',
            severity: 'error',
            message: `数字网络在 ${this.maxSettleRounds} 轮内没有稳定，判定为振荡：${netIds.join('、')}。`,
            atUs: this.options.now(),
            netIds
          });
          return;
        }
        rounds++;
        const batch = [...this.dirty];
        this.dirty.clear();
        for (const netId of batch) this.settleNet(netId);
      }
    } finally {
      this.settling = false;
    }
  }

  private settleNet(netId: string): void {
    const endpoints = this.netEndpoints.get(netId) ?? [];
    const drivers = endpoints.map((endpoint) => ({ value: this.effectiveValue(endpoint), strength: endpoint.strength }));
    // Ground is a driver nobody owns. It joins the resolution rather than the
    // endpoint list so it cannot be released, and so it still contends properly
    // with a pin that drives the same net high — which is a real fault.
    if (this.groundNets.has(netId)) drivers.push({ value: 0, strength: 'strong' });
    const { value, contention } = resolveNet(drivers);
    const previous = this.netValue.get(netId) ?? 'Z';
    this.netValue.set(netId, value);

    // Edge-triggered: a value change re-arms every diagnostic scoped to this
    // net, so "conflict → recovery → conflict" reports twice.
    if (value !== previous) this.rearmNet(netId);

    if (contention) {
      const top = topTierEndpoints(endpoints, (endpoint) => this.effectiveValue(endpoint));
      this.emitOnce(netId, `digital_contention|${netId}||`, {
        code: 'digital_contention',
        severity: 'warning',
        message: `网络 ${netId} 上同时有驱动 0 与驱动 1 的端（${top.map((endpoint) => endpoint.address).join('、')}），电平不可知。`,
        atUs: this.options.now(),
        componentIds: [...new Set(top.map((endpoint) => endpoint.componentId))].sort(),
        pinAddresses: top.map((endpoint) => endpoint.address).sort(),
        netIds: [netId]
      });
    }

    if (value === previous) return;
    const change: NetChange = { netId, from: previous, to: value, atUs: this.options.now() };
    for (const subscription of [...(this.subscriptions.get(netId) ?? [])]) subscription.listener(change);
  }

  private emitOnce(netId: string, key: string, diagnostic: SimDiagnostic): void {
    if (this.armed.has(key)) return;
    this.armed.add(key);
    let keys = this.armedByNet.get(netId);
    if (!keys) {
      keys = new Set();
      this.armedByNet.set(netId, keys);
    }
    keys.add(key);
    this.options.onDiagnostic(diagnostic);
  }

  private rearmNet(netId: string): void {
    const keys = this.armedByNet.get(netId);
    if (!keys) return;
    for (const key of keys) this.armed.delete(key);
    keys.clear();
  }
}

function addressOf(key: DriverKey): string {
  return `${key.componentId}.${key.pin}`;
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The ends that actually decide the net value — used to name names in a contention. */
function topTierEndpoints(endpoints: readonly Endpoint[], valueOf: (endpoint: Endpoint) => DigitalValue): Endpoint[] {
  let top = -1;
  for (const endpoint of endpoints) {
    if (valueOf(endpoint) === 'Z') continue;
    const rank = STRENGTH_RANK[endpoint.strength] ?? 0;
    if (rank > top) top = rank;
  }
  return endpoints.filter((endpoint) => valueOf(endpoint) !== 'Z' && (STRENGTH_RANK[endpoint.strength] ?? 0) === top);
}
