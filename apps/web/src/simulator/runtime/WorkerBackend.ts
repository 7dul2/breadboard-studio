/**
 * Main-thread `SimulationBackend` over the Studio TS worker (plan §9.1).
 *
 * The protocol has no ack for `prepare`, so the resolve condition is the first
 * `{ type: 'status', status: 'prepared' }` and the reject conditions are an
 * error diagnostic, a dead worker, or the 20 s timeout (a cold dev start has to
 * fetch the wasm). An error diagnostic that ends the prepare is *not* forwarded
 * to the controller: it comes back as `SimBackendError`, and the controller
 * turns that into exactly one `faulted` + one diagnostic.
 *
 * `dispose()` terminates synchronously and only then returns an already
 * resolved promise, because `SimulatorController.disposeBackend` is
 * fire-and-forget — an awaited teardown would leave the worker running.
 */
import type { ProgramAsset, SimulationSpeed } from '@breadboard-studio/schema';
import {
  SIM_PROTOCOL_VERSION,
  SimBackendError,
  acceptsMessage,
  type ControlEvent,
  type HostCommand,
  type RuntimeMessage,
  type SimDiagnostic,
  type SimulationBackend,
  type SimulationSnapshot
} from '@breadboard-studio/sim';
import { divertDisplayPixels, visualBus } from './visualBus.js';

/** Distributive omit: a plain `Omit` over the union would collapse the variants. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'protocol' | 'sessionId'> : never;

/** A command before the backend stamps the envelope on. */
type BareCommand = WithoutEnvelope<HostCommand>;

/** Cold start in dev has to fetch the worker chunk and the 503 kB wasm. */
export const PREPARE_TIMEOUT_MS = 20_000;

/**
 * Host-level wasm deaths. Neither is catchable inside the worker: the instance
 * is already gone, so the only cure is `terminate()` plus a new session.
 */
function isFatalWorkerError(message: string): boolean {
  return message.includes('Maximum call stack size exceeded') || message.includes('Aborted(');
}

export class WorkerBackend implements SimulationBackend {
  readonly id = 'studio-ts-worker@1';

  private readonly sessionId: string;
  private worker: Worker | null = null;
  private readonly listeners = new Set<(message: RuntimeMessage) => void>();
  private pendingPrepare: { resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private startupError: string | null = null;
  private disposed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    try {
      // `new URL(..., import.meta.url)` is mandatory: Vite rewrites it with the
      // deployment base, an absolute "/…" path would 404 under /breadboard-studio/.
      const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<RuntimeMessage[] | RuntimeMessage>) => this.receive(event.data);
      worker.onerror = (event: ErrorEvent) => this.fatal(event.message || '仿真 Worker 发生未捕获的错误');
      worker.onmessageerror = () => this.fatal('仿真 Worker 发来的消息无法反序列化');
      this.worker = worker;
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : String(error);
    }
  }

  // ------------------------------------------------------------------ backend

  prepare(snapshot: SimulationSnapshot, program: ProgramAsset): Promise<void> {
    if (!this.worker) return Promise.reject(this.unavailable(program, this.startupError ?? '浏览器不支持 module worker'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPrepare = null;
        this.terminate();
        reject(this.unavailable(program, `仿真运行时在 ${PREPARE_TIMEOUT_MS / 1000} 秒内没有就绪`));
      }, PREPARE_TIMEOUT_MS);
      this.pendingPrepare = { resolve, reject, timer };
      this.post({ type: 'prepare', snapshot, program });
    });
  }

  start(): Promise<void> {
    this.post({ type: 'run' });
    return Promise.resolve();
  }

  pause(): Promise<void> {
    this.post({ type: 'pause' });
    return Promise.resolve();
  }

  step(): Promise<void> {
    this.post({ type: 'step' });
    return Promise.resolve();
  }

  reset(): Promise<void> {
    visualBus.clear();
    this.post({ type: 'reset' });
    return Promise.resolve();
  }

  setSpeed(speed: SimulationSpeed): void {
    this.post({ type: 'set-speed', speed });
  }

  sendControl(event: ControlEvent): void {
    this.post({ type: 'control', event });
  }

  setBreakpoints(netIds: readonly string[]): void {
    this.post({ type: 'set-breakpoints', netIds: [...netIds] });
  }

  onMessage(listener: (message: RuntimeMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Synchronous by contract: the controller does not await this. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.settlePrepare(this.unavailableDiagnostic('仿真会话已结束'));
    this.terminate();
    visualBus.clear();
    this.listeners.clear();
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- internals

  private post(command: BareCommand): void {
    if (!this.worker || this.disposed) return;
    this.worker.postMessage({ protocol: SIM_PROTOCOL_VERSION, sessionId: this.sessionId, ...command } as HostCommand);
  }

  private receive(data: RuntimeMessage[] | RuntimeMessage): void {
    if (this.disposed) return;
    const messages = Array.isArray(data) ? data : [data];
    for (const message of messages) {
      if (!acceptsMessage(message, this.sessionId)) continue;
      if (message.type === 'status' && message.status === 'prepared' && this.pendingPrepare) {
        const pending = this.pendingPrepare;
        this.pendingPrepare = null;
        clearTimeout(pending.timer);
        pending.resolve();
      }
      if (message.type === 'diagnostic' && message.diagnostic.severity === 'error' && this.pendingPrepare) {
        // Reported through the rejection instead of the message stream, so the
        // controller records the failure exactly once.
        this.settlePrepare(message.diagnostic);
        continue;
      }
      const forwarded =
        message.type === 'visual-diff' ? { ...message, states: divertDisplayPixels(message.states, message.revision) } : message;
      for (const listener of [...this.listeners]) listener(forwarded);
    }
  }

  /** A dead worker: terminate, fail any pending prepare, tell the session. */
  private fatal(message: string): void {
    const detail = isFatalWorkerError(message)
      ? `仿真运行时崩溃（${message}）：请点击“复位”重新开始一次会话。`
      : `仿真 Worker 异常终止：${message}`;
    this.terminate();
    const diagnostic = this.unavailableDiagnostic(detail);
    if (this.pendingPrepare) {
      this.settlePrepare(diagnostic);
      return;
    }
    for (const listener of [...this.listeners]) {
      listener({ protocol: SIM_PROTOCOL_VERSION, sessionId: this.sessionId, type: 'diagnostic', diagnostic });
    }
  }

  private settlePrepare(diagnostic: SimDiagnostic): void {
    const pending = this.pendingPrepare;
    if (!pending) return;
    this.pendingPrepare = null;
    clearTimeout(pending.timer);
    pending.reject(new SimBackendError(diagnostic));
  }

  private terminate(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  private unavailableDiagnostic(message: string, program?: ProgramAsset): SimDiagnostic {
    return {
      code: 'runtime_unavailable',
      severity: 'error',
      message,
      ...(program ? { componentIds: [program.target_component_id], source: { programId: program.id, line: 1, column: 1 } } : {})
    };
  }

  private unavailable(program: ProgramAsset, detail: string): SimBackendError {
    return new SimBackendError(this.unavailableDiagnostic(`仿真运行时不可用：${detail}`, program));
  }
}
