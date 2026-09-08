import { useStore, analysisOf } from './store';
import { designHash } from '@breadboard-studio/core';
import { isDraftDirty, useSimulatorStore } from './simulator/simulatorStore';

declare global {
  interface Window {
    __bbs?: {
      getDesign: () => unknown;
      getAnalysis: () => { results: unknown[]; nets: unknown[]; summary: unknown; hash: string };
      apply: (ops: unknown[]) => unknown;
      importJson: (text: string) => unknown;
      state: () => unknown;
      simulator: () => {
        status: string;
        sessionId: string | null;
        programId: string | null;
        allowed: string[];
        diagnostics: { code: string; severity: string; message: string }[];
        editorOpen: boolean;
        dirty: boolean;
      };
    };
  }
}

/** Exposes a small, read-mostly API for end-to-end tests to verify real state instead of screenshots. */
export function installTestHooks(): void {
  window.__bbs = {
    getDesign: () => useStore.getState().design,
    getAnalysis: () => {
      const d = useStore.getState().design;
      const a = analysisOf(d);
      return { results: a.results, nets: a.connectivity.nets, summary: a.summary, hash: designHash(d) };
    },
    apply: (ops) => useStore.getState().apply(ops as never, '测试'),
    importJson: (text) => useStore.getState().importJson(text),
    state: () => {
      const s = useStore.getState();
      return { selectedIds: s.selectedIds, selectedHole: s.selectedHole, tool: s.tool, storage: s.storage, dslDirty: s.dslDirty, buildMode: s.buildMode, past: s.past.length, future: s.future.length };
    },
    simulator: () => {
      const s = useSimulatorStore.getState();
      return {
        status: s.status,
        sessionId: s.sessionId,
        programId: s.programId,
        allowed: [...s.allowed],
        diagnostics: s.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
        editorOpen: s.editorOpen,
        dirty: isDraftDirty(s.editorProgramId)
      };
    }
  };
}
