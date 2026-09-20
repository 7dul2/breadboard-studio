import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { transform } from 'sucrase';
import { compileStudioTs } from '../src/runtime/compile.js';
import { StudioTsSandbox } from '../src/runtime/studio-ts.js';
import type { SandboxHost } from '../src/runtime/studio-ts.js';

const host = {
  nowUs: () => 0,
  hasPin: () => true,
  pinMode: () => {}, digitalWrite: () => {}, digitalRead: () => 0,
  serialBegin: () => {}, serialWrite: () => {}, boardModel: () => 'm',
  rgb: () => {}, sleep: (_us: number, done: () => void) => done(),
  i2cBegin: () => 0, i2cEnd: () => {}, i2cSetClock: () => {},
  i2cWrite: (_a: number, _b: Uint8Array, done: (s: number) => void) => done(0),
  i2cRead: (_a: number, _l: number, done: (r: { status: number; bytes: Uint8Array }) => void) => done({ status: 0, bytes: new Uint8Array(0) }),
  i2cWriteRead: (_a: number, _b: Uint8Array, _l: number, done: (r: { status: number; bytes: Uint8Array }) => void) => done({ status: 0, bytes: new Uint8Array(0) }),
  diagnose: () => {}
} as unknown as SandboxHost;

const quickjs = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
const source = 'let n = 0;\nwhile (true) { n = (n + 1) % 1000; }\nexport function loop() { return n; }';
const c = compileStudioTs({ id: 'program_main', name: 'p', target_component_id: 'mcu', language: 'studio-ts', source } as never, transform);
if (!c.ok) throw new Error('compile failed');
const clock = { nowMs: () => Date.now() };
const sandbox = new StudioTsSandbox({ quickjs, program: { code: c.code, filename: c.filename }, host, clock, seed: 1 });

// Before the fix (issue #79) this script hung forever: `deadlineMs` was
// `+Infinity` until `armDeadline()` was called, so a top-level loop never
// tripped and the worker was permanently locked. Now the constructor arms a
// finite default (`SANDBOX_UNARMED_LIMIT_MS`) and the session arms the slice
// budget before every load, so the loop is interrupted instead of hanging.
const watchdog = setTimeout(() => { console.log('TIMER FIRED: loadProgram still has not returned — the worker is hung (regression)'); process.exit(1); }, 3000);
console.log('calling loadProgram() (module top-level evaluation, no explicit armDeadline)...');
const r = sandbox.loadProgram();
clearTimeout(watchdog);
console.log('loadProgram returned ok=', r.ok, 'within the watchdog window');
if (r.ok) { console.log('UNEXPECTED: the top-level loop was allowed to finish'); process.exit(1); }
console.log('SEC-14 fixed: the top-level loop was interrupted, the worker survived');
process.exit(0);
