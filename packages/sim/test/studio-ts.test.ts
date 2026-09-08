import { beforeAll, describe, expect, it } from 'vitest';
import { DefaultIntrinsics, newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { transform } from 'sucrase';
import type { WallClock } from '../src/contracts.js';
import type { DigitalValue, SimDiagnostic } from '../src/types.js';
import { compileStudioTs } from '../src/runtime/compile.js';
import { GUEST_MODULES, I2C_STATUS, type I2cStatusCode } from '../src/runtime/guest-modules.js';
import { SANDBOX_FORBIDDEN_GLOBALS } from '../src/runtime/prelude.js';
import {
  HOST_LIMITS,
  SANDBOX_INTRINSICS,
  SANDBOX_MAX_STACK_BYTES,
  StudioTsSandbox,
  type I2cBeginOptions,
  type I2cReadResult,
  type SandboxHost
} from '../src/runtime/studio-ts.js';

let quickjs: QuickJSWASMModule;

beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
}, 60_000);

/**
 * A clock the test moves by hand. `step` is how much a single `nowMs()` call
 * advances it, which is how the interrupt handler is made to reach its deadline
 * without any real timer.
 */
class TestClock implements WallClock {
  ms = 0;
  step = 0;
  nowMs(): number {
    const value = this.ms;
    this.ms += this.step;
    return value;
  }
}

/** Host stand-in: records every bridge call and completes async work on demand. */
class FakeHost implements SandboxHost {
  nowUsValue = 0;
  pins = new Set<number>([1, 4, 8, 9, 48]);
  pinModes: Array<[number, number]> = [];
  digitalWrites: Array<[number, 0 | 1]> = [];
  pinValues = new Map<number, DigitalValue>();
  serialText = '';
  serialBauds: number[] = [];
  rgbCalls: Array<[number, number, number]> = [];
  model = 'esp32s3_n16r8_dual_usb';
  beginCalls: I2cBeginOptions[] = [];
  beginStatus: I2cStatusCode = I2C_STATUS.OK;
  endCalls = 0;
  clockCalls: number[] = [];
  i2cWrites: Array<{ address: number; bytes: Uint8Array }> = [];
  i2cReads: Array<{ address: number; length: number }> = [];
  ackAddresses = new Set<number>([0x3c]);
  readPayload = new Uint8Array([0xa1, 0xb2, 0xc3]);
  diagnostics: SimDiagnostic[] = [];
  sleeps: number[] = [];

  private queue: Array<{ atUs: number; seq: number; run: () => void }> = [];
  private seq = 0;

