/**
 * Pure geometry and pairing for the canvas simulator overlay (plan §9.2, §9.3).
 *
 * Everything here is deliberately free of React and of the DOM: `vitest` runs
 * with `environment: 'node'` and there is no jsdom in the repo (plan §11.4), so
 * the component layer cannot be unit tested at all. What *can* be tested is the
 * arithmetic and the pairing rules, and that is exactly what lives in this file.
 *
 * Two rules the overlay depends on:
 *
 * 1. Coordinates come from `def.features[].rect_um` converted with `mm()`, never
 *    from `getBoundingClientRect()`. `scene.ts` emits component `path`
 *    primitives whose `d` is still in µm, so the rendered group box is wrong —
 *    a pre-existing bug that this milestone does not fix, only avoids.
 * 2. Rects stay in the definition's local, unrotated frame. Rotation and
 *    translation are applied once by the enclosing
 *    `<g transform={transformAttr(pc.transform)}>`, the same transform
 *    `componentScene` uses, so a rotated part needs no special case here.
 */
import type { ComponentDefinition, SimulationControlAction } from '@breadboard-studio/schema';
import type { DeviceVisualState } from '@breadboard-studio/sim';
import { mm } from '@breadboard-studio/render';

/** A feature rect in the millimetre user space the canvas draws in. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayCircle {
  cx: number;
  cy: number;
  r: number;
}

/** Just enough of a component definition to place an overlay; keeps the tests small. */
export type FeatureSource = Pick<ComponentDefinition, 'features'> & {
  simulation?: Pick<NonNullable<ComponentDefinition['simulation']>, 'controls'> | undefined;
};

export type OverlayVisual =
  | { kind: 'led'; feature: string; rect: OverlayRect; circle: OverlayCircle; fill: string; opacity: number }
  | { kind: 'pressed'; feature: string; rect: OverlayRect; active: boolean };

export interface OverlayControl {
  controlId: string;
  action: SimulationControlAction;
  feature: string;
  rect: OverlayRect;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The drawable rect of the feature labelled `label`, in mm, or null when the
 * definition has no such label or the label carries no usable rect. A driver may
 * report a visual for a feature the catalog never drew (or drew without
 * geometry); that is not an error, the overlay simply has nothing to paint.
 */
export function featureRect(def: FeatureSource, label: string): OverlayRect | null {
  for (const feature of def.features ?? []) {
    if (feature.label !== label) continue;
    const rect = feature.rect_um;
    if (!rect || !finite(rect.x) || !finite(rect.y) || !finite(rect.w) || !finite(rect.h)) continue;
    if (rect.w <= 0 || rect.h <= 0) continue;
    return { x: mm(rect.x), y: mm(rect.y), width: mm(rect.w), height: mm(rect.h) };
  }
  return null;
}

/** Largest circle that fits inside `rect` — how an LED feature is drawn. */
export function inscribedCircle(rect: OverlayRect): OverlayCircle {
  return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, r: Math.min(rect.width, rect.height) / 2 };
}

const channel = (value: number): number => (Number.isFinite(value) ? Math.min(255, Math.max(0, Math.round(value))) : 0);

/** `rgb()` string for an LED colour; out-of-range and non-finite channels clamp instead of producing invalid CSS. */
export function rgbFill(rgb: readonly [number, number, number]): string {
  return `rgb(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])})`;
}

/** LED brightness → SVG opacity, clamped to [0, 1] (a driver may report 0/1 or a fraction). */
export function clampIntensity(intensity: number): number {
  if (!Number.isFinite(intensity)) return 0;
  return Math.min(1, Math.max(0, intensity));
}

/**
 * Pair the runtime visual states of one component with the feature rects of its
 * definition, matching `DeviceVisualState.feature` against `features[].label`.
 *
 * Dropped on purpose: `display` states (they need a canvas in a
 * `<foreignObject>`, M-S3) and any state whose feature label has no rect. When
 * a component reports the same (kind, feature) twice in one frame the last one
 * wins, so the result can be keyed by `kind:feature` without React duplicates.
 */
export function overlayVisuals(def: FeatureSource, states: readonly DeviceVisualState[] | undefined): OverlayVisual[] {
  if (!states?.length) return [];
  const byKey = new Map<string, OverlayVisual>();
  for (const state of states) {
    if (state.kind !== 'led' && state.kind !== 'pressed') continue;
    const rect = featureRect(def, state.feature);
    if (!rect) continue;
    const key = `${state.kind}:${state.feature}`;
    if (state.kind === 'led') {
      byKey.set(key, { kind: 'led', feature: state.feature, rect, circle: inscribedCircle(rect), fill: rgbFill(state.rgb), opacity: clampIntensity(state.intensity) });
    } else {
      byKey.set(key, { kind: 'pressed', feature: state.feature, rect, active: state.active === true });
    }
  }
  return [...byKey.values()];
}

/**
 * Hit areas for the controls this component declares. `slider` controls are not
 * drawn on the canvas in this milestone (plan §9.3), and a control whose feature
 * label has no rect has nowhere to be clicked.
 */
export function overlayControls(def: FeatureSource): OverlayControl[] {
  const out: OverlayControl[] = [];
  for (const control of def.simulation?.controls ?? []) {
    if (control.action === 'slider') continue;
    const rect = featureRect(def, control.feature_label);
    if (!rect) continue;
    out.push({ controlId: control.id, action: control.action, feature: control.feature_label, rect });
  }
  return out;
}

/** Stable test id for one control hit area; `e2e/sim-input.spec.ts` clicks these. */
export function controlTestId(componentId: string, controlId: string): string {
  return `sim-control-${componentId}:${controlId}`;
}

/** Stable test id for one painted visual. */
export function visualTestId(componentId: string, kind: string, feature: string): string {
  return `sim-visual-${componentId}:${kind}:${feature}`;
}
