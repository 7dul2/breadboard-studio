/**
 * In-memory `DeviceContext` for driver unit tests (plan §7.5).
 *
 * Virtual time is advanced by hand — no `vi.useFakeTimers()`, no real clock —
 * and every call a driver makes is recorded so a test can assert on it. The
 * fake mirrors the two kernel rules a driver depends on: touching a pin that is
 * not this device's throws, and a read of `Z`/`X` raises the same edge-triggered
 * warning `DigitalNetKernel.readPin({ diagnose: true })` would raise (plan §5.1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDesign } from '@breadboard-studio/core';
import { buildSnapshot } from '../../src/index.js';
import type { DeviceContext, DeviceDriver, DevicePower } from '../../src/contracts.js';
import type { DeviceVisualState, DigitalValue, DriveStrength, SimDeviceSpec, SimDiagnostic, SimulationSnapshot } from '../../src/types.js';

const examplesDir = join(import.meta.dirname, '..', '..', '..', '..', 'examples');

/**
 * Snapshot of a repository example. Tests may import core and the package root
 * (the import gate of plan §1.3 only covers `src/`), so driver tests run against
 * the same device specs the product builds.
 */
export function fixtureSnapshot(name = 'touch_display.breadboard.json'): SimulationSnapshot {
  const loaded = loadDesign(readFileSync(join(examplesDir, name), 'utf8'));
  if (!loaded.ok || !loaded.design) throw new Error(`example ${name} failed to load: ${JSON.stringify(loaded.errors)}`);
  return buildSnapshot(loaded.design);
}

export function fixtureSpec(componentId: string, name?: string): SimDeviceSpec {
  const spec = fixtureSnapshot(name).devices.find((device) => device.componentId === componentId);
  if (!spec) throw new Error(`example has no component ${componentId}`);
  return spec;
}

export interface DriveCall {
  pin: string;
  value: DigitalValue;
  strength: DriveStrength;
  atUs: number;
}

export interface ReleaseCall {
  pin: string;
  atUs: number;
}

export interface SerialCall {
  stream: 'stdout' | 'stderr';
  text: string;
  atUs: number;
}

export interface I2cAttachCall {
  sdaPin: string;
  sclPin: string;
  addresses: number[];
}

export interface DeviceHarness {
  readonly ctx: DeviceContext;
  /** Route timer callbacks to this driver. */
  bind<T extends DeviceDriver>(driver: T): T;

  readonly drives: DriveCall[];
  readonly releases: ReleaseCall[];
  readonly visuals: DeviceVisualState[][];
  readonly serial: SerialCall[];
  readonly diagnostics: SimDiagnostic[];
  readonly watched: string[];
  readonly i2cAttachments: I2cAttachCall[];

  /** Last published visual array, i.e. what the UI would currently show. */
  lastVisual(): DeviceVisualState[];
  /** Diagnostic codes in emission order. */
  codes(): string[];
  /** The driving end the device currently holds on `pin`, or null once released. */
  heldDrive(pin: string): { value: DigitalValue; strength: DriveStrength } | null;

  /** What the rest of the net resolves to, as seen by this device. */
  setNet(pin: string, value: DigitalValue): void;
  clearNet(pin: string): void;
  setPower(patch: Partial<DevicePower>): void;
  power(): DevicePower;

  nowUs(): number;
  /** Advance virtual time, firing every timer that comes due, in order. */
  advance(deltaUs: number): void;
  pendingTimers(): number;
  clearLog(): void;
}