  nowUs(): number {
    return this.nowUsValue;
  }
  hasPin(pin: number): boolean {
    return this.pins.has(pin);
  }
  pinMode(pin: number, mode: number): void {
    this.pinModes.push([pin, mode]);
  }
  digitalWrite(pin: number, value: 0 | 1): void {
    this.digitalWrites.push([pin, value]);
  }
  digitalRead(pin: number): DigitalValue {
    return this.pinValues.get(pin) ?? 0;
  }
  serialBegin(baud: number): void {
    this.serialBauds.push(baud);
  }
  serialWrite(text: string): void {
    this.serialText += text;
  }
  boardModel(): string {
    return this.model;
  }
  rgb(r: number, g: number, b: number): void {
    this.rgbCalls.push([r, g, b]);
  }
  sleep(delayUs: number, done: () => void): void {
    this.sleeps.push(delayUs);
    this.schedule(delayUs, done);
  }
  i2cBegin(options: I2cBeginOptions): I2cStatusCode {
    this.beginCalls.push(options);
    return this.beginStatus;
  }
  i2cEnd(): void {
    this.endCalls++;
  }
  i2cSetClock(hz: number): void {
    this.clockCalls.push(hz);
  }
  i2cWrite(address: number, bytes: Uint8Array, done: (status: I2cStatusCode) => void): void {
    this.i2cWrites.push({ address, bytes });
    const status = this.ackAddresses.has(address) ? I2C_STATUS.OK : I2C_STATUS.NACK_ADDRESS;
    this.schedule(100, () => done(status));
  }
  i2cRead(address: number, length: number, done: (result: I2cReadResult) => void): void {
    this.i2cReads.push({ address, length });
    const ok = this.ackAddresses.has(address);
    this.schedule(100, () =>
      done({
        status: ok ? I2C_STATUS.OK : I2C_STATUS.NACK_ADDRESS,
        bytes: ok ? this.readPayload.slice(0, length) : new Uint8Array(0)
      })
    );
  }
  i2cWriteRead(address: number, bytes: Uint8Array, readLength: number, done: (result: I2cReadResult) => void): void {
    this.i2cWrites.push({ address, bytes });
    this.i2cRead(address, readLength, done);
  }
  diagnose(diagnostic: SimDiagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  private schedule(delayUs: number, run: () => void): void {
    this.queue.push({ atUs: this.nowUsValue + delayUs, seq: this.seq++, run });
  }

  /** Fire the earliest scheduled completion, moving virtual time to it. */
  runNext(): boolean {
    if (this.queue.length === 0) return false;
    this.queue.sort((a, b) => a.atUs - b.atUs || a.seq - b.seq);
    const next = this.queue.shift()!;
    this.nowUsValue = next.atUs;
    next.run();
    return true;
  }

  lines(): string[] {
    return this.serialText.split('\n').filter((line) => line.length > 0);
  }
}

interface Harness {
  sandbox: StudioTsSandbox;
  host: FakeHost;
  clock: TestClock;
}

function build(code: string, options: { seed?: number; filename?: string; host?: FakeHost } = {}): Harness {
  const host = options.host ?? new FakeHost();
  const clock = new TestClock();
  const sandbox = new StudioTsSandbox({
    quickjs,
    program: { code, filename: options.filename ?? 'program_main' },
    host,
    clock,
    seed: options.seed ?? 1
  });
  return { sandbox, host, clock };
}

function compiled(source: string, id = 'program_main'): { code: string; filename: string } {
  const result = compileStudioTs({ id, name: 'p', target_component_id: 'mcu', language: 'studio-ts', source }, transform);
  if (!result.ok) throw new Error(`fixture failed to compile: ${result.diagnostic.message}`);
  return { code: result.code, filename: result.filename };
}

/** Minimal stand-in for `SimLoop`: drain jobs, then let the host complete work. */
function drive(h: Harness, entry: string, rounds = 20_000): 'fulfilled' | { error: unknown } | 'stalled' | 'rounds' {
  const call = h.sandbox.callEntry(entry);
  if (!call.ok) return { error: call.error };
  for (let i = 0; i < rounds; i++) {
    h.sandbox.armDeadline(h.clock.ms + 1_000_000);
    const jobs = h.sandbox.drainJobs();
    if (jobs.error) return { error: jobs.error };
    if (jobs.hasPending) continue;
    const state = h.sandbox.drivenState();
    if (state !== 'pending') return state;
    if (!h.host.runNext()) return 'stalled';
  }
  return 'rounds';
}

/** Wrap `body` so its result (or the error it throws) comes back as one JSON serial line. */
function probeProgram(body: string): string {
  return `import {
  Wire, Serial, gpio, board, sleep, sleepUs, micros, millis,
  LOW, HIGH, INPUT, OUTPUT, INPUT_PULLUP,
  I2C_OK, I2C_NACK_ADDRESS, I2C_NACK_DATA, I2C_ERR_BUS, I2C_COLLISION
} from '@bbs/runtime';
export async function loop() {
  try {
    const out = await (async () => { ${body} })();
    Serial.println(JSON.stringify({ ok: true, out }));
  } catch (e) {
    Serial.println(JSON.stringify({ ok: false, name: e.name, message: String(e.message) }));
  }
}
`;
}

function probe(body: string, host = new FakeHost()): { result: Record<string, unknown>; host: FakeHost } {
  const h = build(compiled(probeProgram(body)).code, { host });
  try {
    expect(h.sandbox.loadProgram().ok).toBe(true);
    const outcome = drive(h, 'loop');
    expect(outcome, JSON.stringify(outcome)).toBe('fulfilled');
    const lines = host.lines();
    expect(lines).toHaveLength(1);
    return { result: JSON.parse(lines[0]!) as Record<string, unknown>, host };
  } finally {
    h.sandbox.dispose();
  }
}

// ---------------------------------------------------------------------------
// Plan §6.8 — the five determinism / isolation proofs
// ---------------------------------------------------------------------------

describe('§6.8 (a) forbidden globals', () => {
  it('leaves all 17 names undefined while ordinary code still runs', () => {
    expect([...SANDBOX_FORBIDDEN_GLOBALS]).toEqual([
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'setTimeout',
      'setInterval',
      'queueMicrotask',
      'performance',
      'Date',
      'console',
      'postMessage',
      'crypto',
      'WebAssembly',
      'importScripts',
      'require',
      'process',
      'eval',
      'Function'
    ]);
    expect(SANDBOX_FORBIDDEN_GLOBALS).toHaveLength(17);

    const h = build('export const ready = 1;');
    try {
      const names = JSON.stringify([...SANDBOX_FORBIDDEN_GLOBALS]);
      const seen = h.sandbox.evaluateGlobal(`JSON.stringify(${names}.map((n) => typeof globalThis[n]))`);
      expect(seen.ok).toBe(true);
      if (!seen.ok) return;
      expect(JSON.parse(seen.value as string)).toEqual(SANDBOX_FORBIDDEN_GLOBALS.map(() => 'undefined'));

      // Eval stayed on: turning the intrinsic off breaks every evalCode call.
      const arithmetic = h.sandbox.evaluateGlobal('1 + 1');
      expect(arithmetic.ok && arithmetic.value).toBe(2);
    } finally {
      h.sandbox.dispose();
    }
  });
});

describe('§6.8 (b) function constructors', () => {
  it('makes all five code-generating paths throw TypeError', () => {
    const paths = [
      "(function(){}).constructor('return 1')",
      "(async function(){}).constructor('return 1')",
      "(function*(){}).constructor('return 1')",
      "(async function*(){}).constructor('return 1')",
      "Reflect.construct(Object.getPrototypeOf(function(){}).constructor, ['return 1'])"
    ];
    const h = build('export const ready = 1;');
    try {
      for (const path of paths) {
        const probed = h.sandbox.evaluateGlobal(
          `(() => { try { ${path}; return 'NO THROW'; } catch (e) { return e.name; } })()`
        );
        expect(probed.ok, path).toBe(true);
        if (!probed.ok) continue;
        expect(probed.value, path).toBe('TypeError');
      }
    } finally {
      h.sandbox.dispose();
    }
  });
});

describe('§6.8 (c) module whitelist', () => {
  it('refuses all five illegal specifiers at the module loader', () => {
    const specifiers = [
      'node:fs',
      './x.js',
      'https://evil.example/x.js',
      'data:text/javascript,export default 1',
      '@bbs/devices/nope'
    ];
    for (const specifier of specifiers) {
      const h = build(`import x from ${JSON.stringify(specifier)};\nexport const y = x;\n`);
      try {
        const loaded = h.sandbox.loadProgram();
        expect(loaded.ok, specifier).toBe(false);
        if (loaded.ok) continue;
        expect(loaded.error.message ?? '', specifier).toContain('模块不可用');
      } finally {
        h.sandbox.dispose();
      }
    }
  });

  it('admits exactly the two guest modules', () => {
    expect(Object.keys(GUEST_MODULES).sort()).toEqual(['@bbs/devices/ssd1306', '@bbs/runtime']);
    const h = build(
      compiled(
        ["import { gpio } from '@bbs/runtime';", "import { SSD1306 } from '@bbs/devices/ssd1306';", 'export const ok = !!gpio && !!SSD1306;'].join('\n')
      ).code
    );
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
    } finally {
      h.sandbox.dispose();
    }
  });
});

