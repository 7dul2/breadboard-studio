/**
 * Zustand wrapper around one SimulatorController (docs §11–§12). The store
 * mirrors the controller state and adds the UI-only bits: the code editor
 * drawer and unsaved drafts. No backend exists in this phase, so `run`
 * honestly ends in `faulted · runtime_unavailable`.
 */
import { create } from 'zustand';
import type { SimulationSpeed } from '@breadboard-studio/schema';
import { SimulatorController, type CommandResult, type SimulatorState } from '@breadboard-studio/sim';
import { setTopologyGuard, useStore } from '../store';

export const EDITOR_MIN_HEIGHT = 120;
export const EDITOR_DEFAULT_HEIGHT = 280;

export interface SimulatorUiState extends SimulatorState {
  editorOpen: boolean;
  editorProgramId: string | null;
  /** Unsaved editor text per program id; absent when the editor shows the saved source. */
  drafts: Record<string, string>;
  editorHeight: number;

  run: () => Promise<void>;
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

const controller = new SimulatorController();

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

  async run() {
    // A faulted session cannot be resumed; start a fresh one from the current design.
    if (controller.getState().status === 'faulted') await controller.stop();
    report(await controller.run(useStore.getState().design), '运行');
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

controller.subscribe((state) => {
  useSimulatorStore.setState({ ...state });
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
