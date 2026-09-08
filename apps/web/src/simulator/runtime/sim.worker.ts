/**
 * Simulator worker entry (plan §2.3, §6.9).
 *
 * This is the **only** place in the repository that imports QuickJS, its wasm
 * variant and sucrase, and it does so with `await import()` so none of the
 * three reaches the main bundle. Measured: entry chunk 1,777 B, worker chunk
 * 264,184 B, one 503,134 B wasm file.
 *
 * Two rules keep that true:
 *  - import from `quickjs-emscripten-core` plus the single variant package,
 *    never from the `quickjs-emscripten` root (it ships four wasm builds);
 *  - address the worker only as `new Worker(new URL('./sim.worker.ts',
 *    import.meta.url), { type: 'module' })`, so Vite rewrites the URL and the
 *    subpath deployment keeps working. No path starting with `/`, ever.
 *
 * The heavy modules load on the first command, so commands that arrive while
 * the wasm is still being fetched are queued rather than dropped.
 */
import { SIM_PROTOCOL_VERSION, SessionRuntime, type HostCommand, type RuntimeMessage, type SimDiagnostic } from '@breadboard-studio/sim/worker';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let session: SessionRuntime | null = null;
let booting: Promise<void> | null = null;
const queued: HostCommand[] = [];

function post(messages: RuntimeMessage[]): void {
  if (messages.length > 0) scope.postMessage(messages);
}

/** Report a worker-level failure the same way the session reports its own. */
function reportFatal(sessionId: string, message: string): void {
  const diagnostic: SimDiagnostic = { code: 'runtime_unavailable', severity: 'error', message };
  post([{ protocol: SIM_PROTOCOL_VERSION, sessionId, type: 'diagnostic', diagnostic }]);
}

async function boot(): Promise<void> {
  const [core, variant, sucrase] = await Promise.all([
    import('quickjs-emscripten-core'),
    import('@jitl/quickjs-wasmfile-release-sync'),
    import('sucrase')
  ]);
  const quickjs = await core.newQuickJSWASMModuleFromVariant(variant.default);
  session = new SessionRuntime({
    quickjs,
    transform: sucrase.transform,
    clock: { nowMs: () => performance.now() },
    emit: post,
    // The worker has no requestAnimationFrame; a macrotask timer is what lets
    // `pause` and `control` messages be delivered between slices.
    schedule: (delayMs, run) => {
      const id = scope.setTimeout(run, delayMs);
      return () => scope.clearTimeout(id);
    }
  });
}

function drain(): void {
  const runtime = session;
  if (!runtime) return;
  while (queued.length > 0) {
    const command = queued.shift() as HostCommand;
    runtime.handle(command);
    if (command.type === 'dispose') {
      scope.close();
      return;
    }
  }
}

scope.onmessage = (event: MessageEvent<HostCommand>): void => {
  const command = event.data;
  if (!command || typeof command !== 'object' || typeof command.type !== 'string') return;
  queued.push(command);
  if (session) {
    drain();
    return;
  }
  booting ??= boot().then(
    () => drain(),
    (error: unknown) => {
      reportFatal(command.sessionId, `仿真运行时无法加载：${error instanceof Error ? error.message : String(error)}`);
    }
  );
};
