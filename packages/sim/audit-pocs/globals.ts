import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { StudioTsSandbox } from '../src/runtime/studio-ts.js';
import type { SandboxHost } from '../src/runtime/studio-ts.js';

const host = {
  nowUs: () => 0, hasPin: () => true, pinMode: () => {}, digitalWrite: () => {}, digitalRead: () => 0,
  serialBegin: () => {}, serialWrite: () => {}, boardModel: () => 'm', rgb: () => {},
  sleep: (_us: number, done: () => void) => done(),
  i2cBegin: () => 0, i2cEnd: () => {}, i2cSetClock: () => {},
  i2cWrite: (_a: number, _b: Uint8Array, done: (s: number) => void) => done(0),
  i2cRead: (_a: number, _l: number, done: (r: { status: number; bytes: Uint8Array }) => void) => done({ status: 0, bytes: new Uint8Array(0) }),
  i2cWriteRead: (_a: number, _b: Uint8Array, _l: number, done: (r: { status: number; bytes: Uint8Array }) => void) => done({ status: 0, bytes: new Uint8Array(0) }),
  diagnose: () => {}
} as unknown as SandboxHost;
const quickjs = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
const sb = new StudioTsSandbox({ quickjs, program: { code: 'export const x=1;', filename: 'program_main' }, host, clock: { nowMs: () => Date.now() }, seed: 1 });

const exprs = [
  'typeof eval', 'typeof Function', 'typeof require', 'typeof process', 'typeof globalThis.postMessage',
  'typeof Reflect', 'typeof Proxy', 'typeof Symbol', 'typeof WeakRef', 'typeof FinalizationRegistry',
  'typeof SharedArrayBuffer', 'typeof Atomics', 'typeof WebAssembly', 'typeof Date', 'typeof console',
  '(function(){}).constructor', '(async function(){}).constructor', '(function*(){}).constructor',
  '(async function*(){}).constructor', 'Object.getPrototypeOf(function(){}).constructor',
  'Object.getPrototypeOf(async function(){}).constructor', 'Object.getPrototypeOf(function*(){}).constructor',
  'Object.getPrototypeOf(async function*(){}).constructor',
  '[].constructor.constructor', '({}).constructor.constructor', '"" .constructor.constructor',
  '(1).constructor.constructor', 'true.constructor.constructor',
  '(new Proxy(function(){},{})).constructor', '(class{}).constructor',
  '(async()=>{}).constructor', 'Object.constructor', 'Object.getPrototypeOf(Object).constructor',
  'globalThis.constructor', 'Object.getPrototypeOf(globalThis).constructor',
  'Object.getOwnPropertyNames(globalThis).join(",")',
  'typeof Object.getOwnPropertyDescriptor(Math,"random").value',
  'String(Object.getOwnPropertyDescriptor(Math,"random").writable)',
  'Object.getOwnPropertyNames(Function.prototype).join(",")',
  'typeof (0,eval)', 'typeof globalThis["ev"+"al"]',
  'typeof globalThis.Function', 'typeof globalThis.setTimeout', 'typeof importScripts',
  'typeof __bbsSerialWrite', 'typeof __bbsMicros', 'Object.getOwnPropertyNames(globalThis).filter(k=>k.startsWith("__bbs")).join(",")'
];
for (const e of exprs) {
  const r = sb.evaluateGlobal(`(function(){ try { return JSON.stringify(String(${e})); } catch (err) { return JSON.stringify("THREW:" + err.message); } })()`);
  console.log((r.ok ? String(r.value) : 'EVAL-ERROR ' + JSON.stringify(r.error)).padEnd(70), ' <= ', e);
}
sb.dispose();
