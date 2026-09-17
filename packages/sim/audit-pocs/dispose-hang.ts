import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { transform } from 'sucrase';
import { compileStudioTs } from '../src/runtime/compile.js';
import { StudioTsSandbox } from '../src/runtime/studio-ts.js';
import type { SandboxHost } from '../src/runtime/studio-ts.js';

// i2cWrite never completes: the guest's Wire.write promise stays pending.
const host = {
  nowUs: () => 0, hasPin: () => true, pinMode: () => {}, digitalWrite: () => {}, digitalRead: () => 0,
  serialBegin: () => {}, serialWrite: () => {}, boardModel: () => 'm', rgb: () => {},
  sleep: () => {},
  i2cBegin: () => 0, i2cEnd: () => {}, i2cSetClock: () => {},
  i2cWrite: () => {}, i2cRead: () => {}, i2cWriteRead: () => {},
  diagnose: () => {}
} as unknown as SandboxHost;

const quickjs = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
const src = [
  "import { Wire, sleep } from '@bbs/runtime';",
  'export async function loop() {',
  '  const p = Wire.write(0x3c, [1]);',
  '  p.catch(function () { for (;;) {} });',
  '  await sleep(1000000);',
  '}'
].join('\n');
const c = compileStudioTs({ id: 'program_main', name: 'p', target_component_id: 'mcu', language: 'studio-ts', source: src } as never, transform);
if (!c.ok) throw new Error('compile');
const sb = new StudioTsSandbox({ quickjs, program: { code: c.code, filename: c.filename }, host, clock: { nowMs: () => Date.now() }, seed: 1 });
console.log('loadProgram:', sb.loadProgram().ok);
sb.armDeadline(Date.now() + 1_000_000);
console.log('callEntry loop:', sb.callEntry('loop').ok);
sb.armDeadline(Date.now() + 1_000_000);
sb.drainJobs();
console.log('drivenState:', JSON.stringify(sb.drivenState()));
console.log('calling dispose() — a pending Wire promise has a looping .catch()...');
sb.dispose();
console.log('dispose() returned');
