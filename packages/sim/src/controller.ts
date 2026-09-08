/**
 * Session controller: owns the state machine, the backend and the runtime
 * view (diagnostics, serial, visuals). Framework-agnostic; the web app wraps
 * it in a store and the tests drive it with a fake backend.
 */
import type { DesignDocument, ProgramAsset, SimulationSpeed } from '@breadboard-studio/schema';
import { Catalog, builtinCatalog } from '@breadboard-studio/catalog';
import { activeProgram, analyzeDesign, designHash } from '@breadboard-studio/core';
import { SimBackendError, type BackendFactory, type SimulationBackend } from './runtime/backend.js';
import { buildSnapshot } from './snapshot.js';
import { SimulatorStateMachine, allowedCommands, canEditTopology, type SimCommand, type SimEvent, type Transition } from './state-machine.js';
import { acceptsMessage, type ControlEvent, type DeviceVisualState, type NetRuntimeView, type RuntimeMessage, type SerialLine, type SimDiagnostic, type SimStatus } from './types.js';

export interface SimulatorState {
  status: SimStatus;
  sessionId: string | null;
  /** Hash of the design the session was prepared from; a different hash means the session is stale. */
  designHash: string | null;
  programId: string | null;
  nowUs: number;
  speed: SimulationSpeed;
  diagnostics: SimDiagnostic[];
  serial: SerialLine[];
  visuals: Record<string, DeviceVisualState[]>;
  nets: NetRuntimeView[];
  /** Commands the state machine accepts right now (toolbar enablement). */
  allowed: SimCommand[];
  canEditTopology: boolean;
  /** Messages dropped because they carried another session id or protocol version. */
  droppedMessages: number;
}

export interface SimulatorControllerOptions {
  /** Creates the backend for a new session; `null` means no runtime is available in this build. */
  backend?: BackendFactory;
  catalog?: Catalog;
  serialLimit?: number;
  diagnosticLimit?: number;
}

export type CommandResult = Transition | { ok: false; from: SimStatus; event: SimEvent; reason: string; diagnostic?: SimDiagnostic };

const INITIAL: SimulatorState = {
  status: 'idle',
  sessionId: null,
  designHash: null,
  programId: null,
  nowUs: 0,
  speed: 1,
  diagnostics: [],
  serial: [],
  visuals: {},
  nets: [],
  allowed: allowedCommands('idle'),
  canEditTopology: true,
  droppedMessages: 0
};

/**
 * Key used to decide whether a running session still matches the design.
 * Everything is included except `simulation.speed`: playback speed is a live
 * control (docs §11.1), so changing it must not invalidate the snapshot.
 */
function staleKeyOf(design: DesignDocument): string {
  const sim = design.simulation;
  if (!sim || sim.speed === undefined) return designHash(design);
  const { speed: _speed, ...rest } = sim;
  const next: DesignDocument = { ...design };
  if (Object.keys(rest).length) next.simulation = rest;
  else delete next.simulation;
  return designHash(next);
}

function diagnosticOf(error: unknown, program: ProgramAsset): SimDiagnostic {
  if (error instanceof SimBackendError) return error.diagnostic;
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'program_runtime_error', severity: 'error', message: `后端错误：${message}`, componentIds: [program.target_component_id], source: { programId: program.id, line: 1, column: 1 } };
}

export class SimulatorController {
  private readonly machine = new SimulatorStateMachine();
  private readonly listeners = new Set<(state: SimulatorState) => void>();
  private readonly options: Required<SimulatorControllerOptions>;
  private backend: SimulationBackend | null = null;
  private unsubscribeBackend: (() => void) | null = null;
  private design: DesignDocument | null = null;
  private program: ProgramAsset | null = null;
  /** Stale-detection key of the design the session was prepared from (see staleKeyOf). */
  private staleKey: string | null = null;
  private sessions = 0;
  private state: SimulatorState = INITIAL;

  constructor(options: SimulatorControllerOptions = {}) {
    this.options = { backend: options.backend ?? (() => null), catalog: options.catalog ?? builtinCatalog(), serialLimit: options.serialLimit ?? 5000, diagnosticLimit: options.diagnosticLimit ?? 500 };
  }

  getState(): SimulatorState {
    return this.state;
  }

