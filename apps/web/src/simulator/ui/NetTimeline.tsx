/**
 * Waveforms of the recent past (阶段 4).
 *
 * The net monitor beside it shows the current value, which cannot answer the
 * question people actually have: *did that pulse happen?* A 500 µs blink is invisible
 * in a table of current values and obvious as a square wave.
 *
 * Edges arrive on their own protocol channel, bounded at both ends (worker buffer,
 * controller history) and with an explicit drop count, so a gap in the picture is
 * always labelled rather than silently smoothed over.
 */
import { useMemo } from 'react';
import type { NetTransition } from '@breadboard-studio/sim';
import { useSimulatorStore } from '../simulatorStore';
import { fractionOf, isIndeterminate, levelOf, netsInTrace, segmentsFor, timelineWindow } from './timeline-geometry';

/** How much virtual time a strip shows, and how many nets are worth drawing at once. */
const SPAN_US = 2_000_000;
const MAX_NETS = 8;

const STRIP_HEIGHT = 22;
const PADDING = 3;

function label(netId: string, names: Record<string, string>): string {
  return names[netId] ?? netId.replace(/^net_/, '');
}

function Strip({ netId, trace, window }: { netId: string; trace: readonly NetTransition[]; window: ReturnType<typeof timelineWindow> }) {
  const segments = segmentsFor(trace, netId, window);
  const y = (value: Parameters<typeof levelOf>[0]) => PADDING + (1 - levelOf(value)) * (STRIP_HEIGHT - 2 * PADDING);
  const x = (atUs: number) => fractionOf(atUs, window) * 100;

  // One polyline per strip: horizontal runs joined by the vertical edges between
  // them, which is what makes a transition read as a transition.
  const points: string[] = [];
  segments.forEach((segment, i) => {
    if (i > 0) points.push(`${x(segment.fromUs)},${y(segment.value)}`);
    points.push(`${x(segment.fromUs)},${y(segment.value)}`, `${x(segment.toUs)},${y(segment.value)}`);
  });

  return (
    <div className="sim-strip" data-testid={`sim-strip-${netId}`} data-segments={segments.length}>
      <svg viewBox={`0 0 100 ${STRIP_HEIGHT}`} preserveAspectRatio="none" role="img">
        {segments.map((segment) =>
          isIndeterminate(segment.value) ? (
            <rect
              key={`${segment.fromUs}-${segment.value}`}
              x={x(segment.fromUs)}
              y={PADDING}
              width={Math.max(0.2, x(segment.toUs) - x(segment.fromUs))}
              height={STRIP_HEIGHT - 2 * PADDING}
              className={segment.value === 'X' ? 'sim-strip-x' : 'sim-strip-z'}
            />
          ) : null
        )}
        <polyline points={points.join(' ')} />
      </svg>
    </div>
  );
}

export function NetTimeline() {
  const trace = useSimulatorStore((s) => s.trace);
  const dropped = useSimulatorStore((s) => s.traceDropped);
  const nowUs = useSimulatorStore((s) => s.nowUs);
  const nets = useSimulatorStore((s) => s.nets);
  const breakpoints = useSimulatorStore((s) => s.breakpoints);

  const names = useMemo(() => Object.fromEntries(nets.filter((n) => n.name).map((n) => [n.netId, n.name!])), [nets]);
  const window = useMemo(() => timelineWindow(trace, nowUs, SPAN_US), [trace, nowUs]);
  const shown = useMemo(() => netsInTrace(trace, MAX_NETS), [trace]);

  if (!shown.length) {
    return (
      <p className="muted small" data-testid="sim-timeline-empty">
        还没有电平变化。运行程序后，每一条网络的跳变都会画在这里。
      </p>
    );
  }

  return (
    <div className="sim-timeline" data-testid="sim-timeline">
      <div className="sim-timeline-scale muted small">
        最近 {((window.endUs - window.startUs) / 1000).toFixed(0)} ms
        {dropped > 0 && <span className="sim-timeline-dropped"> · 已丢弃 {dropped} 次跳变（缓冲区上限）</span>}
      </div>
      {shown.map((netId) => (
        <div className="sim-strip-row" key={netId}>
          {/* The name is the breakpoint control: one click to stop on this net's
              next edge, which is the only thing anyone wants to break on here. */}
          <button
            className={`sim-strip-name${breakpoints.includes(netId) ? ' armed' : ''}`}
            title={breakpoints.includes(netId) ? '取消断点' : '在这条网络下次跳变时暂停'}
            aria-pressed={breakpoints.includes(netId)}
            onClick={() => useSimulatorStore.getState().toggleBreakpoint(netId)}
            data-testid={`sim-break-${netId}`}
          >
            {breakpoints.includes(netId) ? '● ' : ''}
            {label(netId, names)}
          </button>
          <Strip netId={netId} trace={trace} window={window} />
        </div>
      ))}
    </div>
  );
}
