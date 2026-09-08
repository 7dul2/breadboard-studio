/**
 * Side channel for display pixels (plan §9.2).
 *
 * A 0.96" OLED frame is 8,192 bytes and arrives up to 21 times a second. That
 * must never reach zustand: the controller merges `visual-diff` states into the
 * session state and the store mirrors the whole thing, so a `Uint8Array` in
 * there would be copied into React state on every frame.
 *
 * So `WorkerBackend` splits the message in two: the real pixels go to this bus,
 * and the state handed to the controller keeps only the cheap summary
 * (`onPixels`, `sha`) plus a shared zero-length array. `OledScreen` subscribes
 * to the bus through a ref and writes the canvas outside React.
 *
 * M-S1 has no display driver yet, so nothing publishes here. The seam exists
 * now because the stripping has to happen in `WorkerBackend` from the very
 * first frame — retrofitting it later means one release where the pixels do
 * land in the store.
 */
import type { DeviceVisualState } from '@breadboard-studio/sim';

/** Shared empty array: every stripped display state points at this one object. */
export const EMPTY_PIXELS: Uint8Array = new Uint8Array(0);

/** One display frame, as it left the worker. */
export interface DisplayFrame {
  componentId: string;
  feature: string;
  width: number;
  height: number;
  enabled: boolean;
  color: string;
  pixels: Uint8Array;
  /** Number of non-zero pixels; the cheap "is anything on screen" signal. */
  onPixels: number;
  /** Content hash, so a test can compare two frames without moving 8 KB. */
  sha: string;
  /** Worker-side frame counter of the `visual-diff` this came from. */
  revision: number;
}

/** A display state after the pixels have been taken out of it. */
export type StrippedDisplayState = Extract<DeviceVisualState, { kind: 'display' }> & { onPixels: number; sha: string };

/** FNV-1a over the pixel bytes. Not cryptographic — an identity check for tests. */
export function pixelSha(pixels: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) {
    hash ^= pixels[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function countOnPixels(pixels: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== 0) count++;
  return count;
}

type Listener = (frame: DisplayFrame) => void;

class VisualBus {
  private readonly frames = new Map<string, DisplayFrame>();
  private readonly listeners = new Map<string, Set<Listener>>();

  /** Latest frame for a component, or null when it has never sent one. */
  read(componentId: string): DisplayFrame | null {
    return this.frames.get(componentId) ?? null;
  }

  publish(frame: DisplayFrame): void {
    this.frames.set(frame.componentId, frame);
    const listeners = this.listeners.get(frame.componentId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(frame);
  }

  /** Subscribe to one component. The current frame, if any, is delivered at once. */
  subscribe(componentId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(componentId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(componentId, listeners);
    const current = this.frames.get(componentId);
    if (current) listener(current);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(componentId);
    };
  }

  /** Drop every frame. Called when a session ends so a new one starts blank. */
  clear(): void {
    this.frames.clear();
  }
}

export const visualBus = new VisualBus();

/**
 * Move the pixels of every display state onto the bus and return the states the
 * controller may keep. Non-display channels pass through untouched.
 */
export function divertDisplayPixels(
  states: Record<string, DeviceVisualState[]>,
  revision: number,
  bus: Pick<VisualBus, 'publish'> = visualBus
): Record<string, DeviceVisualState[]> {
  let changed = false;
  const out: Record<string, DeviceVisualState[]> = {};
  for (const [componentId, list] of Object.entries(states)) {
    out[componentId] = list.map((state) => {
      if (state.kind !== 'display') return state;
      changed = true;
      const pixels = state.pixels instanceof Uint8Array ? state.pixels : new Uint8Array(0);
      const onPixels = countOnPixels(pixels);
      const sha = pixelSha(pixels);
      bus.publish({
        componentId,
        feature: state.feature,
        width: state.width,
        height: state.height,
        enabled: state.enabled,
        color: state.color,
        pixels,
        onPixels,
        sha,
        revision
      });
      const stripped: StrippedDisplayState = { ...state, pixels: EMPTY_PIXELS, onPixels, sha };
      return stripped;
    });
  }
  return changed ? out : states;
}
