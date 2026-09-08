/**
 * The Studio TS sandbox: one QuickJS runtime per program (plan §6.1–§6.7).
 *
 * `StudioTsSandbox` implements `GuestBridge` and nothing else (plan §1.4). It
 * never owns the execution budget, never advances virtual time and never
 * decides a session is deadlocked — that is `SimLoop`'s job. What lives here is
 * the VM itself: construction order, the hardening prelude, the `__bbs*` host
 * bridge, interrupt sampling and teardown.
 *
 * The QuickJS module and the host handlers are both constructor parameters, so
 * this file imports nothing at runtime: `quickjs-emscripten-core` appears only
 * as a type. That is what keeps `packages/sim` free of a wasm dependency and
 * lets the Node integration test build a sandbox of its own (plan §1.3).
 */
import type {
  Intrinsics,
  JSModuleLoadResult,
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule
} from 'quickjs-emscripten-core';
import type { GuestBridge, WallClock } from '../contracts.js';
import { SIM_DIAGNOSTIC_SEVERITY, type DigitalValue, type SimDiagnostic, type SimSourceLocation } from '../types.js';
import type { CompiledProgram } from './compile.js';
import { GUEST_MODULES, I2C_STATUS, type I2cStatusCode } from './guest-modules.js';
import { firstFrameIn, locationFromGuestError, type GuestErrorShape } from './diagnostics.js';
import { preludeSource } from './prelude.js';

// ---------------------------------------------------------------------------
// Fixed sandbox parameters (plan §6.1, §2.4)
// ---------------------------------------------------------------------------

/**
 * 64 KB, measured, not guessed: 8–128 KB turns deep recursion into a catchable
 * `InternalError: stack overflow`, while 256 KB and the default kill the whole
 * wasm instance with a host `RangeError`.
 */
export const SANDBOX_MAX_STACK_BYTES = 64 * 1024;
export const SANDBOX_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * `{ ...DefaultIntrinsics, Date: false }`, spelled out so the product code does
 * not have to import a value from `quickjs-emscripten-core`. `studio-ts.test.ts`
 * asserts the two stay equal.
 *
 * `Eval` must stay `true`: with the intrinsic off even `ctx.evalCode('1 + 1')`
 * fails. `eval` and `Function` are removed by the prelude instead.
 */
export const SANDBOX_INTRINSICS: Intrinsics = Object.freeze({
  BaseObjects: true,
  Date: false,
  Eval: true,
  StringNormalize: true,
  RegExp: true,
  JSON: true,
  Proxy: true,
  MapSet: true,
  TypedArrays: true,
  Promise: true
});

/**
 * Host-side argument ceilings (plan §6.6). The VM's own 32 MB limit does not
 * cover the worker heap, so `await Wire.read(0x3c, 2 ** 30)` must be refused
 * *before* anything is allocated on our side.
 */
export const HOST_LIMITS = Object.freeze({
  /** Inclusive 7-bit I²C address range. */
  i2cAddressMin: 0x00,
  i2cAddressMax: 0x7f,
  /** Maximum bytes one `Wire.read` may ask for. */
  i2cReadLength: 4096,
  /** Maximum hex characters one `Wire.write` payload may carry (65,536 bytes). */
  i2cWriteHexChars: 131072
});

// ---------------------------------------------------------------------------
// Host seam
// ---------------------------------------------------------------------------

export interface I2cBeginOptions {
  sda?: number;
  scl?: number;
  frequency?: number;
  bus?: number;
}

export interface I2cReadResult {
  status: I2cStatusCode;
  bytes: Uint8Array;
}

/**
 * Everything the sandbox needs from the rest of the simulator.
 *
 * The asynchronous entries take a completion callback rather than returning a
 * host `Promise` on purpose: the pump is synchronous, so a host microtask would
 * not run until after `runSlice()` had already returned. The kernel calls
 * `done` from inside the scheduler event that completes the operation, which is
 * also what keeps replay deterministic.
 */
