/**
 * Pure geometry for the net timeline (阶段 4).
 *
 * The net monitor answers "what is this net now". The timeline answers "what did it
 * just do" — the question you actually have when a pulse is too short to see or a
 * program misbehaves once a second. Everything here is arithmetic over the edge
 * list, kept free of React and the DOM so it can be unit-tested under
 * `environment: 'node'` (there is still no jsdom in the repo).
 */
import type { DigitalValue, NetTransition } from '@breadboard-studio/sim';

/** One constant stretch of a net, in virtual time. */
export interface TimelineSegment {
  fromUs: number;
  toUs: number;
  value: DigitalValue;
}

export interface TimelineWindow {
  startUs: number;
  endUs: number;
}

/**
 * The stretch of virtual time to draw. It ends at `nowUs` and is `spanUs` wide, but
 * never starts before the oldest edge we still hold — otherwise a fresh session
 * would show a long empty run that looks like a stalled net rather than a young one.
 */
export function timelineWindow(trace: readonly NetTransition[], nowUs: number, spanUs: number): TimelineWindow {
  const oldest = trace.length ? trace[0]!.atUs : nowUs;
  const startUs = Math.max(oldest, nowUs - spanUs);
  // A zero-width window would divide by zero downstream; one microsecond is enough.
  return { startUs, endUs: Math.max(startUs + 1, nowUs) };
}

/** Nets with at least one edge, most recently active first, capped at `limit`. */
export function netsInTrace(trace: readonly NetTransition[], limit: number): string[] {
  const lastSeen = new Map<string, number>();
  for (const t of trace) lastSeen.set(t.netId, t.atUs);
  return [...lastSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([netId]) => netId);
}

/**
 * The value of `netId` before the window opens: the last edge at or before
 * `startUs`. Without it a net that has been high for a minute would be drawn as
 * undefined until its next edge, which is exactly backwards.
 */
export function valueBefore(trace: readonly NetTransition[], netId: string, startUs: number): DigitalValue {
  let value: DigitalValue = 'Z';
  for (const t of trace) {
    if (t.netId !== netId) continue;
    if (t.atUs > startUs) break;
    value = t.value;
  }
  return value;
}

/**
 * Constant stretches of one net across the window, in order and without gaps. Edges
 * outside the window are used for context but never produce a segment of their own.
 */
export function segmentsFor(trace: readonly NetTransition[], netId: string, window: TimelineWindow): TimelineSegment[] {
  const edges = trace.filter((t) => t.netId === netId && t.atUs > window.startUs && t.atUs <= window.endUs);
  const out: TimelineSegment[] = [];
  let fromUs = window.startUs;
  let value = valueBefore(trace, netId, window.startUs);
  for (const edge of edges) {
    if (edge.atUs > fromUs) out.push({ fromUs, toUs: edge.atUs, value });
    fromUs = edge.atUs;
    value = edge.value;
  }
  if (window.endUs > fromUs) out.push({ fromUs, toUs: window.endUs, value });
  return out;
}

/** Fraction of the window a moment sits at, clamped to [0, 1]. */
export function fractionOf(atUs: number, window: TimelineWindow): number {
  const span = window.endUs - window.startUs;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (atUs - window.startUs) / span));
}

/**
 * Vertical position of a value inside a strip of height `height`, as a fraction:
 * 1 sits at the top, 0 at the bottom, and the indeterminate values in the middle
 * where they cannot be mistaken for either.
 */
export function levelOf(value: DigitalValue): number {
  if (value === 1) return 1;
  if (value === 0) return 0;
  return 0.5;
}

/** `Z` and `X` are drawn differently because they mean "nobody" and "everybody". */
export function isIndeterminate(value: DigitalValue): boolean {
  return value === 'Z' || value === 'X';
}
