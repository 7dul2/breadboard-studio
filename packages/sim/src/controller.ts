/**
 * Session controller: owns the state machine, the backend and the runtime
 * view (diagnostics, serial, visuals). Framework-agnostic; the web app wraps
 * it in a store and the tests drive it with a fake backend.
 */
import type { DesignDocument, ProgramAsset, SimulationSpeed } from '@breadboard-studio/schema';
import { Catalog, builtinCatalog } from '@breadboard-studio/catalog';
import { activeProgram, analyzeDesign, designHash, type RuleResult } from '@breadboard-studio/core';
import { SimBackendError, type BackendFactory, type SimulationBackend } from './runtime/backend.js';
import { buildSnapshot } from './snapshot.js';
import { SimulatorStateMachine, allowedCommands, canEditTopology, type SimCommand, type SimEvent, type Transition } from './state-machine.js';
import { acceptsMessage, type ControlEvent, type DeviceVisualState, type NetRuntimeView, type NetTransition, type RuntimeMessage, type SerialLine, type SimDiagnostic, type SimStatus } from './types.js';

/** How many edges the panel keeps. Roughly a minute of a 500 µs blink. */
export const TRACE_HISTORY = 4000;

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
  /**
   * Recent edges on every net, oldest first — what the timeline draws. Bounded by
   * `TRACE_HISTORY`: a session can run for hours and the panel only ever shows the
   * recent past, so keeping all of it would be a leak with no reader.
   */
  trace: NetTransition[];
  /** Edges the worker's buffer or this one had to discard; a gap is never silent. */
  traceDropped: number;
  /** Net ids the run pauses on, sorted. */
  breakpoints: string[];
  /** Commands the state machine accepts right now (toolbar enablement). */
  allowed: SimCommand[];
  canEditTopology: boolean;
  /** Messages dropped because they carried another session id or protocol version. */
  droppedMessages: number;
  /** True while a session is running that only started because `forceStart` overrode the pre-flight. */
  forceStarted: boolean;
}

export interface SimulatorControllerOptions {
  /** Creates the backend for a new session; `null` means no runtime is available in this build. */
  backend?: BackendFactory;
  catalog?: Catalog;
  serialLimit?: number;
  diagnosticLimit?: number;
}

export type CommandResult = Transition | { ok: false; from: SimStatus; event: SimEvent; reason: string; diagnostic?: SimDiagnostic };

export interface SimulatorRunOptions {
  /**
   * Debug-only escape hatch (docs/SIMULATOR_RUNTIME_PLAN.md §9.5): start even
   * though the pre-flight found an electrical blocker. Never persisted into the
   * design document — the UI keeps this flag in localStorage only.
   */
  forceStart?: boolean;
}

/**
 * Analysis codes that stop the simulator from starting (plan §9.5).
 *
 * These are `severity: 'error'` but `blocking: false` in `analyzeDesign`
 * (`rules.ts` never blocks electrical problems, so the document still commits),
 * which is why `analysis.hasBlocking` cannot be used here. Connectivity is not
 * recomputed: the codes are read straight off `analysis.results`.
 */
export const SIM_PREFLIGHT_BLOCKING_CODES = ['power_ground_short', 'voltage_conflict'] as const;

/**
 * Electrical results that block a simulation run. `supply_out_of_range` is
 * deliberately absent: it has to show up at runtime as `device_unpowered`, so
 * the user sees "wrong voltage → screen stays dark". `power_budget_*` and
 * `power_capacity_unknown` are datasheet comparisons and never block.
 */