describe('§6.8 (d) seeded Math.random', () => {
  it('gives two sandboxes with the same seed the same sequence, and a different seed a different one', () => {
    const sequence = (seed: number): string => {
      const h = build('export const ready = 1;', { seed });
      try {
        const out = h.sandbox.evaluateGlobal('JSON.stringify(Array.from({ length: 8 }, () => Math.random()))');
        expect(out.ok).toBe(true);
        return out.ok ? (out.value as string) : '';
      } finally {
        h.sandbox.dispose();
      }
    };
    const first = sequence(12345);
    const second = sequence(12345);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toHaveLength(8);
    expect(sequence(12346)).not.toBe(first);
  });
});

describe('§6.8 (e) Math.random is locked', () => {
  it('cannot be reassigned or redefined', () => {
    const h = build('export const ready = 1;');
    try {
      const descriptor = h.sandbox.evaluateGlobal(
        "JSON.stringify(Object.getOwnPropertyDescriptor(Math, 'random'), (k, v) => (typeof v === 'function' ? 'fn' : v))"
      );
      expect(descriptor.ok && JSON.parse(descriptor.value as string)).toEqual({
        value: 'fn',
        writable: false,
        enumerable: false,
        configurable: false
      });

      // Sloppy mode silently ignores the write; the generator must be unchanged.
      const sloppy = h.sandbox.evaluateGlobal(
        "(function () { Math.random = function () { return 0.5; }; return Math.random() === 0.5; })()"
      );
      expect(sloppy.ok && sloppy.value).toBe(false);

      const strict = h.sandbox.evaluateGlobal(
        "(function () { 'use strict'; try { Math.random = function () { return 0.5; }; return 'NO THROW'; } catch (e) { return e.name; } })()"
      );
      expect(strict.ok && strict.value).toBe('TypeError');

      const redefine = h.sandbox.evaluateGlobal(
        "(function () { try { Object.defineProperty(Math, 'random', { value: function () { return 0.5; } }); return 'NO THROW'; } catch (e) { return e.name; } })()"
      );
      expect(redefine.ok && redefine.value).toBe('TypeError');
    } finally {
      h.sandbox.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Construction, teardown and interrupts
// ---------------------------------------------------------------------------

describe('sandbox construction', () => {
  it('S1 uses exactly DefaultIntrinsics with Date off, and the measured stack size', () => {
    expect({ ...SANDBOX_INTRINSICS }).toEqual({ ...DefaultIntrinsics, Date: false });
    expect(SANDBOX_INTRINSICS.Eval).toBe(true);
    expect(SANDBOX_MAX_STACK_BYTES).toBe(64 * 1024);
  });

  it('S2 turns deep recursion into a catchable guest error instead of killing the VM', () => {
    const h = build(
      ['export function loop() {', '  const down = (n) => (n <= 0 ? 0 : down(n - 1) + 1);', '  return down(1000000);', '}'].join('\n')
    );
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      h.sandbox.armDeadline(h.clock.ms + 1_000_000);
      const call = h.sandbox.callEntry('loop');
      expect(call.ok).toBe(false);
      if (call.ok) return;
      expect(call.error.message ?? '').toContain('stack overflow');
      // The wasm instance is still usable afterwards.
      expect(h.sandbox.evaluateGlobal('1 + 1').ok).toBe(true);
    } finally {
      h.sandbox.dispose();
    }
  });
});

describe('teardown', () => {
  it('S3 reclaims pending deferreds so dispose never aborts the wasm instance', () => {
    const h = build(compiled(["import { sleep } from '@bbs/runtime';", 'export async function loop() {', '  await sleep(500);', '}'].join('\n')).code);
    expect(h.sandbox.loadProgram().ok).toBe(true);
    expect(h.sandbox.callEntry('loop').ok).toBe(true);
    h.sandbox.armDeadline(h.clock.ms + 1_000_000);
    h.sandbox.drainJobs();
    expect(h.sandbox.drivenState()).toBe('pending');
    expect(h.host.sleeps).toEqual([500_000]);

    expect(() => h.sandbox.dispose()).not.toThrow();
    expect(() => h.sandbox.dispose()).not.toThrow();

    // If the runtime had aborted, every later sandbox on this module would die.
    const after = build('export const ready = 1;');
    try {
      expect(after.sandbox.evaluateGlobal('1 + 1').ok).toBe(true);
    } finally {
      after.sandbox.dispose();
    }
  });

  it('S4 survives a guest that suspends again while being torn down', () => {
    const source = [
      "import { sleep } from '@bbs/runtime';",
      'export async function loop() {',
      '  try {',
      '    await sleep(500);',
      '  } catch (e) {',
      '    await sleep(500);',
      '  }',
      '}'
    ].join('\n');
    const h = build(compiled(source).code);
    expect(h.sandbox.loadProgram().ok).toBe(true);
    expect(h.sandbox.callEntry('loop').ok).toBe(true);
    h.sandbox.armDeadline(h.clock.ms + 1_000_000);
    h.sandbox.drainJobs();
    expect(h.sandbox.drivenState()).toBe('pending');

    expect(() => h.sandbox.dispose()).not.toThrow();

    const after = build('export const ready = 1;');
    try {
      expect(after.sandbox.evaluateGlobal('1 + 1').ok).toBe(true);
    } finally {
      after.sandbox.dispose();
    }
  });
});

describe('interrupt sampling (§6.7)', () => {
  const HOT_LOOP = [
    "import { gpio } from '@bbs/runtime';", // line 1
    'export function loop() {', // 2
    '  let n = 0;', // 3
    '  while (true) { n = (n + 1) % 1000; }', // 4
    '  return n;', // 5
    '}' // 6
  ].join('\n');

  it('S5 reports the hot line, not the function declaration', () => {
    const h = build(compiled(HOT_LOOP).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      h.clock.step = 1;
      h.sandbox.armDeadline(h.clock.ms + 20);
      const call = h.sandbox.callEntry('loop');

      expect(call.ok).toBe(false);
      expect(h.sandbox.takeTripped()).toBe('time_slice');
      expect(h.sandbox.takeTripped()).toBe(null);

      const sampled = h.sandbox.trippedSource();
      expect(sampled?.programId).toBe('program_main');
      expect(sampled?.line).toBe(4);
      expect(sampled?.column).toBeGreaterThan(0);
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S6 cannot be swallowed by a guest try/catch, and the host flag is the authority', () => {
    const source = [
      "import { Serial } from '@bbs/runtime';", // 1
      'export function loop() {', // 2
      '  try {', // 3
      '    let n = 0;', // 4
      '    while (true) { n = (n + 1) % 1000; }', // 5
      '  } catch (e) {', // 6
      "    Serial.println('swallowed');", // 7
      "    return 'swallowed';", // 8
      '  }', // 9
      '}' // 10
    ].join('\n');
    const h = build(compiled(source).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      h.clock.step = 1;
      h.sandbox.armDeadline(h.clock.ms + 20);
      const call = h.sandbox.callEntry('loop');

      // The interrupt flag stays raised, so the catch block is interrupted too:
      // the guest never gets to report success.
      expect(call.ok).toBe(false);
      expect(h.host.lines()).toEqual([]);
      expect(h.sandbox.takeTripped()).toBe('time_slice');
      // Still located inside the user's program. The exact line is not pinned
      // here: when the hot loop sits inside a try block QuickJS attributes the
      // sampled frame to the catch clause rather than to the loop (measured),
      // so only the try-free case in S5 can assert an exact hot line.
      expect(h.sandbox.trippedSource()?.programId).toBe('program_main');
      expect(h.sandbox.trippedSource()?.line).toBeGreaterThan(0);
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S7 does not fire before the deadline, and re-arming clears the flag', () => {
    const h = build(compiled(['export function loop() {', '  let n = 0;', '  for (let i = 0; i < 200000; i++) n += i;', '  return n;', '}'].join('\n')).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      h.clock.step = 1;
      h.sandbox.armDeadline(h.clock.ms + 10_000_000);
      expect(h.sandbox.callEntry('loop').ok).toBe(true);
      expect(h.sandbox.takeTripped()).toBe(null);
    } finally {
      h.sandbox.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Host bridge argument limits (plan §6.6)
// ---------------------------------------------------------------------------

describe('§6.6 host bridge limits', () => {
  it('S8 refuses an out-of-range I²C address with I2C_NACK_ADDRESS and never touches the bus', () => {
    for (const address of [-1, 0x80, 1.5, Number.NaN]) {
      const { result, host } = probe(`return await Wire.write(${Number.isNaN(address) ? 'NaN' : address}, [1, 2]);`);
      expect(result.ok, `address ${address}`).toBe(true);
      expect(result.out, `address ${address}`).toBe(I2C_STATUS.NACK_ADDRESS);
      expect(host.i2cWrites, `address ${address}`).toHaveLength(0);
      expect(host.diagnostics.map((d) => d.code)).toContain('i2c_nack');
    }
  });

  it('S9 accepts the boundary addresses 0x00 and 0x7F', () => {
    for (const address of [0x00, 0x7f]) {
      const { result, host } = probe(`return await Wire.write(${address}, [1]);`);
      expect(result.ok).toBe(true);
      expect(host.i2cWrites).toHaveLength(1);
      expect(host.i2cWrites[0]?.address).toBe(address);
    }
  });

  it('S10 caps Wire.read length at 4096 with I2C_ERR_BUS + i2c_bus_unavailable', () => {
    const tooBig = probe(`const b = await Wire.read(0x3c, ${HOST_LIMITS.i2cReadLength + 1}); return [Wire.lastStatus, b.length];`);
    expect(tooBig.result.out).toEqual([I2C_STATUS.ERR_BUS, 0]);
    expect(tooBig.host.i2cReads).toHaveLength(0);
    const raised = tooBig.host.diagnostics.filter((d) => d.code === 'i2c_bus_unavailable');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe('warning');

    const huge = probe('const b = await Wire.read(0x3c, 2 ** 30); return [Wire.lastStatus, b.length];');
    expect(huge.result.out).toEqual([I2C_STATUS.ERR_BUS, 0]);
    expect(huge.host.i2cReads).toHaveLength(0);

    const atLimit = probe(`const b = await Wire.read(0x3c, ${HOST_LIMITS.i2cReadLength}); return [Wire.lastStatus, b.length];`);
    expect(atLimit.host.i2cReads).toEqual([{ address: 0x3c, length: HOST_LIMITS.i2cReadLength }]);
    expect(atLimit.result.out).toEqual([I2C_STATUS.OK, 3]);
  });

  it('S11 caps a Wire.write payload at 131072 hex characters', () => {
    const overLimit = HOST_LIMITS.i2cWriteHexChars / 2 + 1;
    const over = probe(`return await Wire.write(0x3c, new Uint8Array(${overLimit}));`);
    expect(over.result.out).toBe(I2C_STATUS.ERR_BUS);
    expect(over.host.i2cWrites).toHaveLength(0);
    expect(over.host.diagnostics.filter((d) => d.code === 'i2c_bus_unavailable')).toHaveLength(1);

    const atLimit = HOST_LIMITS.i2cWriteHexChars / 2;
    const ok = probe(`return await Wire.write(0x3c, new Uint8Array(${atLimit}));`);
    expect(ok.result.out).toBe(I2C_STATUS.OK);
    expect(ok.host.i2cWrites[0]?.bytes.length).toBe(atLimit);
  });

  it('S12 throws into the guest for a delay that is not a non-negative safe integer', () => {
    for (const expression of ['sleepUs(-1)', 'sleepUs(1.5)', 'sleepUs(NaN)', 'sleepUs(Number.MAX_SAFE_INTEGER + 2)', "sleepUs('x')"]) {
      const { result, host } = probe(`return await ${expression};`);
      expect(result.ok, expression).toBe(false);
      expect(String(result.message), expression).toContain('非法的延时');
      expect(host.sleeps, expression).toHaveLength(0);
    }
    const ok = probe('return await sleepUs(0);');
    expect(ok.result.ok).toBe(true);
    expect(ok.host.sleeps).toEqual([0]);
  });

  it('S13 throws into the guest for a pin the component does not have', () => {
    for (const expression of ['gpio.pinMode(99, 1)', 'gpio.digitalWrite(99, 1)', 'gpio.digitalRead(99)']) {
      const { result } = probe(`return ${expression};`);
      expect(result.ok, expression).toBe(false);
      expect(String(result.message), expression).toContain('不属于本器件');
    }
    const ok = probe('gpio.pinMode(4, 0); return gpio.digitalRead(4);');
    expect(ok.result.out).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Guest API surface (plan §6.3)
// ---------------------------------------------------------------------------

describe('@bbs/runtime surface (§6.3)', () => {
  it('S14 exports every documented name and nothing else', () => {
    const printer = build(
      compiled(
        [
          "import * as rt from '@bbs/runtime';",
          "import { Serial } from '@bbs/runtime';",
          'export function loop() { Serial.println(JSON.stringify(Object.keys(rt).sort())); }'
        ].join('\n')
      ).code
    );
    try {
      expect(printer.sandbox.loadProgram().ok).toBe(true);
      expect(drive(printer, 'loop')).toBe('fulfilled');
      expect(JSON.parse(printer.host.lines()[0]!)).toEqual(
        [
          'HIGH',
          'I2C_COLLISION',
          'I2C_ERR_BUS',
          'I2C_NACK_ADDRESS',
          'I2C_NACK_DATA',
          'I2C_OK',
          'INPUT',
          'INPUT_PULLUP',
          'LOW',
          'OUTPUT',
          'Serial',
          'Wire',
          'board',
          'gpio',
          'micros',
          'millis',
          'sleep',
          'sleepUs'
        ].sort()
      );
    } finally {
      printer.sandbox.dispose();
    }
  });

  it('S15 pins the documented constant values and the method names of each object', () => {
    const { result } = probe(
      [
        'return {',
        '  levels: [LOW, HIGH],',
        '  modes: [INPUT, OUTPUT, INPUT_PULLUP],',
        '  status: [I2C_OK, I2C_NACK_ADDRESS, I2C_NACK_DATA, I2C_ERR_BUS, I2C_COLLISION],',
        '  gpio: Object.keys(gpio).sort(),',
        '  serial: Object.keys(Serial).sort(),',
        '  wire: Object.keys(Wire).sort(),',
        '  board: Object.keys(board).sort()',
        '};'
      ].join('\n')
    );
    expect(result.out).toEqual({
      levels: [0, 1],
      modes: [0, 1, 2],
      status: [0, 2, 3, 4, 5],
      gpio: ['digitalRead', 'digitalReadRaw', 'digitalWrite', 'pinMode'],
      serial: ['begin', 'print', 'println', 'write'],
      wire: ['begin', 'end', 'lastStatus', 'probe', 'read', 'scan', 'setClock', 'write', 'writeRead'],
      board: ['model', 'rgb']
    });
  });

  it('S16 makes Wire.begin synchronous and reports its status', () => {
    const { result, host } = probe('const st = Wire.begin({ sda: 8, scl: 9 }); return [st, Wire.lastStatus, st === I2C_OK];');
    expect(result.out).toEqual([I2C_STATUS.OK, I2C_STATUS.OK, true]);
    expect(host.beginCalls).toEqual([{ sda: 8, scl: 9 }]);
  });

  it('S17 returns a zero-length array from a failed Wire.read', () => {
    const { result } = probe('const b = await Wire.read(0x3d, 4); return [Wire.lastStatus, b.length, Array.from(b)];');
    expect(result.out).toEqual([I2C_STATUS.NACK_ADDRESS, 0, []]);
  });

  it('S18 round-trips bytes through Wire.writeRead, probe and scan', () => {
    const { result, host } = probe('const b = await Wire.writeRead(0x3c, [0x10], 3); return Array.from(b);');
    expect(result.out).toEqual([0xa1, 0xb2, 0xc3]);
    expect(host.i2cWrites[0]?.bytes).toEqual(new Uint8Array([0x10]));

    const scanned = probe('return [await Wire.probe(0x3c), await Wire.probe(0x3d), await Wire.scan()];');
    expect(scanned.result.out).toEqual([true, false, [0x3c]]);
  });

  it('S19 exposes the virtual clock through micros/millis and never a Date', () => {
    const host = new FakeHost();
    host.nowUsValue = 4_500_000;
    const { result } = probe('return [micros(), millis(), typeof globalThis.Date];', host);
    expect(result.out).toEqual([4_500_000, 4500, 'undefined']);
  });

  it('S20 reports raw digital values and maps Z/X to 0', () => {
    const host = new FakeHost();
    host.pinValues.set(4, 'Z');
    const { result } = probe('return [gpio.digitalRead(4), gpio.digitalReadRaw(4)];', host);
    expect(result.out).toEqual([0, 'Z']);

    const host2 = new FakeHost();
    host2.pinValues.set(4, 1);
    expect(probe('return [gpio.digitalRead(4), gpio.digitalReadRaw(4)];', host2).result.out).toEqual([1, 1]);
  });

  it('S21 hands Serial text to the host raw, without assembling lines', () => {
    const source = [
      "import { Serial } from '@bbs/runtime';",
      'export function loop() {',
      '  Serial.begin(115200);',
      "  Serial.print('a=');",
      '  Serial.print(2);',
      "  Serial.println(' done');",
      "  Serial.write('tail');",
      '}'
    ].join('\n');
    const h = build(compiled(source).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      expect(drive(h, 'loop')).toBe('fulfilled');
      expect(h.host.serialBauds).toEqual([115200]);
      // Four separate host calls; only `println` contributed the newline, and
      // the unterminated tail is left for the host to flush.
      expect(h.host.serialText).toBe('a=2 done\ntail');
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S22 drives the on-board RGB and reports the board model', () => {
    const host = new FakeHost();
    const { result } = probe("board.rgb(10, 20, 30); return board.model;", host);
    expect(result.out).toBe('esp32s3_n16r8_dual_usb');
    expect(host.rgbCalls).toEqual([[10, 20, 30]]);
  });
});

// ---------------------------------------------------------------------------
// Guest SSD1306 client (plan §6.4)
// ---------------------------------------------------------------------------

describe('@bbs/devices/ssd1306 (§6.4)', () => {
  const SOURCE = [
    "import { Serial, Wire } from '@bbs/runtime';",
    "import { SSD1306 } from '@bbs/devices/ssd1306';",
    'const oled = new SSD1306(Wire, 0x3c, 128, 64);',
    'export async function setup() {',
    '  const started = await oled.begin();',
    '  oled.clear();',
    "  oled.setColor('white');",
    "  oled.text(8, 24, 'Touched');",
    '  const shown = await oled.show();',
    '  Serial.println(JSON.stringify({ started, shown }));',
    '}'
  ].join('\n');

  it('S23 pushes every framebuffer byte out over Wire.write', () => {
    const h = build(compiled(SOURCE).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      expect(drive(h, 'setup')).toBe('fulfilled');
      expect(JSON.parse(h.host.lines()[0]!)).toEqual({ started: true, shown: true });

      // 1 init + 1 addressing window + 8 pages of 128 data bytes.
      expect(h.host.i2cWrites).toHaveLength(10);
      const data = h.host.i2cWrites.filter((w) => w.bytes[0] === 0x40);
      expect(data).toHaveLength(8);
      expect(data.every((w) => w.bytes.length === 129)).toBe(true);
      const gddram = data.reduce((sum, w) => sum + w.bytes.length - 1, 0);
      expect(gddram).toBe((128 * 64) / 8);

      const onPixels = data.reduce(
        (sum, w) => sum + [...w.bytes.subarray(1)].reduce((bits, byte) => bits + byte.toString(2).replace(/0/g, '').length, 0),
        0
      );
      expect(onPixels).toBeGreaterThan(0);
      expect(h.host.i2cWrites.every((w) => w.address === 0x3c)).toBe(true);
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S24 marks itself unusable when begin() is not acknowledged and then skips show()', () => {
    const host = new FakeHost();
    host.ackAddresses.clear();
    const h = build(compiled(SOURCE).code, { host });
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      expect(drive(h, 'setup')).toBe('fulfilled');
      expect(JSON.parse(host.lines()[0]!)).toEqual({ started: false, shown: false });
      // Exactly the one refused init transaction: no frame was ever pushed.
      expect(host.i2cWrites).toHaveLength(1);
      expect(host.i2cWrites[0]?.bytes[0]).toBe(0x00);
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S25 covers ASCII 0x20-0x7E with a 475-byte font and falls back for the rest', () => {
    const source = [
      "import { Serial, Wire } from '@bbs/runtime';",
      "import { SSD1306 } from '@bbs/devices/ssd1306';",
      'const oled = new SSD1306(Wire, 0x3c, 128, 64);',
      'export async function setup() {',
      '  await oled.begin();',
      '  const counts = [];',
      '  for (let code = 0x20; code <= 0x7e; code++) {',
      '    oled.clear();',
      '    oled.text(0, 0, String.fromCharCode(code));',
      '    counts.push(oled.buffer.reduce((n, b) => n + (b ? 1 : 0), 0));',
      '  }',
      '  oled.clear();',
      "  oled.text(0, 0, '\\u4e2d');",
      '  const fallback = oled.buffer.reduce((n, b) => n + (b ? 1 : 0), 0);',
      '  Serial.println(JSON.stringify({ glyphs: counts.length, blank: counts.filter((n) => n === 0).length, fallback }));',
      '}'
    ].join('\n');
    const h = build(compiled(source).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      expect(drive(h, 'setup')).toBe('fulfilled');
      const out = JSON.parse(h.host.lines()[0]!) as { glyphs: number; blank: number; fallback: number };
      expect(out.glyphs).toBe(95);
      // Only the space glyph is empty.
      expect(out.blank).toBe(1);
      // An unmapped code point still draws something (the '?' fallback).
      expect(out.fallback).toBeGreaterThan(0);
    } finally {
      h.sandbox.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// GuestBridge protocol
// ---------------------------------------------------------------------------

describe('GuestBridge', () => {
  it('S26 suspends on sleep and resumes only when the host completes it', () => {
    const source = [
      "import { Serial, sleep, micros } from '@bbs/runtime';",
      'export async function loop() {',
      "  Serial.println('a' + micros());",
      '  await sleep(500);',
      "  Serial.println('b' + micros());",
      '}'
    ].join('\n');
    const h = build(compiled(source).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      expect(h.sandbox.callEntry('loop').ok).toBe(true);
      h.sandbox.armDeadline(h.clock.ms + 1_000_000);
      expect(h.sandbox.drainJobs()).toEqual({ hasPending: false });
      expect(h.sandbox.drivenState()).toBe('pending');
      expect(h.host.lines()).toEqual(['a0']);

      expect(h.host.runNext()).toBe(true);
      h.sandbox.armDeadline(h.clock.ms + 1_000_000);
      h.sandbox.drainJobs();
      expect(h.sandbox.drivenState()).toBe('fulfilled');
      expect(h.host.lines()).toEqual(['a0', 'b500000']);
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S27 reports a guest throw as a rejected driven promise with a usable location', () => {
    const source = [
      "import { sleep } from '@bbs/runtime';", // 1
      'export async function loop() {', // 2
      '  await sleep(1);', // 3
      '  const o = null;', // 4
      '  return o.x;', // 5
      '}' // 6
    ].join('\n');
    const h = build(compiled(source).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      const outcome = drive(h, 'loop');
      expect(typeof outcome === 'object' && outcome !== null && 'error' in outcome).toBe(true);
      const error = (outcome as { error: { name?: string; stack?: string } }).error;
      expect(error.name).toBe('TypeError');
      expect(h.sandbox.locate(error)).toEqual({ programId: 'program_main', line: 5, column: 11 });
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S28 surfaces a syntax error from evalCode with its structured location', () => {
    const h = build('export const a = ;\nconst b = 2;\n');
    try {
      const loaded = h.sandbox.loadProgram();
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.error.name).toBe('SyntaxError');
      expect(h.sandbox.locate(loaded.error)).toEqual({ programId: 'program_main', line: 1, column: 18 });
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S29 reports missing entry points instead of pretending they ran', () => {
    const h = build('export const a = 1;');
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      expect(h.sandbox.hasEntry('setup')).toBe(false);
      expect(h.sandbox.hasEntry('a')).toBe(false);
      const call = h.sandbox.callEntry('setup');
      expect(call.ok).toBe(false);
      if (call.ok) return;
      expect(call.error.message).toContain('setup');
    } finally {
      h.sandbox.dispose();
    }
  });

  it('S30 runs setup once and loop repeatedly against the same module instance', () => {
    const source = [
      "import { Serial, sleep } from '@bbs/runtime';",
      'let n = 0;',
      'export async function setup() { Serial.println("setup"); }',
      'export async function loop() { n++; await sleep(1); Serial.println("loop" + n); }'
    ].join('\n');
    const h = build(compiled(source).code);
    try {
      expect(h.sandbox.loadProgram().ok).toBe(true);
      expect(h.sandbox.hasEntry('setup')).toBe(true);
      expect(drive(h, 'setup')).toBe('fulfilled');
      expect(drive(h, 'loop')).toBe('fulfilled');
      expect(drive(h, 'loop')).toBe('fulfilled');
      expect(h.host.lines()).toEqual(['setup', 'loop1', 'loop2']);
    } finally {
      h.sandbox.dispose();
    }
  });
});
