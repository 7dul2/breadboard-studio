/**
 * Worker-safe kernel surface: the deterministic parts of the simulator that
 * carry no dependency on `@breadboard-studio/core`, `catalog` or `snapshot.ts`.
 * Importing this never drags core + ajv into the worker chunk.
 *
 * `test/imports.test.ts` enforces that boundary by scanning the source, so it
 * is not a convention that can be quietly broken.
 */
export * from './types.js';
export * from './contracts.js';
export * from './scheduler.js';
export * from './digital-net.js';
export * from './power.js';
export * from './devices/registry.js';
export * from './devices/paint.js';
export * from './devices/esp32s3.js';
export * from './devices/ttp223.js';
export * from './devices/ssd1315.js';
export * from './devices/led.js';
export * from './i2c.js';
