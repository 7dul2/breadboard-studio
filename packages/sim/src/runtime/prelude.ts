/**
 * Hardening prelude evaluated inside every sandbox before the guest program
 * (plan §6.1, §2.4). It runs as a `'global'` script, never as a module: it has
 * to mutate real globals, and a module scope cannot.
 *
 * Statement order matters. The four function prototypes must be captured
 * *before* `Function` is deleted from the global object, otherwise the guest
 * keeps a live path back to a code-generating constructor through
 * `(function(){}).constructor`.
 *
 * `Eval` stays a live intrinsic on purpose (plan §2.4): turning it off makes
 * even `ctx.evalCode('1 + 1')` fail with `TypeError: eval is not supported`, so
 * the removal is done here at the language level instead.
 */

/** The token `preludeSource` substitutes with the session seed. */
export const PRELUDE_SEED_TOKEN = '__SEED__';

/**
 * Global names that must not be reachable from guest code (plan §6.1).
 * `Date` is removed by the intrinsic switch, the rest either never exist in a
 * bare QuickJS context or are deleted below; the prelude deletes every one it
 * can so the guarantee does not depend on which of the two applies.
 */
export const SANDBOX_FORBIDDEN_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'performance',
  'Date',
  'console',
  'postMessage',
  'crypto',
  'WebAssembly',
  'importScripts',
  'require',
  'process',
  'eval',
  'Function'
] as const;

/**
 * Source of the prelude with `__SEED__` still in place. Use `preludeSource()`
 * unless you are asserting on the raw text.
 */
export const PRELUDE = `(function () {
  'use strict';
  // Capture the four function prototypes first: after Function is gone the
  // only way back to a code-generating constructor is .constructor, so each
  // of those is pinned to undefined below.
  var protos = [
    Object.getPrototypeOf(function () {}),
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {})
  ];
  for (var i = 0; i < protos.length; i++) {
    try {
      Object.defineProperty(protos[i], 'constructor', {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false
      });
    } catch (e) {
      // A locked-down prototype is already what we want.
    }
  }

  var banned = ${JSON.stringify([...SANDBOX_FORBIDDEN_GLOBALS])};
  for (var j = 0; j < banned.length; j++) {
    try {
      delete globalThis[banned[j]];
    } catch (e) {
      // Non-configurable globals stay, and the sandbox test asserts none do.
    }
  }

  // Deterministic Math.random (mulberry32). Locked so the guest cannot swap in
  // its own generator and break replay.
  var seed = ${PRELUDE_SEED_TOKEN} >>> 0;
  function mulberry32() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    var t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  Object.defineProperty(Math, 'random', {
    value: mulberry32,
    writable: false,
    enumerable: false,
    configurable: false
  });
})();
`;

/** The prelude with the session seed baked in. */
export function preludeSource(seed: number): string {
  return PRELUDE.replace(PRELUDE_SEED_TOKEN, String(seed >>> 0));
}
