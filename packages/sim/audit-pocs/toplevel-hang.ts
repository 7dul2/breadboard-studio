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

setTimeout(() => { console.log('TIMER FIRED: main thread was NOT blocked; loadProgram returned'); process.exit(0); }, 3000);
console.log('armed deadline before loadProgram?  deadlineMs is +Infinity until armDeadline() is called');
console.log('calling loadProgram() (module top-level evaluation)...');
const r = sandbox.loadProgram();
console.log('loadProgram returned ok=', r.ok);
