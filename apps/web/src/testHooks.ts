import { useStore, analysisOf } from './store';
import { designHash } from '@breadboard-studio/core';
import type { DeviceVisualState } from '@breadboard-studio/sim';
import { isDraftDirty, useSimulatorStore } from './simulator/simulatorStore';
import type { StrippedDisplayState } from './simulator/runtime/visualBus';

/**
 * What a device looks like on the canvas, as far as a test can tell.
 *
 * The display variant deliberately carries no pixels: they never enter the
 * store (plan §9.2), and a `Uint8Array` cannot cross `page.evaluate` anyway, so
 * a test compares `onPixels` / `sha` instead.
 */
export type SimVisualHook =
  | { kind: 'led'; feature: string; rgb: [number, number, number]; intensity: number }
  | { kind: 'display'; feature: string; width: number; height: number; enabled: boolean; onPixels: number; sha: string; storedPixelBytes: number }
  | { kind: 'pressed'; feature: string; active: boolean };

export interface SimulatorHookState {
  status: string;
  sessionId: string | null;
  programId: string | null;
  nowUs: number;
  speed: number;
  canEditTopology: boolean;
  trace: { netId: string; atUs: number; value: string | number }[];
  traceDropped: number;
  allowed: string[];
  droppedMessages: number;
  diagnostics: {
    code: string;
    severity: string;
    message: string;
    atUs?: number;
    componentIds?: string[];
    netIds?: string[];
    pinAddresses?: string[];
    source?: { programId: string; line: number; column: number };
  }[];
  serial: { componentId: string; stream: string; text: string; atUs: number }[];
  nets: { netId: string; name?: string; value: string | number; drivers: { componentId: string; pin: string; value: string | number; strength: string }[] }[];
  visuals: Record<string, SimVisualHook[]>;
  editorOpen: boolean;
  dirty: boolean;
}

declare global {
  interface Window {
    __bbs?: {
      getDesign: () => unknown;
      getAnalysis: () => { results: unknown[]; nets: unknown[]; summary: unknown; hash: string };
      apply: (ops: unknown[]) => unknown;
      importJson: (text: string) => unknown;
      state: () => unknown;
      simulator: () => SimulatorHookState;
      simulatorControl: (componentId: string, controlId: string, value: boolean | number) => boolean;
    };
  }
}

function visualHook(state: DeviceVisualState): SimVisualHook {
  if (state.kind === 'display') {
    const stripped = state as StrippedDisplayState;
    return {
      kind: 'display',
      feature: stripped.feature,
      width: stripped.width,
      height: stripped.height,
      enabled: stripped.enabled,
      onPixels: stripped.onPixels ?? 0,
      sha: stripped.sha ?? '',
      // The claim under test: the store keeps a zero-length array, never the frame.
      // Reading `.length` here is the only way an e2e can see what the store holds.
      storedPixelBytes: stripped.pixels?.length ?? -1
    };
  }
  if (state.kind === 'led') return { kind: 'led', feature: state.feature, rgb: [...state.rgb] as [number, number, number], intensity: state.intensity };
  return { kind: 'pressed', feature: state.feature, active: state.active };
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
      return { selectedIds: s.selectedIds, selectedHole: s.selectedHole, tool: s.tool, mode: s.mode, rightTab: s.rightTab, hasClipboard: !!s.clipboard, storage: s.storage, dslDirty: s.dslDirty, past: s.past.length, future: s.future.length };
    },
    simulator: () => {
      const s = useSimulatorStore.getState();
      const visuals: Record<string, SimVisualHook[]> = {};
      for (const [componentId, states] of Object.entries(s.visuals)) visuals[componentId] = states.map(visualHook);
      return {
        status: s.status,
        sessionId: s.sessionId,
        programId: s.programId,
        nowUs: s.nowUs,
        speed: s.speed,
        canEditTopology: s.canEditTopology,
        trace: s.trace.map((t) => ({ netId: t.netId, atUs: t.atUs, value: t.value })),
        traceDropped: s.traceDropped,
        allowed: [...s.allowed],
        droppedMessages: s.droppedMessages,
        diagnostics: s.diagnostics.map((d) => ({
          code: d.code,
          severity: d.severity,
          message: d.message,
          ...(d.atUs === undefined ? {} : { atUs: d.atUs }),
          ...(d.componentIds ? { componentIds: [...d.componentIds] } : {}),
          ...(d.netIds ? { netIds: [...d.netIds] } : {}),
          ...(d.pinAddresses ? { pinAddresses: [...d.pinAddresses] } : {}),
          ...(d.source ? { source: { ...d.source } } : {})
        })),
        serial: s.serial.map((line) => ({ componentId: line.componentId, stream: line.stream, text: line.text, atUs: line.atUs })),
        nets: s.nets.map((net) => ({
          netId: net.netId,
          ...(net.name === undefined ? {} : { name: net.name }),
          value: net.value,
          drivers: net.drivers.map((driver) => ({ componentId: driver.componentId, pin: driver.pin, value: driver.value, strength: driver.strength }))
        })),
        visuals,
        editorOpen: s.editorOpen,
        dirty: isDraftDirty(s.editorProgramId)
      };
    },
    /**
     * Inject a control event without going through the canvas overlay: the same
     * entry point the overlay uses (plan §9.9), so an e2e test can replay a
     * press faster than a real pointer and can assert the negative cases
     * (unknown control, no running session) where false comes back.
     */
    simulatorControl: (componentId, controlId, value) => useSimulatorStore.getState().sendControl(componentId, controlId, value)
  };
}
