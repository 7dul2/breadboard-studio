/**
 * Canvas overlay for a running session (plan §9.2 visuals, §9.3 hit areas).
 *
 * It is drawn *after* `{overlays}` inside the same `translate/scale` group in
 * `Canvas.tsx`, because the last painter wins `elementFromPoint`, and each part
 * gets one `<g transform={transformAttr(pc.transform)}>` so definition-local
 * feature rects land exactly on the part — see `overlay-geometry.ts` for why
 * `getBoundingClientRect()` is not usable here.
 *
 * The overlay mounts only while a session executes (`running` / `paused` /
 * `stepping`). That is the milestone's rollback switch and the precondition for
 * acceptance ④ (plan §11.2): in the editor the touch pad must keep letting
 * clicks through to the breadboard, so marquee selection and dragging behave
 * exactly as before. Controls stay reachable without any overlay through
 * `window.__bbs.simulatorControl()`.
 *
 * It never calls `select()` / `selectHole()`: operating a button must not change
 * the selection (spec §11.3). `stopPropagation` on `pointerdown` keeps
 * `Canvas.onPointerDown` from selecting or starting a drag, and the one on
 * `click` keeps the wire tool from dropping a wire — the browser still emits a
 * click after a captured pointer sequence.
 */
import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { DesignModel } from '@breadboard-studio/core';
import { transformAttr } from '@breadboard-studio/render';
import { useSimulatorStore } from '../simulatorStore';
import { controlTestId, overlayControls, overlayVisuals, visualTestId, type FeatureSource, type OverlayControl } from './overlay-geometry';

/** Statuses in which the runtime accepts control events and paints visuals. */
const LIVE = new Set(['running', 'paused', 'stepping']);

interface Props {
  model: DesignModel;
}

export function SimulatorOverlay({ model }: Props) {
  const status = useSimulatorStore((s) => s.status);
  const visuals = useSimulatorStore((s) => s.visuals);
  /** Value last sent per `componentId:controlId`, so repeated release events are not re-sent. */
  const held = useRef(new Map<string, boolean>());

  const send = useCallback((componentId: string, controlId: string, value: boolean): void => {
    const key = `${componentId}:${controlId}`;
    // `pointerup` and `lostpointercapture` both fire for one release; the second
    // one has nothing left to say. A refused send is not remembered, so the next
    // attempt still goes through.
    if (held.current.get(key) === value) return;
    if (useSimulatorStore.getState().sendControl(componentId, controlId, value)) held.current.set(key, value);
    else held.current.delete(key);
  }, []);

  // Controls come straight from the catalog definition: the main thread can read
  // it, so they do not have to travel through the snapshot. Parts without a
  // `simulation` block have no driver, hence neither controls nor visuals.
  const parts = useMemo(() => {
    const list: { componentId: string; def: FeatureSource; transform: string; controls: OverlayControl[] }[] = [];
    for (const pc of model.components.values()) {
      if (!pc.def.simulation) continue;
      list.push({ componentId: pc.instance.id, def: pc.def, transform: transformAttr(pc.transform), controls: overlayControls(pc.def) });
    }
    return list;
  }, [model]);

  if (!LIVE.has(status)) return null;

  return (
    <g className="sim-overlay" data-testid="sim-overlay">
      {parts.map((part) => {
        const painted = overlayVisuals(part.def, visuals[part.componentId]);
        if (!painted.length && !part.controls.length) return null;
        return (
          <g key={part.componentId} transform={part.transform} data-sim-part={part.componentId}>
            {painted.map((visual) =>
              visual.kind === 'led' ? (
                <circle
                  key={`led:${visual.feature}`}
                  className="sim-visual sim-visual-led"
                  cx={visual.circle.cx}
                  cy={visual.circle.cy}
                  r={visual.circle.r}
                  fill={visual.fill}
                  opacity={visual.opacity}
                  data-testid={visualTestId(part.componentId, 'led', visual.feature)}
                />
              ) : (
                <rect
                  key={`pressed:${visual.feature}`}
                  className="sim-visual sim-visual-pressed"
                  x={visual.rect.x}
                  y={visual.rect.y}
                  width={visual.rect.width}
                  height={visual.rect.height}
                  rx={0.4}
                  data-active={visual.active ? 'true' : 'false'}
                  data-testid={visualTestId(part.componentId, 'pressed', visual.feature)}
                />
              )
            )}
            {part.controls.map((control) => (
              <ControlHit key={control.controlId} componentId={part.componentId} control={control} send={send} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

interface ControlProps {
  componentId: string;
  control: OverlayControl;
  send: (componentId: string, controlId: string, value: boolean) => void;
}

function ControlHit({ componentId, control, send }: ControlProps) {
  // `toggle` flips on press and ignores the release; `press` / `touch` follow the finger.
  const toggled = useRef(false);

  const down = (e: ReactPointerEvent<SVGRectElement>): void => {
    e.stopPropagation();
    // Capture on the rect itself: the pointer may leave the small hit area
    // before it is released, and the release must still reach this control.
    e.currentTarget.setPointerCapture(e.pointerId);
    if (control.action === 'toggle') {
      toggled.current = !toggled.current;
      send(componentId, control.controlId, toggled.current);
      return;
    }
    send(componentId, control.controlId, true);
  };

  const release = (e: ReactPointerEvent<SVGRectElement>): void => {
    e.stopPropagation();
    if (control.action === 'toggle') return;
    send(componentId, control.controlId, false);
  };

  return (
    <rect
      className={`sim-control sim-control-${control.action}`}
      x={control.rect.x}
      y={control.rect.y}
      width={control.rect.width}
      height={control.rect.height}
      fill="transparent"
      stroke="none"
      data-testid={controlTestId(componentId, control.controlId)}
      data-sim-control={control.controlId}
      onPointerDown={down}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <title>{`${control.feature}（仿真控件）`}</title>
    </rect>
  );
}