interface PendingTimer {
  handle: number;
  atUs: number;
  seq: number;
  token: number;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

export function createDeviceHarness(options: { spec: SimDeviceSpec; power?: Partial<DevicePower>; random?: () => number; nowUs?: number }): DeviceHarness {
  const spec = deepFreeze(structuredClone(options.spec));
  const componentId = spec.componentId;
  const known = new Set([...Object.keys(spec.pinChannels), ...Object.keys(spec.pinNets)]);

  const drives: DriveCall[] = [];
  const releases: ReleaseCall[] = [];
  const visuals: DeviceVisualState[][] = [];
  const serial: SerialCall[] = [];
  const diagnostics: SimDiagnostic[] = [];
  const watched: string[] = [];
  const i2cAttachments: I2cAttachCall[] = [];

  const held = new Map<string, { value: DigitalValue; strength: DriveStrength }>();
  const external = new Map<string, DigitalValue>();
  const onceKeys = new Set<string>();
  const armedReadWarnings = new Set<string>();
  const timers: PendingTimer[] = [];

  let power: DevicePower = { railV: 3.3, groundOk: true, powered: true, ...(options.power ?? {}) };
  let nowUs = options.nowUs ?? 0;
  let seq = 0;
  let handles = 0;
  let driver: DeviceDriver | null = null;

  const randomSource = options.random ?? (() => 0.5);

  function assertPin(pin: string, what: string): void {
    if (!known.has(pin)) throw new Error(`${what}: ${pin} is not a pin of ${componentId}`);
  }

  function netValue(pin: string): DigitalValue {
    const ext = external.get(pin);
    if (ext !== undefined) return ext;
    const own = held.get(pin);
    return own === undefined ? 'Z' : own.value;
  }

  /** Edge-triggered like the kernel: one diagnostic per key until it clears. */
  function raiseReadWarning(pin: string, value: DigitalValue): void {
    const codes = { Z: 'floating_input', X: 'digital_contention' } as const;
    for (const [level, code] of Object.entries(codes) as ['Z' | 'X', 'floating_input' | 'digital_contention'][]) {
      const key = `${code}|${pin}`;
      if (value !== level) {
        armedReadWarnings.delete(key);
        continue;
      }
      if (armedReadWarnings.has(key)) continue;
      armedReadWarnings.add(key);
      diagnostics.push({
        code,
        severity: 'warning',
        message: code === 'floating_input' ? `${componentId}.${pin} 悬空` : `${componentId}.${pin} 电平冲突`,
        atUs: nowUs,
        componentIds: [componentId],
        pinAddresses: [`${componentId}.${pin}`]
      });
    }
  }

  const ctx: DeviceContext = {
    componentId,
    spec,
    nowUs: () => nowUs,
    random: () => randomSource(),
    drive(pin: string, value: DigitalValue, strength: DriveStrength = 'strong') {
      assertPin(pin, 'drive');
      if (value === 'X') throw new Error(`drive: X is not a legal drive value (${componentId}.${pin})`);
      held.set(pin, { value, strength });
      drives.push({ pin, value, strength, atUs: nowUs });
    },
    release(pin: string) {
      assertPin(pin, 'release');
      held.delete(pin);
      releases.push({ pin, atUs: nowUs });
    },
    read(pin: string) {
      assertPin(pin, 'read');
      const value = netValue(pin);
      if (power.powered) raiseReadWarning(pin, value);
      return value;
    },
    watch(pin: string) {
      assertPin(pin, 'watch');
      watched.push(pin);
    },
    netIdOf(pin: string) {
      assertPin(pin, 'netIdOf');
      return spec.pinNets[pin] ?? `unconnected:${componentId}.${pin}`;
    },
    power: () => power,
    after(delayUs: number, token: number) {
      const handle = ++handles;
      timers.push({ handle, atUs: nowUs + delayUs, seq: ++seq, token });
      return handle;
    },
    cancel(handle: number) {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    visual(states: DeviceVisualState[]) {
      visuals.push(states);
    },
    serial(stream: 'stdout' | 'stderr', text: string) {
      serial.push({ stream, text, atUs: nowUs });
    },
    diagnose(d) {
      diagnostics.push({ ...d, atUs: nowUs, componentIds: [componentId] });
    },
    diagnoseOnce(key: string, d) {
      if (onceKeys.has(key)) return;
      onceKeys.add(key);
      diagnostics.push({ ...d, atUs: nowUs, componentIds: [componentId] });
    },
    attachI2c(sdaPin: string, sclPin: string, addresses: number[]) {
      assertPin(sdaPin, 'attachI2c');
      assertPin(sclPin, 'attachI2c');
      i2cAttachments.push({ sdaPin, sclPin, addresses: [...addresses] });
    }
  };

  return {
    ctx,
    bind(next) {
      driver = next;
      return next;
    },
    drives,
    releases,
    visuals,
    serial,
    diagnostics,
    watched,
    i2cAttachments,
    lastVisual: () => visuals[visuals.length - 1] ?? [],
    codes: () => diagnostics.map((d) => d.code),
    heldDrive(pin) {
      const own = held.get(pin);
      return own === undefined ? null : { ...own };
    },
    setNet(pin, value) {
      external.set(pin, value);
    },
    clearNet(pin) {
      external.delete(pin);
    },
    setPower(patch) {
      power = { ...power, ...patch };
      driver?.onPowerChange?.(power);
    },
    power: () => power,
    nowUs: () => nowUs,
    advance(deltaUs) {
      const target = nowUs + deltaUs;
      for (;;) {
        let next: PendingTimer | null = null;
        for (const timer of timers) {
          if (timer.atUs > target) continue;
          if (next === null || timer.atUs < next.atUs || (timer.atUs === next.atUs && timer.seq < next.seq)) next = timer;
        }
        if (next === null) break;
        timers.splice(timers.indexOf(next), 1);
        nowUs = next.atUs;
        driver?.onTimer?.(next.token);
      }
      nowUs = target;
    },
    pendingTimers: () => timers.length,
    clearLog() {
      drives.length = 0;
      releases.length = 0;
      visuals.length = 0;
      serial.length = 0;
      diagnostics.length = 0;
      watched.length = 0;
    }
  };
}
