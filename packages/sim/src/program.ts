import type { ComponentDefinition, ProgramAsset } from '@breadboard-studio/schema';

export const PROGRAM_ENTRY_DEFAULT = 'main.ts';

/**
 * Starter program written into a new ProgramAsset. It documents the Studio TS
 * API (docs §8.1); nothing here executes until the runtime backend lands.
 */
export const DEFAULT_PROGRAM_SOURCE = `// Studio TypeScript · Arduino 风格 API（见 docs/SIMULATOR_DESIGN.md §8）
// 只能导入 '@bbs/runtime' 与内置器件库；代码在隔离沙箱中运行，无法访问浏览器或网络。
import { gpio, Serial, sleep, OUTPUT } from '@bbs/runtime';

const LED = 48; // 板载 RGB 灯的数据引脚（N16R8：GPIO48）

export async function setup() {
  Serial.begin(115200);
  gpio.pinMode(LED, OUTPUT);
  Serial.println('ready');
}

export async function loop() {
  gpio.digitalWrite(LED, 1);
  await sleep(500);
  gpio.digitalWrite(LED, 0);
  await sleep(500);
}
`;

export interface NewProgramOptions {
  id: string;
  target_component_id: string;
  name?: string;
  source?: string;
  entry?: string;
}

/** Build a ProgramAsset with the starter source; validate/commit it through `applyOps({ op: 'add_program' })`. */
export function createProgramAsset(options: NewProgramOptions): ProgramAsset {
  return {
    id: options.id,
    name: options.name ?? `程序 ${options.target_component_id}`,
    target_component_id: options.target_component_id,
    language: 'studio-ts',
    source: options.source ?? DEFAULT_PROGRAM_SOURCE,
    ...(options.entry ? { entry: options.entry } : {})
  };
}

/** True when the definition declares a simulator driver, i.e. programs targeting it will be able to run. */
export function hasSimulationDriver(def: ComponentDefinition | undefined): boolean {
  return typeof def?.simulation?.driver === 'string' && def.simulation.driver.length > 0;
}

/** True when a definition can host a program: an MCU with a driver (the UI lists these as program targets). */
export function isProgramTarget(def: ComponentDefinition | undefined): boolean {
  return !!def && def.category === 'mcu';
}
