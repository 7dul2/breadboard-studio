import type { ProgramAsset, SimulationSpeed } from '@breadboard-studio/schema';
import type { ControlEvent, RuntimeMessage, SimDiagnostic, SimulationSnapshot } from '../types.js';

/**
 * A backend executes one program against a snapshot and reports through
 * RuntimeMessages (docs §8.2). The Studio TS Worker, a QEMU bridge or a real
 * board over WebSerial all implement this same interface.
 */
export interface SimulationBackend {
  readonly id: string;
  prepare(snapshot: SimulationSnapshot, program: ProgramAsset): Promise<void>;
  start(): Promise<void>;
  pause(): Promise<void>;
  step(): Promise<void>;
  reset(): Promise<void>;
  sendControl(event: ControlEvent): void;
  /** Optional: nets to pause on. A backend without breakpoints simply runs on. */
  setBreakpoints?(netIds: readonly string[]): void;
  /** Optional: change the virtual-time multiplier while running. */
  setSpeed?(speed: SimulationSpeed): void;
  onMessage(listener: (message: RuntimeMessage) => void): () => void;
  dispose(): Promise<void>;
}

/** Thrown by a backend when it cannot honour a call; carries the diagnostic the UI should show. */
export class SimBackendError extends Error {
  constructor(public readonly diagnostic: SimDiagnostic) {
    super(diagnostic.message);
    this.name = 'SimBackendError';
  }
}

export type BackendFactory = () => SimulationBackend | null;

/**
 * Placeholder used until the Studio TS Worker backend exists: `prepare`
 * always fails with `runtime_unavailable`, so a session started against it
 * ends in `faulted` with a clear diagnostic instead of pretending to run.
 */
export class UnavailableBackend implements SimulationBackend {
  readonly id = 'unavailable@0';

  prepare(_snapshot: SimulationSnapshot, program: ProgramAsset): Promise<void> {
    return Promise.reject(
      new SimBackendError({
        code: 'runtime_unavailable',
        severity: 'error',
        message: `本版本尚未包含代码执行后端：程序 ${program.name} 已保存，但不能运行（阶段 1 将加入 Studio TS 运行时）`,
        componentIds: [program.target_component_id],
        source: { programId: program.id, line: 1, column: 1 }
      })
    );
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  pause(): Promise<void> {
    return Promise.resolve();
  }
  step(): Promise<void> {
    return Promise.resolve();
  }
  reset(): Promise<void> {
    return Promise.resolve();
  }
  sendControl(): void {}
  onMessage(): () => void {
    return () => {};
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