export interface SandboxHost {
  /** Virtual time in microseconds. */
  nowUs(): number;
  /** False for a pin the target component does not expose; the guest gets a TypeError. */
  hasPin(pin: number): boolean;
  pinMode(pin: number, mode: number): void;
  digitalWrite(pin: number, value: 0 | 1): void;
  digitalRead(pin: number): DigitalValue;
  serialBegin(baud: number): void;
  /** Raw text, not lines: line assembly (and the trailing flush) belongs to the host. */
  serialWrite(text: string): void;
  /** Reported by `board.model`. */
  boardModel(): string;
  rgb(r: number, g: number, b: number): void;
  /** Suspend the guest for `delayUs` of virtual time. */
  sleep(delayUs: number, done: () => void): void;
  /** Synchronous: `Wire.begin` only resolves the bus statically (plan §6.3). */
  i2cBegin(options: I2cBeginOptions): I2cStatusCode;
  i2cEnd(): void;
  i2cSetClock(hz: number): void;
  i2cWrite(address: number, bytes: Uint8Array, done: (status: I2cStatusCode) => void): void;
  i2cRead(address: number, length: number, done: (result: I2cReadResult) => void): void;
  i2cWriteRead(address: number, bytes: Uint8Array, readLength: number, done: (result: I2cReadResult) => void): void;
  diagnose(diagnostic: SimDiagnostic): void;
}

export interface StudioTsSandboxOptions {
  /** Already built with `newQuickJSWASMModuleFromVariant`. */
  quickjs: QuickJSWASMModule;
  program: CompiledProgram;
  host: SandboxHost;
  clock: WallClock;
  /** `SimulationConfig.random_seed`; identical seeds give identical sequences. */
  seed?: number;
  /** Overridable only so tests can shrink the guest surface; defaults to `GUEST_MODULES`. */
  modules?: Readonly<Record<string, string>>;
}

export type SandboxResult<T> = { ok: true; value: T } | { ok: false; error: GuestErrorShape };

// ---------------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdef';

function decodeHex(hex: string): Uint8Array {
  const length = hex.length >> 1;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) & 0xff;
  return bytes;
}

function encodeHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]! & 0xff;
    out += HEX_DIGITS[b >> 4]! + HEX_DIGITS[b & 0x0f]!;
  }
  return out;
}

export class StudioTsSandbox implements GuestBridge {
  private readonly rt: QuickJSRuntime;
  private readonly ctx: QuickJSContext;
  private readonly host: SandboxHost;
  private readonly clock: WallClock;
  private readonly modules: Readonly<Record<string, string>>;
  private readonly program: CompiledProgram;

  /**
   * Every deferred handed to the guest that has not settled yet. Disposing the
   * runtime while one of these is alive aborts the wasm instance with
   * `Aborted(Assertion failed: list_empty(&rt->gc_obj_list) …)`, so teardown
   * drains this set first (plan §6.1).
   */
  private readonly live = new Set<QuickJSDeferredPromise>();

  private namespace: QuickJSHandle | undefined;
  private driven: QuickJSHandle | undefined;

  private deadlineMs = Number.POSITIVE_INFINITY;
  private tripped = false;
  private trippedAt: SimSourceLocation | undefined;
  /** Set while the host itself is inside the VM; the interrupt must not fire then. */
  private suspendInterrupt = false;
  private ctxReady = false;
  private disposed = false;

