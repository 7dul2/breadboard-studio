/**
 * Session state machine (docs §12). Pure and synchronous: the controller and
 * the Worker both drive it, tests exercise it without any runtime.
 *
 *   idle ─run→ compiling ─compiled→ prepared ─run→ running
 *   running ─pause→ paused ─step→ stepping ─stepped→ paused
 *   running/paused ─reset→ prepared, faulted ─reset→ compiling
 *   any non-idle ─stop / topology_changed→ idle, ─fault→ faulted
 */
import type { SimStatus } from './types.js';

export const SIM_COMMANDS = ['run', 'pause', 'step', 'reset', 'stop'] as const;
export type SimCommand = (typeof SIM_COMMANDS)[number];

export const SIM_INTERNAL_EVENTS = ['compiled', 'stepped', 'fault', 'topology_changed'] as const;
export type SimInternalEvent = (typeof SIM_INTERNAL_EVENTS)[number];

export type SimEvent = SimCommand | SimInternalEvent;

/** Transition table: state → event → next state. Missing entries are illegal and rejected. */
export const SIM_TRANSITIONS: Readonly<Record<SimStatus, Readonly<Partial<Record<SimEvent, SimStatus>>>>> = {
  idle: { run: 'compiling' },
  compiling: { compiled: 'prepared', fault: 'faulted', stop: 'idle', topology_changed: 'idle' },
  // `prepared` is transient: the controller continues with `run` (start) or `pause` (reset while paused).
  prepared: { run: 'running', pause: 'paused', fault: 'faulted', stop: 'idle', topology_changed: 'idle' },
  running: { pause: 'paused', reset: 'prepared', fault: 'faulted', stop: 'idle', topology_changed: 'idle' },
  paused: { run: 'running', step: 'stepping', reset: 'prepared', fault: 'faulted', stop: 'idle', topology_changed: 'idle' },
  stepping: { stepped: 'paused', fault: 'faulted', stop: 'idle', topology_changed: 'idle' },
  faulted: { reset: 'compiling', stop: 'idle', topology_changed: 'idle' }
};

export type Transition = { ok: true; from: SimStatus; event: SimEvent; to: SimStatus } | { ok: false; from: SimStatus; event: SimEvent; reason: string };

export function transition(from: SimStatus, event: SimEvent): Transition {
  const to = SIM_TRANSITIONS[from][event];
  if (!to) return { ok: false, from, event, reason: `状态 ${from} 不接受 ${event}` };
  return { ok: true, from, event, to };
}

/** User commands that are legal in `state`, in toolbar order. */
export function allowedCommands(state: SimStatus): SimCommand[] {
  return SIM_COMMANDS.filter((command) => SIM_TRANSITIONS[state][command] !== undefined);
}

/** Topology edits (boards, components, wires) are only allowed while nothing is prepared or executing. */
export function canEditTopology(state: SimStatus): boolean {
  return state === 'idle' || state === 'faulted';
}

/** True when a Worker session exists (its messages are still meaningful). */
export function hasSession(state: SimStatus): boolean {
  return state !== 'idle';
}

export const STATUS_LABELS: Readonly<Record<SimStatus, string>> = {
  idle: '停止',
  compiling: '编译',
  prepared: '就绪',
  running: '运行',
  paused: '暂停',
  stepping: '单步',
  faulted: '故障'
};

/**
 * Small stateful wrapper: keeps the current status and rejects illegal events
 * instead of throwing, so callers can surface the reason.
 */
export class SimulatorStateMachine {
  private current: SimStatus;
  private readonly log: Transition[] = [];

  constructor(initial: SimStatus = 'idle') {
    this.current = initial;
  }

  get status(): SimStatus {
    return this.current;
  }

  /** Transitions attempted so far (accepted and rejected), oldest first. */
  get history(): readonly Transition[] {
    return this.log;
  }

  can(event: SimEvent): boolean {
    return SIM_TRANSITIONS[this.current][event] !== undefined;
  }

  dispatch(event: SimEvent): Transition {
    const t = transition(this.current, event);
    if (t.ok) this.current = t.to;
    this.log.push(t);
    return t;
  }

  reset(): void {
    this.current = 'idle';
    this.log.length = 0;
  }
}
