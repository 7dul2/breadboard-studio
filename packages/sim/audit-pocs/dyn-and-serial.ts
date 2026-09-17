import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { transform } from 'sucrase';
import { compileStudioTs } from '../src/runtime/compile.js';
import { StudioTsSandbox } from '../src/runtime/studio-ts.js';
import type { SandboxHost } from '../src/runtime/studio-ts.js';
import { Esp32S3Driver } from '../src/devices/esp32s3.js';
import type { DeviceContext } from '../src/contracts.js';

const lines: string[] = [];
const host = {
  nowUs: () => 0, hasPin: () => true, pinMode: () => {}, digitalWrite: () => {}, digitalRead: () => 0,
  serialBegin: () => {}, serialWrite: (t: string) => lines.push(t), boardModel: () => 'm', rgb: () => {},
  sleep: (_us: number, done: () => void) => done(),
  i2cBegin: () => 0, i2cEnd: () => {}, i2cSetClock: () => {},
  i2cWrite: (_a: number, _b: Uint8Array, done: (s: number) => void) => done(0),
  i2cRead: (_a: number, _l: number, done: (r: { status: number; bytes: Uint8Array }) => void) => done({ status: 0, bytes: new Uint8Array(0) }),
  i2cWriteRead: (_a: number, _b: Uint8Array, _l: number, done: (r: { status: number; bytes: Uint8Array }) => void) => done({ status: 0, bytes: new Uint8Array(0) }),
  diagnose: () => {}
} as unknown as SandboxHost;

const quickjs = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
const src = 'const m = `${import("node:fs")}`;\nexport function loop() { return m; }';
const c = compileStudioTs({ id: 'program_main', name: 'p', target_component_id: 'mcu', language: 'studio-ts', source: src } as never, transform);
if (!c.ok) throw new Error('compile');
const sb = new StudioTsSandbox({ quickjs, program: { code: c.code, filename: c.filename }, host, clock: { nowMs: () => Date.now() }, seed: 1 });
console.log('loadProgram:', sb.loadProgram().ok, '(dynamic import at top level)');
sb.armDeadline(Date.now() + 100000);
const jobs = sb.drainJobs();
console.log('drainJobs ->', JSON.stringify({ hasPending: jobs.hasPending, error: jobs.error ? { name: (jobs.error as any).name, message: (jobs.error as any).message } : undefined }));
console.log('drivenState ->', JSON.stringify(sb.drivenState()));
sb.dispose();

const ctx = {
  componentId: 'mcu', spec: { componentId: 'mcu', model: 'esp32s3_n16r8_dual_usb', driver: 'mcu.esp32s3.behavioral@1', pinNets: {}, pinChannels: { GPIO48: 48, TX: 43 }, properties: { rgb_gpio: 48 }, pinMeta: {} },
  nowUs: () => 0, random: () => 0.5, drive: () => {}, release: () => {}, read: () => 0 as const, watch: () => {}, netIdOf: () => 'n',
  power: () => ({ railV: 5, groundOk: true, powered: true }), after: () => 1, cancel: () => {},
  visual: () => {}, serial: () => {}, diagnose: () => {}, diagnoseOnce: () => {}, attachI2c: () => {}
} as unknown as DeviceContext;
const drv = new Esp32S3Driver(ctx);
const chunk = 'x'.repeat(65536);
for (let round = 1; round <= 8; round++) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) drv.serialWrite(chunk);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`round ${round}: buffered ~${(round * 50 * 65536 / 1e6).toFixed(1)} MB, 50 more 64 KiB appends took ${ms.toFixed(1)} ms`);
}