  constructor(options: StudioTsSandboxOptions) {
    this.host = options.host;
    this.clock = options.clock;
    this.program = options.program;
    this.modules = options.modules ?? GUEST_MODULES;

    // Construction order is fixed by plan §6.1 and must not be rearranged.
    const rt = options.quickjs.newRuntime();
    this.rt = rt;
    rt.setMaxStackSize(SANDBOX_MAX_STACK_BYTES);
    rt.setMemoryLimit(SANDBOX_MEMORY_LIMIT_BYTES);
    rt.setInterruptHandler(() => this.checkBudget());
    rt.setModuleLoader((name) => this.loadModule(name));
    this.ctx = rt.newContext({ intrinsics: SANDBOX_INTRINSICS });
    this.ctxReady = true;

    const prelude = this.ctx.evalCode(preludeSource(options.seed ?? 0), '<bbs:prelude>', { type: 'global' });
    if (prelude.error) {
      const failure = this.readError(prelude.error);
      prelude.error.dispose();
      this.ctx.dispose();
      rt.dispose();
      throw new Error(`沙箱 prelude 失败：${failure.name ?? 'Error'}: ${failure.message ?? ''}`);
    }
    prelude.value.dispose();

    this.installBridge();
  }

  // -------------------------------------------------------------------------
  // Program lifecycle
  // -------------------------------------------------------------------------

  /** Evaluate the compiled module. Its exports become the entry points. */
  loadProgram(): SandboxResult<void> {
    const result = this.ctx.evalCode(this.program.code, this.program.filename, { type: 'module' });
    if (result.error) {
      const error = this.readError(result.error);
      result.error.dispose();
      return { ok: false, error };
    }
    this.namespace?.dispose();
    this.namespace = result.value;
    return { ok: true, value: undefined };
  }

  hasEntry(name: string): boolean {
    if (!this.namespace) return false;
    const handle = this.ctx.getProp(this.namespace, name);
    const isFunction = this.ctx.typeof(handle) === 'function';
    handle.dispose();
    return isFunction;
  }

  /**
   * Call one exported entry point (`setup` / `loop`) and make its result the
   * promise the pump drives. Returns as soon as the guest suspends.
   */
  callEntry(name: string): SandboxResult<void> {
    this.clearDriven();
    if (!this.namespace) {
      return { ok: false, error: { name: 'InternalError', message: '程序尚未载入' } };
    }
    const fn = this.ctx.getProp(this.namespace, name);
    if (this.ctx.typeof(fn) !== 'function') {
      fn.dispose();
      return { ok: false, error: { name: 'TypeError', message: `程序没有导出 ${name}()` } };
    }
    const result = this.ctx.callFunction(fn, this.ctx.undefined);
    fn.dispose();
    if (result.error) {
      const error = this.readError(result.error);
      result.error.dispose();
      return { ok: false, error };
    }
    this.driven = result.value;
    return { ok: true, value: undefined };
  }

  /** Map any guest error onto `{ programId, line, column }` (plan §6.7). */
  locate(error: GuestErrorShape | null | undefined): SimSourceLocation {
    return locationFromGuestError(error, this.program.filename);
  }

  // -------------------------------------------------------------------------
  // GuestBridge
  // -------------------------------------------------------------------------

  /**
   * Arming also clears the trip flag, so each slice starts clean. A runaway
   * program simply trips again on the next slice, whereas a flag carried over
   * would fault a healthy session — the self-correcting failure is the safer
   * one. Read the flag with `takeTripped()` before re-arming.
   */
  armDeadline(untilMs: number): void {
    this.deadlineMs = untilMs;
    this.tripped = false;
  }

  drainJobs(): { hasPending: boolean; error?: unknown } {
    const result = this.rt.executePendingJobs();
    if (result.error) {
      const error = this.readError(result.error);
      result.error.dispose();
      return { hasPending: this.rt.hasPendingJob(), error };
    }
    return { hasPending: this.rt.hasPendingJob() };
  }

  drivenState(): 'pending' | 'fulfilled' | { error: unknown } {
    if (!this.driven) return 'fulfilled';
    const state = this.ctx.getPromiseState(this.driven);
    if (state.type === 'pending') return 'pending';
    if (state.type === 'fulfilled') {
      // `notAPromise` hands back the very handle we passed in; disposing it here
      // would free `driven` out from under us.
      if (!state.notAPromise) state.value.dispose();
      return 'fulfilled';
    }
    const error = this.readError(state.error);
    state.error.dispose();
    return { error };
  }

