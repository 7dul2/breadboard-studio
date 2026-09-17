import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { transform } from 'sucrase';
import { compileStudioTs, scanImportSpecifiers } from '../src/runtime/compile.js';
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
const pid = 'program_main';

const cases: Array<[string, string]> = [
  ['template interpolation', 'const m = `${import(\'node:fs\')}`;\nexport const x = m;'],
  ['template specifier', 'export async function loop() { return await import(`node:fs`); }'],
  ['runtime-assembled var', 'const s = "node:fs";\nexport async function loop() { return await import(s); }'],
  ['concat', 'export async function loop() { return await import("node:" + "fs"); }'],
  ['comment inside', 'export async function loop() { return await import(/*x*/"node:fs"); }'],
  ['import.meta', 'export const u = import.meta.url;'],
  ['export star', 'export * from "node:fs";'],
  ['import-equals TS', 'import fs = require("node:fs");\nexport const x = fs;'],
  ['import type only', 'import type { X } from "node:fs";\nexport type Y = X;'],
  ['regex literal fp', 'const re = /import(\'node:fs\')/;\nexport const x = re;'],
  ['allowed with escape', 'import { gpio } from "@bbs/run\\u0074ime";\nexport const x = gpio;'],
];

for (const [label, source] of cases) {
  const sites = scanImportSpecifiers(source).map((s) => s.specifier);
  const c = compileStudioTs({ id: pid, name: 'p', target_component_id: 'mcu', language: 'studio-ts', source } as never, transform);
  let load = 'n/a';
  if (c.ok) {
    const sb = new StudioTsSandbox({ quickjs, program: { code: c.code, filename: c.filename }, host, clock: { nowMs: () => Date.now() }, seed: 1 });
    const r = sb.loadProgram();
    load = r.ok ? 'LOADED' : `load-error: ${String(r.error.name)}: ${String(r.error.message)}`;
    sb.dispose();
  }
  console.log(`${label.padEnd(24)} scan=${JSON.stringify(sites)} compile=${c.ok ? 'ok' : 'REJECT'} ${load}`);
}

// --- Error override + captureStack ---
const src = [
  'globalThis.Error = function () { for (;;) {} };',
  'export function loop() { let n = 0; while (true) { n = (n + 1) % 1000; } return n; }'
].join('\n');
const c2 = compileStudioTs({ id: pid, name: 'p', target_component_id: 'mcu', language: 'studio-ts', source: src } as never, transform);
if (!c2.ok) throw new Error('compile failed');
const clock = { ms: 0, step: 0, nowMs(): number { const v = this.ms; this.ms += this.step; return v; } };
const sb2 = new StudioTsSandbox({ quickjs, program: { code: c2.code, filename: c2.filename }, host, clock, seed: 1 });
console.log('loaded Error-override program:', sb2.loadProgram().ok);
clock.step = 1;
sb2.armDeadline(clock.ms + 20);
console.log('calling loop() with an expired deadline...');
const call = sb2.callEntry('loop');
console.log('callEntry returned:', JSON.stringify(call));