  subscribe(listener: (state: SimulatorState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ commands

  /** Start a new session from `design` (idle/faulted) or resume a paused/prepared one. */
  async run(design: DesignDocument): Promise<CommandResult> {
    const status = this.machine.status;
    if (status === 'paused' || status === 'prepared') {
      const t = this.dispatch('run');
      if (t.ok) await this.callBackend((b) => b.start());
      return t;
    }
    if (status !== 'idle') return this.reject('run');
    return this.launch(design, 'run');
  }

  async pause(): Promise<CommandResult> {
    const t = this.dispatch('pause');
    if (t.ok) await this.callBackend((b) => b.pause());
    return t;
  }

  /** Execute up to the next observable event, then pause again. */
  async step(): Promise<CommandResult> {
    const t = this.dispatch('step');
    if (!t.ok) return t;
    const session = this.state.sessionId;
    try {
      await this.backend?.step();
    } catch (e) {
      if (this.state.sessionId === session) this.fault(diagnosticOf(e, this.program!));
      return t;
    }
    if (this.state.sessionId === session && this.machine.status === 'stepping') this.dispatch('stepped');
    return t;
  }

  /** Re-prepare the same program: running → running, paused → paused, faulted → recompiled. */
  async reset(): Promise<CommandResult> {
    const status = this.machine.status;
    if (status === 'faulted') {
      if (!this.design) return this.reject('reset');
      const t = this.dispatch('stop');
      if (!t.ok) return t;
      const design = this.design;
      this.endSession();
      await this.disposeBackend();
      return this.launch(design, 'run');
    }
    const resume: 'run' | 'pause' = status === 'paused' ? 'pause' : 'run';
    const t = this.dispatch('reset');
    if (!t.ok) return t;
    const session = this.state.sessionId;
    this.emit({ nowUs: 0, serial: [], visuals: {}, nets: [], diagnostics: this.state.diagnostics.filter((d) => d.atUs === undefined) });
    try {
      await this.backend?.reset();
    } catch (e) {
      if (this.state.sessionId === session) this.fault(diagnosticOf(e, this.program!));
      return t;
    }
    if (this.state.sessionId !== session) return t;
    const next = this.dispatch(resume);
    if (next.ok && resume === 'run') await this.callBackend((b) => b.start());
    return t;
  }

  /** End the session; diagnostics stay visible until the next run. */
  async stop(): Promise<CommandResult> {
    const t = this.dispatch('stop');
    if (!t.ok) return t;
    this.endSession();
    await this.disposeBackend();
    return t;
  }

  setSpeed(speed: SimulationSpeed): void {
    this.emit({ speed });
    this.backend?.setSpeed?.(speed);
  }

  /** Drop the diagnostics shown so far (pre-flight and session ones); the session itself is untouched. */
  clearDiagnostics(): void {
    this.emit({ diagnostics: [] });
  }

  sendControl(event: ControlEvent): boolean {
    const status = this.machine.status;
    if (status !== 'running' && status !== 'paused' && status !== 'stepping') return false;
    this.backend?.sendControl(event);
    return true;
  }

  /**
   * Call whenever the design changes. A session prepared from another
   * revision is stale: it stops and reports `stale_simulation_snapshot`.
   */
  designChanged(design: DesignDocument): boolean {
    if (this.machine.status === 'idle') return false;
    if (staleKeyOf(design) === this.staleKey) {
      // Speed-only edit: the session survives, but keep the reported hash on the current document.
      const hash = designHash(design);
      if (hash !== this.state.designHash) this.emit({ designHash: hash, speed: design.simulation?.speed ?? this.state.speed });
      return false;
    }
    const t = this.dispatch('topology_changed');
    if (!t.ok) return false;
    void this.disposeBackend();
    this.endSession({ diagnostics: this.appendDiagnostic({ code: 'stale_simulation_snapshot', severity: 'info', message: `设计已修改（revision ${design.metadata.revision}），仿真会话已停止；重新运行将使用新的快照。` }) });
    return true;
  }

  // ------------------------------------------------------------------ internals

  private async launch(design: DesignDocument, resume: 'run' | 'pause'): Promise<CommandResult> {
    const program = activeProgram(design);
    if (!program) {
      const diagnostic: SimDiagnostic = { code: 'program_missing', severity: 'error', message: '没有可运行的程序：先在“仿真”标签中为主控新建程序。' };
      this.emit({ diagnostics: [diagnostic] });
      return { ok: false, from: this.machine.status, event: 'run', reason: diagnostic.message, diagnostic };
    }
    const analysis = analyzeDesign(design, this.options.catalog);
    if (analysis.hasBlocking) {
      const codes = [...new Set(analysis.results.filter((r) => r.blocking).map((r) => r.code))];
      const diagnostic: SimDiagnostic = { code: 'simulation_blocked_by_design', severity: 'error', message: `设计存在结构错误（${codes.join('、')}），不能启动仿真。`, componentIds: [...new Set(analysis.results.filter((r) => r.blocking).flatMap((r) => r.objects))] };
      this.emit({ diagnostics: [diagnostic] });
      return { ok: false, from: this.machine.status, event: 'run', reason: diagnostic.message, diagnostic };
    }
    const t = this.dispatch('run');
    if (!t.ok) return t;
    const sessionId = `sim-${++this.sessions}`;
    this.design = design;
    this.program = program;
    this.staleKey = staleKeyOf(design);
    this.emit({ sessionId, designHash: designHash(design), programId: program.id, speed: design.simulation?.speed ?? this.state.speed, nowUs: 0, diagnostics: [], serial: [], visuals: {}, nets: [], droppedMessages: 0 });

    const backend = this.options.backend();
    if (!backend) {
      this.fault({ code: 'runtime_unavailable', severity: 'error', message: `本版本尚未包含代码执行后端：程序 ${program.name} 已保存，但不能运行。`, componentIds: [program.target_component_id], source: { programId: program.id, line: 1, column: 1 } });
      return t;
    }
    this.backend = backend;
    this.unsubscribeBackend = backend.onMessage((message) => this.handleMessage(message));
    try {
      await backend.prepare(buildSnapshot(design, this.options.catalog, analysis), program);
    } catch (e) {
      if (this.state.sessionId === sessionId) this.fault(diagnosticOf(e, program));
      return t;
    }
    if (this.state.sessionId !== sessionId) return t; // stopped or invalidated while preparing
    const compiled = this.dispatch('compiled');
    if (!compiled.ok) return t;
    const started = this.dispatch(resume);
    if (started.ok && resume === 'run') await this.callBackend((b) => b.start());
    return t;
  }

  /** Forget the session identity. Called synchronously on stop/invalidate, before any await. */
  private endSession(patch: Partial<SimulatorState> = {}): void {
    this.staleKey = null;
    this.emit({ sessionId: null, designHash: null, programId: null, nowUs: 0, visuals: {}, nets: [], ...patch });
  }

  /** Await a backend call; a rejection faults this session instead of escaping to the caller. */
  private async callBackend(call: (backend: SimulationBackend) => Promise<void>): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    const session = this.state.sessionId;
    try {
      await call(backend);
    } catch (e) {
      if (this.state.sessionId === session && this.program) this.fault(diagnosticOf(e, this.program));
    }
  }

  private fault(diagnostic: SimDiagnostic): void {
    const t = this.machine.dispatch('fault');
    this.emit({ diagnostics: this.appendDiagnostic(diagnostic) });
    if (t.ok) void this.disposeBackend();
  }

  private handleMessage(message: RuntimeMessage): void {
    const sessionId = this.state.sessionId;
    if (!sessionId || !acceptsMessage(message, sessionId)) {
      this.emit({ droppedMessages: this.state.droppedMessages + 1 });
      return;
    }
    switch (message.type) {
      case 'status':
        this.emit({ nowUs: message.nowUs });
        return;
      case 'serial': {
        const line: SerialLine = { componentId: message.componentId, stream: message.stream, text: message.text, atUs: message.atUs };
        const serial = [...this.state.serial, line];
        this.emit({ serial: serial.length > this.options.serialLimit ? serial.slice(serial.length - this.options.serialLimit) : serial });
        return;
      }
      case 'diagnostic':
        if (message.diagnostic.severity === 'error' && this.machine.can('fault')) this.fault(message.diagnostic);
        else this.emit({ diagnostics: this.appendDiagnostic(message.diagnostic) });
        return;
      case 'visual-diff':
        this.emit({ visuals: { ...this.state.visuals, ...message.states } });
        return;
      case 'io-snapshot':
        this.emit({ nets: message.nets });
        return;
      case 'profile':
        return;
    }
  }

  private appendDiagnostic(diagnostic: SimDiagnostic): SimDiagnostic[] {
    const next = [...this.state.diagnostics, diagnostic];
    return next.length > this.options.diagnosticLimit ? next.slice(next.length - this.options.diagnosticLimit) : next;
  }

  private dispatch(event: SimEvent): Transition {
    const t = this.machine.dispatch(event);
    if (t.ok) this.emit({});
    return t;
  }

  private reject(event: SimEvent): CommandResult {
    return { ok: false, from: this.machine.status, event, reason: `状态 ${this.machine.status} 不接受 ${event}` };
  }

  private async disposeBackend(): Promise<void> {
    const backend = this.backend;
    this.backend = null;
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = null;
    if (backend) {
      try {
        await backend.dispose();
      } catch {
        // a dying backend must not block the state machine
      }
    }
  }

  private emit(patch: Partial<SimulatorState>): void {
    const status = this.machine.status;
    this.state = { ...this.state, ...patch, status, allowed: allowedCommands(status), canEditTopology: canEditTopology(status) };
    for (const listener of this.listeners) listener(this.state);
  }
}