export function simulationBlockers(results: readonly RuleResult[]): RuleResult[] {
  const codes: readonly string[] = SIM_PREFLIGHT_BLOCKING_CODES;
  return results.filter((r) => codes.includes(r.code));
}

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
  trace: [],
  traceDropped: 0,
  breakpoints: [],
  allowed: allowedCommands('idle'),
  canEditTopology: true,
  droppedMessages: 0,
  forceStarted: false
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
  /** Options the current session was launched with; reused when a faulted session is reset. */
  private launchOptions: SimulatorRunOptions = {};
  /** Permanent warning of a force-started session: survives reset and clearDiagnostics. */
  private forcedDiagnostic: SimDiagnostic | null = null;
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

  /**
   * Start a new session from `design` (idle/faulted) or resume a paused/prepared one.
   * `opts.forceStart` only affects a fresh launch; resuming never re-runs the pre-flight.
   */
  async run(design: DesignDocument, opts: SimulatorRunOptions = {}): Promise<CommandResult> {
    const status = this.machine.status;
    if (status === 'paused' || status === 'prepared') {
      const t = this.dispatch('run');
      if (t.ok) await this.callBackend((b) => b.start());
      return t;
    }
    if (status !== 'idle') return this.reject('run');
    return this.launch(design, 'run', opts);
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
      const opts = this.launchOptions;
      this.endSession();
      await this.disposeBackend();
      // Reset must not turn into a refusal: a force-started session stays force-started.
      return this.launch(design, 'run', opts);
    }
    const resume: 'run' | 'pause' = status === 'paused' ? 'pause' : 'run';
    const t = this.dispatch('reset');
    if (!t.ok) return t;
    const session = this.state.sessionId;
    this.emit({ nowUs: 0, serial: [], visuals: {}, nets: [], trace: [], traceDropped: 0, diagnostics: this.state.diagnostics.filter((d) => d.atUs === undefined) });
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

  /**
   * Drop the diagnostics shown so far (pre-flight and session ones); the session
   * itself is untouched. The force-start warning is permanent for the session
   * (plan §9.5) and cannot be dismissed this way.
   */
  clearDiagnostics(): void {
    this.emit({ diagnostics: this.forcedDiagnostic ? [this.forcedDiagnostic] : [] });
  }

  /**
   * Nets to pause on. Kept in controller state so the panel can show which strips
   * are armed even across a pause, and re-sent on every change rather than diffed —
   * the set is tiny and a lost toggle would be worse than a redundant message.
   */
  setBreakpoints(netIds: readonly string[]): void {
    const unique = [...new Set(netIds)].sort();
    this.emit({ breakpoints: unique });
    this.backend?.setBreakpoints?.(unique);
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

  private async launch(design: DesignDocument, resume: 'run' | 'pause', opts: SimulatorRunOptions = {}): Promise<CommandResult> {
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
    // Electrical pre-flight (plan §9.5): `blocking` is false for these codes, so they are picked by code.
    const blockers = simulationBlockers(analysis.results);
    let forced: SimDiagnostic | null = null;
    if (blockers.length) {
      const codes = [...new Set(blockers.map((r) => r.code))].join('、');
      const componentIds = [...new Set(blockers.flatMap((r) => r.objects))];
      const pinAddresses = [...new Set(blockers.flatMap((r) => r.endpoints ?? []))];
      if (!opts.forceStart) {
        const diagnostic: SimDiagnostic = { code: 'simulation_blocked_by_design', severity: 'error', message: `设计存在电气错误（${codes}），默认不允许启动仿真。请先修好接线；确认要带着这个问题调试时，可在工具栏勾选“仅调试：强制启动”。`, componentIds, pinAddresses };
        this.emit({ diagnostics: [diagnostic] });
        return { ok: false, from: this.machine.status, event: 'run', reason: diagnostic.message, diagnostic };
      }
      // Severity is downgraded to `warning` on purpose: SIM_DIAGNOSTIC_SEVERITY maps this code to
      // `error`, and any error diagnostic faults the session — a force-started session must keep running.
      forced = { code: 'simulation_forced_start', severity: 'warning', message: `已强制启动（仅调试）：设计存在电气错误（${codes}），真实电路可能损坏，仿真结果不可信。`, componentIds, pinAddresses };
    }
    const t = this.dispatch('run');
    if (!t.ok) return t;
    const sessionId = `sim-${++this.sessions}`;
    this.design = design;
    this.program = program;
    this.launchOptions = opts;
    this.forcedDiagnostic = forced;
    this.staleKey = staleKeyOf(design);
    this.emit({ sessionId, designHash: designHash(design), programId: program.id, speed: design.simulation?.speed ?? this.state.speed, nowUs: 0, diagnostics: forced ? [forced] : [], serial: [], visuals: {}, nets: [], trace: [], traceDropped: 0, droppedMessages: 0, forceStarted: forced !== null });

    const backend = this.options.backend();
    if (!backend) {
      this.fault({ code: 'runtime_unavailable', severity: 'error', message: `本版本尚未包含代码执行后端：程序 ${program.name} 已保存，但不能运行。`, componentIds: [program.target_component_id], source: { programId: program.id, line: 1, column: 1 } });
      return t;
    }
    this.backend = backend;
    this.unsubscribeBackend = backend.onMessage((message) => this.handleMessage(message));
    try {
      await backend.prepare(buildSnapshot(design, this.options.catalog, analysis), program);
      // A fresh backend knows nothing about the breakpoints the panel still shows,
      // so they are re-sent rather than silently forgotten on every reset.
      if (this.state.breakpoints.length) backend.setBreakpoints?.(this.state.breakpoints);
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
    this.launchOptions = {};
    this.forcedDiagnostic = null;
    this.emit({ sessionId: null, designHash: null, programId: null, nowUs: 0, visuals: {}, nets: [], forceStarted: false, ...patch });
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
        // The backend pauses itself when the queue drains with input sources present (§4.4);
        // without this dispatch the toolbar would keep claiming the session is running.
        // Other statuses (notably `prepared`) stay pure notifications: the backend's own
        // `prepare()` resolves on them, and the controller must not swallow or re-interpret them.
        if (message.status === 'paused' && this.machine.status === 'running') this.dispatch('pause');
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
      case 'net-trace': {
        const merged = [...this.state.trace, ...message.transitions];
        const overflow = Math.max(0, merged.length - TRACE_HISTORY);
        this.emit({ trace: overflow ? merged.slice(overflow) : merged, traceDropped: this.state.traceDropped + message.dropped + overflow });
        return;
      }
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
