/**
 * State of the connection to a real board (阶段 5 RFC §5.1).
 *
 * Kept in its own store, next to but never inside the simulator's. The two must not
 * be confused: the simulator has a virtual clock, deterministic replay and modelled
 * devices; this has a cable. Sharing a store would be the first step towards
 * pretending they are the same thing.
 */
import { create } from 'zustand';
import { useStore } from '../store';
import { browserSerialLink } from './browser-serial';
import { appendLines, detectSerialSupport, DEFAULT_BAUD, type SerialLine, type SerialLink } from './serial-link';

export type HardwareStatus = 'disconnected' | 'connecting' | 'connected';

export interface HardwareState {
  status: HardwareStatus;
  baudRate: number;
  lines: SerialLine[];
  /** Last failure, in the user's terms; cleared on the next successful action. */
  error: string | null;
  support: ReturnType<typeof detectSerialSupport>;

  setBaudRate: (baudRate: number) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  pulseReset: () => Promise<void>;
  clear: () => void;
}

/** Injected by the tests; the real one is created on first connect. */
let link: SerialLink | null = null;
let factory: ((options: Parameters<typeof browserSerialLink>[0]) => SerialLink) | null = null;

/** Test seam: swap in a fake link. Passing null restores the browser one. */
export function setSerialLinkFactory(next: typeof factory): void {
  factory = next;
  link = null;
}

/** Wall-clock stamp. Real hardware has no virtual clock — that is the whole point. */
const now = (): number => Date.now();

export const useHardwareStore = create<HardwareState>((set, get) => ({
  status: 'disconnected',
  baudRate: DEFAULT_BAUD,
  lines: [],
  error: null,
  support: detectSerialSupport(),

  setBaudRate(baudRate) {
    set({ baudRate });
  },

  async connect() {
    if (get().status !== 'disconnected') return;
    const support = get().support;
    if (!support.supported) {
      set({ error: support.message });
      return;
    }
    set({ status: 'connecting', error: null });
    const make = factory ?? browserSerialLink;
    link = make({
      onLines: (incoming) => {
        const stamped = incoming.map((text) => ({ text, atMs: now() }));
        set({ lines: appendLines(get().lines, stamped) });
      },
      onClosed: (reason) => {
        link = null;
        set({ status: 'disconnected', ...(reason ? { error: `连接已断开：${reason}` } : {}) });
      }
    });
    try {
      await link.open(get().baudRate);
      set({ status: 'connected' });
    } catch (e) {
      link = null;
      // A cancelled picker is the common case and is not an error worth shouting about.
      const message = (e as Error).message ?? String(e);
      set({ status: 'disconnected', error: /No port selected|cancel/i.test(message) ? '没有选择串口。' : `连接失败：${message}` });
    }
  },

  async disconnect() {
    const active = link;
    link = null;
    set({ status: 'disconnected' });
    if (active) await active.close();
  },

  async pulseReset() {
    if (!link || get().status !== 'connected') return;
    try {
      await link.pulseReset();
      set({ error: null });
    } catch (e) {
      set({ error: `复位失败：${(e as Error).message}` });
    }
  },

  clear() {
    set({ lines: [], error: null });
  }
}));

/**
 * Leaving 实机 hangs up.
 *
 * The panel *is* the connection: a port that stays claimed while the user is looking
 * at something else is a surprise — the browser keeps showing the tab as connected to
 * a device, and nothing on screen says why. Reconnecting is one click, so the
 * surprise costs more than the convenience.
 */
useStore.subscribe((state, previous) => {
  if (state.mode === previous.mode || previous.mode !== 'hardware') return;
  if (useHardwareStore.getState().status !== 'disconnected') void useHardwareStore.getState().disconnect();
});