  /**
   * The host's own flag, which is the only trustworthy one: guest code can
   * `.catch()` the `InternalError: interrupted` that QuickJS throws.
   */
  takeTripped(): 'time_slice' | null {
    if (!this.tripped) return null;
    this.tripped = false;
    return 'time_slice';
  }

  /**
   * Where the guest was when the slice ran out, sampled by the interrupt
   * handler itself — this points at the hot line, while the `InternalError`'s
   * own stack only points at the enclosing function declaration. Kept until the
   * next trip so the pump can read it after `takeTripped()`.
   *
   * `undefined` means the sample failed; the caller then falls back to
   * `locate(error)`, which ends at `(1, 1)`.
   */
  trippedSource(): SimSourceLocation | undefined {
    return this.trippedAt;
  }

  // -------------------------------------------------------------------------
  // Host-side inspection
  // -------------------------------------------------------------------------

  /**
   * Evaluate an expression as a global script and return its dumped value.
   * Host-only: the guest cannot reach this. Used by the interrupt sampler and
   * by the sandbox tests to inspect the guest environment.
   */
  evaluateGlobal(expression: string, filename = '<bbs:probe>'): SandboxResult<unknown> {
    const result = this.ctx.evalCode(expression, filename, { type: 'global' });
    if (result.error) {
      const error = this.readError(result.error);
      result.error.dispose();
      return { ok: false, error };
    }
    const value = this.dumpValue(result.value);
    result.value.dispose();
    return { ok: true, value };
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Reclaim every pending deferred before the runtime goes away. Leaving one
   * behind aborts the wasm instance, which takes the whole worker with it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.suspendInterrupt = true;
    try {
      // Rejecting resumes guest code, which may create more deferreds; the
      // bridge refuses new work once `disposed` is set, so this settles fast.
      for (let round = 0; round < 8 && this.live.size > 0; round++) {
        const pending = [...this.live];
        this.live.clear();
        for (const deferred of pending) {
          if (!deferred.alive) continue;
          const error = this.ctx.newError({ name: 'InternalError', message: '仿真会话已结束' });
          try {
            deferred.reject(error);
          } catch {
            // The VM may already be unwinding; disposing below is what matters.
          }
          error.dispose();
          deferred.dispose();
        }
        try {
          this.rt.executePendingJobs();
        } catch {
          // Rejection handlers are guest code and may throw; ignore on teardown.
        }
      }
      this.clearDriven();
      this.namespace?.dispose();
      this.namespace = undefined;
    } finally {
      this.ctxReady = false;
      this.ctx.dispose();
      this.rt.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private loadModule(name: string): JSModuleLoadResult {
    const source = Object.prototype.hasOwnProperty.call(this.modules, name) ? this.modules[name] : undefined;
    if (typeof source === 'string') return source;
    return { error: new Error(`模块不可用: ${name}`) };
  }

  /** Plan §6.7: never interrupt our own sampling, and sample exactly once per trip. */
  private checkBudget(): boolean {
    if (this.suspendInterrupt) return false;
    if (this.clock.nowMs() <= this.deadlineMs) return false;
    if (!this.tripped) {
      this.tripped = true;
      this.captureStack();
    }
    return true;
  }

  /**
   * A nested `new Error().stack` taken at the moment the budget ran out points
   * at the hot line; the `InternalError`'s own stack only points at the
   * enclosing function declaration.
   */
  private captureStack(): void {
    if (!this.ctxReady) return;
    this.suspendInterrupt = true;
    try {
      const result = this.ctx.evalCode('new Error().stack', '<bbs:probe>', { type: 'global' });
      if (result.error) {
        result.error.dispose();
        return;
      }
      const stack = this.ctx.typeof(result.value) === 'string' ? this.ctx.getString(result.value) : undefined;
      result.value.dispose();
      const frame = firstFrameIn(stack, this.program.filename);
      this.trippedAt = frame ? { programId: this.program.filename, ...frame } : undefined;
    } catch {
      this.trippedAt = undefined;
    } finally {
      this.suspendInterrupt = false;
    }
  }

  private clearDriven(): void {
    this.driven?.dispose();
    this.driven = undefined;
  }

  private dumpValue(handle: QuickJSHandle): unknown {
    const type = this.ctx.typeof(handle);
    if (type === 'string') return this.ctx.getString(handle);
    if (type === 'number') return this.ctx.getNumber(handle);
    if (type === 'undefined') return undefined;
    if (type === 'object' || type === 'function') {
      // `ctx.dump` consumes the handle when it is a real promise; report the
      // state instead so callers keep ownership.
      const state = this.ctx.getPromiseState(handle);
      if (state.type === 'pending') return { promise: 'pending' };
      if (state.type === 'rejected') {
        state.error.dispose();
        return { promise: 'rejected' };
      }
      if (!state.notAPromise) {
        state.value.dispose();
        return { promise: 'fulfilled' };
      }
    }
    return this.ctx.dump(handle);
  }

  /** Read a thrown handle into a plain object, including the props `dump` omits. */
  private readError(handle: QuickJSHandle): GuestErrorShape {
    if (this.ctx.typeof(handle) !== 'object') {
      return { name: 'Error', message: String(this.dumpValue(handle)) };
    }
    const shape: GuestErrorShape = {};
    const dumped = this.ctx.dump(handle) as Record<string, unknown> | null;
    if (dumped && typeof dumped === 'object') Object.assign(shape, dumped);
    for (const key of ['name', 'message', 'stack', 'fileName'] as const) {
      const prop = this.ctx.getProp(handle, key);
      if (this.ctx.typeof(prop) === 'string') shape[key] = this.ctx.getString(prop);
      prop.dispose();
    }
    for (const key of ['lineNumber', 'columnNumber'] as const) {
      const prop = this.ctx.getProp(handle, key);
      if (this.ctx.typeof(prop) === 'number') shape[key] = this.ctx.getNumber(prop);
      prop.dispose();
    }
    return shape;
  }

  // --- host bridge -------------------------------------------------------

  private define(name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void): void {
    const handle = this.ctx.newFunction(name, fn);
    this.ctx.setProp(this.ctx.global, name, handle);
    handle.dispose();
  }

  private numberArg(handle: QuickJSHandle | undefined): number {
    if (!handle) return Number.NaN;
    return this.ctx.typeof(handle) === 'number' ? this.ctx.getNumber(handle) : Number.NaN;
  }

  /** Length of a guest string without copying it to the host heap (plan §6.6). */
  private stringLength(handle: QuickJSHandle | undefined): number {
    if (!handle || this.ctx.typeof(handle) !== 'string') return -1;
    const prop = this.ctx.getProp(handle, 'length');
    const length = this.ctx.typeof(prop) === 'number' ? this.ctx.getNumber(prop) : -1;
    prop.dispose();
    return length;
  }

  private stringArg(handle: QuickJSHandle | undefined): string {
    if (!handle || this.ctx.typeof(handle) !== 'string') return '';
    return this.ctx.getString(handle);
  }

  private json(value: unknown): QuickJSHandle {
    return this.ctx.newString(JSON.stringify(value));
  }

  private newDeferred(): QuickJSDeferredPromise {
    const deferred = this.ctx.newPromise();
    this.live.add(deferred);
    return deferred;
  }

  /**
   * Settle from the host. Interrupts stay disarmed because `resolve` re-enters
   * the VM to call the promise capability.
   *
   * The promise handle is deliberately *not* disposed here. `newFunction`
   * duplicates whatever the bridge returns and then frees our copy, so a
   * validation failure that settles before returning would otherwise hand the
   * caller a dead handle; once the bridge call is over the handle is already
   * gone and there is nothing left to free. `resolve()` frees the resolver
   * handles, which is what teardown actually has to reclaim.
   */
  private settle(deferred: QuickJSDeferredPromise, value: unknown): void {
    if (!this.live.delete(deferred)) return;
    const previous = this.suspendInterrupt;
    this.suspendInterrupt = true;
    try {
      if (value === undefined) {
        deferred.resolve();
      } else {
        const handle = this.json(value);
        deferred.resolve(handle);
        handle.dispose();
      }
    } finally {
      this.suspendInterrupt = previous;
    }
  }

  private warn(code: 'i2c_nack' | 'i2c_bus_unavailable', message: string): void {
    this.host.diagnose({
      code,
      severity: SIM_DIAGNOSTIC_SEVERITY[code],
      message,
      atUs: this.host.nowUs()
    });
  }

  private validAddress(address: number): boolean {
    return Number.isInteger(address) && address >= HOST_LIMITS.i2cAddressMin && address <= HOST_LIMITS.i2cAddressMax;
  }

  private requirePin(pin: number): void {
    if (!Number.isInteger(pin) || !this.host.hasPin(pin)) {
      throw new Error(`引脚 ${Number.isFinite(pin) ? pin : '?'} 不属于本器件`);
    }
  }

  private requireLive(): void {
    if (this.disposed) throw new Error('仿真会话已结束');
  }

  private installBridge(): void {
    this.define('__bbsMicros', () => this.ctx.newNumber(this.host.nowUs()));

    this.define('__bbsSleep', (usHandle) => {
      this.requireLive();
      const delayUs = this.numberArg(usHandle);
      if (!Number.isSafeInteger(delayUs) || delayUs < 0) {
        throw new Error(`非法的延时：${Number.isFinite(delayUs) ? delayUs : String(delayUs)} µs`);
      }
      const deferred = this.newDeferred();
      this.host.sleep(delayUs, () => this.settle(deferred, undefined));
      return deferred.handle;
    });

    this.define('__bbsPinMode', (pinHandle, modeHandle) => {
      this.requireLive();
      const pin = this.numberArg(pinHandle);
      this.requirePin(pin);
      this.host.pinMode(pin, this.numberArg(modeHandle));
    });

    this.define('__bbsDigitalWrite', (pinHandle, valueHandle) => {
      this.requireLive();
      const pin = this.numberArg(pinHandle);
      this.requirePin(pin);
      this.host.digitalWrite(pin, this.numberArg(valueHandle) ? 1 : 0);
    });

    this.define('__bbsDigitalRead', (pinHandle) => {
      this.requireLive();
      const pin = this.numberArg(pinHandle);
      this.requirePin(pin);
      return this.json(this.host.digitalRead(pin));
    });

    this.define('__bbsSerialBegin', (baudHandle) => {
      this.requireLive();
      this.host.serialBegin(this.numberArg(baudHandle));
    });

    this.define('__bbsSerialWrite', (textHandle) => {
      this.requireLive();
      this.host.serialWrite(this.stringArg(textHandle));
    });

    this.define('__bbsBoardModel', () => this.json(this.host.boardModel()));

    this.define('__bbsBoardRgb', (rHandle, gHandle, bHandle) => {
      this.requireLive();
      this.host.rgb(this.numberArg(rHandle), this.numberArg(gHandle), this.numberArg(bHandle));
    });

    this.define('__bbsWireBegin', (optionsHandle) => {
      this.requireLive();
      let options: I2cBeginOptions = {};
      try {
        const parsed: unknown = JSON.parse(this.stringArg(optionsHandle) || '{}');
        if (parsed && typeof parsed === 'object') options = parsed as I2cBeginOptions;
      } catch {
        options = {};
      }
      return this.json(this.host.i2cBegin(options));
    });

    this.define('__bbsWireEnd', () => {
      this.requireLive();
      this.host.i2cEnd();
    });

    this.define('__bbsWireSetClock', (hzHandle) => {
      this.requireLive();
      this.host.i2cSetClock(this.numberArg(hzHandle));
    });

    this.define('__bbsWireWrite', (addressHandle, hexHandle) => {
      this.requireLive();
      const deferred = this.newDeferred();
      const address = this.numberArg(addressHandle);
      const bytes = this.takeWriteBytes(address, hexHandle, (status) => this.settle(deferred, status));
      if (bytes) this.host.i2cWrite(address, bytes, (status) => this.settle(deferred, status));
      return deferred.handle;
    });

    this.define('__bbsWireRead', (addressHandle, lengthHandle) => {
      this.requireLive();
      const deferred = this.newDeferred();
      const address = this.numberArg(addressHandle);
      const length = this.numberArg(lengthHandle);
      const failure = this.rejectAddress(address) ?? this.rejectReadLength(length);
      if (failure !== null) {
        this.settle(deferred, { status: failure, hex: '' });
        return deferred.handle;
      }
      this.host.i2cRead(address, length, (result) => this.settle(deferred, this.readPayload(result)));
      return deferred.handle;
    });

    this.define('__bbsWireWriteRead', (addressHandle, hexHandle, lengthHandle) => {
      this.requireLive();
      const deferred = this.newDeferred();
      const address = this.numberArg(addressHandle);
      const length = this.numberArg(lengthHandle);
      const lengthFailure = this.rejectAddress(address) ?? this.rejectReadLength(length);
      if (lengthFailure !== null) {
        this.settle(deferred, { status: lengthFailure, hex: '' });
        return deferred.handle;
      }
      const bytes = this.takeWriteBytes(address, hexHandle, (status) => this.settle(deferred, { status, hex: '' }));
      if (bytes) {
        this.host.i2cWriteRead(address, bytes, length, (result) => this.settle(deferred, this.readPayload(result)));
      }
      return deferred.handle;
    });
  }

  private readPayload(result: I2cReadResult): { status: I2cStatusCode; hex: string } {
    const bytes = result.status === I2C_STATUS.OK ? result.bytes : new Uint8Array(0);
    return { status: result.status, hex: encodeHex(bytes) };
  }

  /** Address gate (plan §6.6): an out-of-range address never reaches the bus. */
  private rejectAddress(address: number): I2cStatusCode | null {
    if (this.validAddress(address)) return null;
    this.warn('i2c_nack', `I²C 地址 ${Number.isFinite(address) ? address : '?'} 不是 0x00–0x7F 的整数，事务未发出`);
    return I2C_STATUS.NACK_ADDRESS;
  }

  private rejectReadLength(length: number): I2cStatusCode | null {
    if (Number.isSafeInteger(length) && length >= 0 && length <= HOST_LIMITS.i2cReadLength) return null;
    this.warn(
      'i2c_bus_unavailable',
      `I²C 读长度 ${Number.isFinite(length) ? length : '?'} 超出上限 ${HOST_LIMITS.i2cReadLength} 字节，事务未发出`
    );
    return I2C_STATUS.ERR_BUS;
  }

  /**
   * Validate then decode a write payload. The hex string is measured through
   * its `length` property first, so an oversized payload is refused without
   * ever being copied onto the host heap.
   */
  private takeWriteBytes(
    address: number,
    hexHandle: QuickJSHandle | undefined,
    fail: (status: I2cStatusCode) => void
  ): Uint8Array | null {
    const addressFailure = this.rejectAddress(address);
    if (addressFailure !== null) {
      fail(addressFailure);
      return null;
    }
    const hexLength = this.stringLength(hexHandle);
    if (hexLength < 0 || hexLength % 2 !== 0 || hexLength > HOST_LIMITS.i2cWriteHexChars) {
      this.warn(
        'i2c_bus_unavailable',
        `I²C 写入长度 ${hexLength < 0 ? '?' : hexLength / 2} 字节超出上限 ${HOST_LIMITS.i2cWriteHexChars / 2} 字节，事务未发出`
      );
      fail(I2C_STATUS.ERR_BUS);
      return null;
    }
    return decodeHex(this.stringArg(hexHandle));
  }
}
