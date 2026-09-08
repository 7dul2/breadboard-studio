/**
 * Zustand wrapper around one SimulatorController (docs §11–§12). The store
 * mirrors the controller state and adds the UI-only bits: the code editor
 * drawer and unsaved drafts.
 *
 * The mirror is frame-merged (plan §9.4): the controller emits once per
 * runtime message, and copying all of that into zustand re-rendered the whole
 * panel on every `status`. Anything that changes what the toolbar may do —
 * status, session, allowed commands, a new diagnostic — is flushed
 * immediately; the high-rate fields (`nowUs`, serial, nets, visuals) are
 * coalesced into one `setState` per animation frame. The cost is that
 * `window.__bbs.simulator()` can lag by one frame, so e2e must poll.
 */
import { create } from 'zustand';
import type { SimulationSpeed } from '@breadboard-studio/schema';
import { SimulatorController, type CommandResult, type SimulatorState } from '@breadboard-studio/sim';
import { setTopologyGuard, useStore } from '../store';
import { WorkerBackend } from './runtime/WorkerBackend';

export const EDITOR_MIN_HEIGHT = 120;
export const EDITOR_DEFAULT_HEIGHT = 280;

export interface SimulatorUiState extends SimulatorState {
  editorOpen: boolean;
  editorProgramId: string | null;
  /** Unsaved editor text per program id; absent when the editor shows the saved source. */
  drafts: Record<string, string>;
  editorHeight: number;

  /** `forceStart` launches despite a pre-flight electrical blocker (debug only, plan §9.5). */
  run: (opts?: { forceStart?: boolean }) => Promise<void>;
  pause: () => Promise<void>;
  step: () => Promise<void>;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
  setSpeed: (speed: SimulationSpeed) => void;
  /** Drop the diagnostics shown so far (pre-flight and last-session ones). */
  clearDiagnostics: () => void;
  openEditor: (programId: string) => void;
  closeEditor: () => void;
  setDraft: (programId: string, text: string) => void;
  clearDraft: (programId: string) => void;
  setEditorHeight: (height: number) => void;
}

/**
 * The backend factory reads the session id out of the controller instead of
 * taking it as an argument: `launch` emits the new id *before* it calls the
 * factory, so the closure sees the right one and neither the protocol nor the
 * controller needs a new parameter (plan §9.1).
 */
const controller: SimulatorController = new SimulatorController({
  backend: () => new WorkerBackend(controller.getState().sessionId as string)
});

function report(result: CommandResult, label: string): void {
  if (result.ok) return;
  const message = 'diagnostic' in result && result.diagnostic ? result.diagnostic.message : result.reason;
  useStore.getState().toast('error', `${label}失败：${message}`);
}

export const useSimulatorStore = create<SimulatorUiState>((set, get) => ({
  ...controller.getState(),
  editorOpen: false,
  editorProgramId: null,
  drafts: {},
  editorHeight: EDITOR_DEFAULT_HEIGHT,

  async run(opts) {
    // A faulted session cannot be resumed; start a fresh one from the current design.
    if (controller.getState().status === 'faulted') await controller.stop();
    report(await controller.run(useStore.getState().design, opts), '运行');
  },
  async pause() {
    report(await controller.pause(), '暂停');
  },
  async step() {
    report(await controller.step(), '单步');
  },
  async reset() {
    report(await controller.reset(), '复位');
  },
  async stop() {
    report(await controller.stop(), '停止');
  },
  setSpeed(speed) {
    controller.setSpeed(speed);
  },
  clearDiagnostics() {
    controller.clearDiagnostics();
  },

  openEditor(programId) {
    set({ editorOpen: true, editorProgramId: programId });
  },
  closeEditor() {
    set({ editorOpen: false });
  },
  setDraft(programId, text) {
    const program = useStore.getState().design.programs?.find((p) => p.id === programId);
    const drafts = { ...get().drafts };
    if (program && program.source === text) delete drafts[programId];
    else drafts[programId] = text;
    set({ drafts });
  },
  clearDraft(programId) {
    if (!(programId in get().drafts)) return;
    const drafts = { ...get().drafts };
    delete drafts[programId];
    set({ drafts });
  },
  setEditorHeight(height) {
    set({ editorHeight: Math.max(EDITOR_MIN_HEIGHT, Math.round(height)) });
  }
}));

/** True when the editor text for `programId` differs from the saved program source. */
export function isDraftDirty(programId: string | null): boolean {
  if (!programId) return false;
  const draft = useSimulatorStore.getState().drafts[programId];
  if (draft === undefined) return false;
  const program = useStore.getState().design.programs?.find((p) => p.id === programId);
  return !program || program.source !== draft;
}

/** Fields whose change must reach the UI in the same task, never a frame later. */
function isImmediate(next: SimulatorState, previous: SimulatorState): boolean {
  return (
    next.status !== previous.status ||
    next.sessionId !== previous.sessionId ||
    next.diagnostics.length !== previous.diagnostics.length ||
    next.allowed.length !== previous.allowed.length ||
    next.allowed.some((command, index) => command !== previous.allowed[index])
  );
}

let mirrored: SimulatorState = controller.getState();
let pendingState: SimulatorState | null = null;
let frame = 0;

const nextFrame: (run: () => void) => number =
  typeof requestAnimationFrame === 'function' ? (run) => requestAnimationFrame(run) : (run) => setTimeout(run, 16) as unknown as number;
const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function' ? (handle) => cancelAnimationFrame(handle) : (handle) => clearTimeout(handle);

function flushMirror(): void {
  frame = 0;
  const state = pendingState;
  pendingState = null;
  if (state) useSimulatorStore.setState({ ...state });
}

controller.subscribe((state) => {
  const immediate = isImmediate(state, mirrored);
  mirrored = state;
  if (immediate) {
    if (frame !== 0) cancelFrame(frame);
    pendingState = state;
    flushMirror();
    return;
  }
  pendingState = state;
  if (frame === 0) frame = nextFrame(flushMirror);
});

// Topology edits are refused by the design store while a session is prepared or executing.
setTopologyGuard(() => controller.getState().canEditTopology);

// Any design change invalidates a live session (stale snapshot) and reconciles editor drafts.
useStore.subscribe((state, previous) => {
  if (state.design === previous.design) return;
  if (controller.designChanged(state.design)) state.toast('info', '设计已修改，仿真会话已停止（快照过期）');

  const sim = useSimulatorStore.getState();
  const programs = state.design.programs ?? [];
  const patch: Partial<SimulatorUiState> = {};
  if (state.documentGeneration !== previous.documentGeneration) {
    // A different document: a draft written for the old project must never be saved into the new one,
    // even when both use the same program id (program_main, program_1, …).
    useSimulatorStore.setState({ drafts: {}, editorOpen: false, editorProgramId: null });
    return;
  }
  let drafts: Record<string, string> | null = null;
  for (const [id, text] of Object.entries(sim.drafts)) {
    const program = programs.find((p) => p.id === id);
    // Drop drafts that became clean (save/undo) or whose program no longer exists (delete/new project).
    if (!program || program.source === text) {
      drafts ??= { ...sim.drafts };
      delete drafts[id];
    }
  }
  if (drafts) patch.drafts = drafts;
  if (sim.editorOpen && sim.editorProgramId && !programs.some((p) => p.id === sim.editorProgramId)) {
    patch.editorOpen = false;
    patch.editorProgramId = null;
  }
  if (Object.keys(patch).length) useSimulatorStore.setState(patch);
});
