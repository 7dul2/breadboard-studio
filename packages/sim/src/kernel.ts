/**
 * Worker-safe kernel surface. Everything re-exported here is pure TypeScript
 * with no dependency on `@breadboard-studio/core`, `catalog` or `snapshot.ts`,
 * so importing it never drags core + ajv into the worker chunk.
 *
 * `packages/sim/test/imports.test.ts` enforces that boundary by scanning the
 * source, so this is not a convention you can quietly break.
 */
export * from './types.js';
export * from './contracts.js';
