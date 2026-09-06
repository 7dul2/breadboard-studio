import type { BodyDef, ComponentDefinition, JsonValue, PinDef, PinMeta, PointUm, RenderPrimitiveDef } from '@breadboard-studio/schema';
import { validateAgainst } from '@breadboard-studio/schema';
import { PITCH_UM, type Rect } from './geometry.js';

export type MountOrientation = 'upright' | 'flat';

export interface ResolvedComponent {
  def: ComponentDefinition;
  params: Record<string, JsonValue>;
  config: Record<string, JsonValue>;
  pins: PinDef[];
  body: BodyDef;
  /** Local rect that blocks holes / collides with other bodies. */
  footprint: Rect;
  /** Local rect of the drawn outline (may be larger than footprint for upright modules). */
  outline: Rect;
  orientation: MountOrientation;
  render: RenderPrimitiveDef[];
  issues: string[];
}

export function pinMetaOf(def: ComponentDefinition, pinName: string): PinMeta {
  return def.pin_meta[pinName] ?? { role: 'unknown' };
}

function asNumber(v: JsonValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStringArray(v: JsonValue | undefined): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

function asPoint(v: JsonValue | undefined, fallback: PointUm): PointUm {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') return [v[0], v[1]];
  return fallback;
}

function mergeDefaults(defaults: Record<string, JsonValue> | undefined, overrides: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  return { ...(defaults ?? {}), ...(overrides ?? {}) };
}

function rgbPaintOf(value: JsonValue | undefined): string | null {
  if (Array.isArray(value) && value.length === 3 && value.every((channel) => typeof channel === 'number' && Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    return `rgb(${value[0]}, ${value[1]}, ${value[2]})`;
  }
  if (value === 'red') return '#ef4444';
  if (value === 'green') return '#22c55e';
  if (value === 'blue') return '#3b82f6';
  if (value === 'white') return '#f8fafc';
  if (value === 'off') return '#475569';
  return null;
}

/** Resolve the small set of declarative appearance tokens supported by catalog drawings. */
function applyRenderConfig(render: RenderPrimitiveDef[], config: Record<string, JsonValue>): RenderPrimitiveDef[] {
  const displayColor = config.display_color;
  const displayPaint = displayColor === 'white' ? '#f8fafc' : displayColor === 'blue' ? '#38bdf8' : null;
  const displayLabel = displayColor === 'white' ? 'White' : displayColor === 'blue' ? 'Blue' : null;
  const rgbPaint = rgbPaintOf(config.rgb_led_color);
  if (!displayPaint && !rgbPaint) return render;
  return render.map((primitive) => {
    let resolved = { ...primitive } as RenderPrimitiveDef;
    if (displayPaint && 'fill' in resolved && resolved.fill === '$display_color') resolved = { ...resolved, fill: displayPaint };
    if (displayPaint && 'stroke' in resolved && resolved.stroke === '$display_color') resolved = { ...resolved, stroke: displayPaint };
    if (displayLabel && resolved.t === 'text' && resolved.text === '$display_color_label') resolved = { ...resolved, text: displayLabel };
    if (rgbPaint && 'fill' in resolved && resolved.fill === '$rgb_led_color') resolved = { ...resolved, fill: rgbPaint };
    if (rgbPaint && 'stroke' in resolved && resolved.stroke === '$rgb_led_color') resolved = { ...resolved, stroke: rgbPaint };
    return resolved;
  });
}

/**
 * Resolve a component definition + instance params into concrete pins, body and
 * drawing. Params are validated against the definition's params_schema; any
 * problem is reported in `issues` and the defaults are used instead.
 */
export function resolveComponent(
  def: ComponentDefinition,
  instanceParams?: Record<string, JsonValue>,
  instanceConfig?: Record<string, JsonValue>
): ResolvedComponent {
  const issues: string[] = [];
  let params = mergeDefaults(def.params_default, instanceParams);
  if (def.params_schema && instanceParams) {
    const errs = validateAgainst(def.params_schema as Record<string, unknown>, params);
    if (errs.length) {
      issues.push(...errs.map((e) => `params${e.path}: ${e.message}`));
      params = mergeDefaults(def.params_default, undefined);
    }
  }
  let config = mergeDefaults(def.config_default, instanceConfig);
  if (def.config_schema && instanceConfig) {
    const errs = validateAgainst(def.config_schema as Record<string, unknown>, config);
    if (errs.length) {
      issues.push(...errs.map((e) => `config${e.path}: ${e.message}`));
      config = mergeDefaults(def.config_default, undefined);
    }
  }

  const gen = def.generator;
  let pins: PinDef[] = def.pins.map((p) => ({ ...p, local_um: [p.local_um[0], p.local_um[1]] }));
  let body: BodyDef = { ...def.body, size_um: [def.body.size_um[0], def.body.size_um[1]] };
  let render: RenderPrimitiveDef[] = def.render;
  let orientation: MountOrientation = 'flat';
  let footprint: Rect = { x: 0, y: 0, w: body.size_um[0], h: body.size_um[1] };
  let outline: Rect = footprint;

  if (gen?.type === 'single_row_header') {
    const names = asStringArray(params.pin_names) ?? [];
    if (!names.length) issues.push('params.pin_names must be a non-empty string array');
    const size = asPoint(params.body_size_um, def.body.size_um);
    body = { ...body, size_um: size };
    const [w, h] = size;
    const n = names.length;
    const span = (n - 1) * PITCH_UM;
    pins = names.map((name, i) => {
      let local: PointUm;
      switch (gen.edge) {
        case 'top':
          local = [Math.round((w - span) / 2) + i * PITCH_UM, gen.inset_um];
          break;
        case 'bottom':
          local = [Math.round((w - span) / 2) + i * PITCH_UM, h - gen.inset_um];
          break;
        case 'left':
          local = [gen.inset_um, Math.round((h - span) / 2) + i * PITCH_UM];
          break;
        case 'right':
          local = [w - gen.inset_um, Math.round((h - span) / 2) + i * PITCH_UM];
          break;
      }
      return { name, local_um: local, kind: 'header' };
    });
    orientation = params.mount_orientation === 'flat' ? 'flat' : 'upright';
    outline = { x: 0, y: 0, w, h };
    if (orientation === 'upright' && pins.length) {
      const xs = pins.map((p) => p.local_um[0]);
      const ys = pins.map((p) => p.local_um[1]);
      const half = PITCH_UM / 2;
      const thick = 900;
      if (gen.edge === 'top' || gen.edge === 'bottom') {
        footprint = { x: Math.min(...xs) - half, y: ys[0]! - thick, w: Math.max(...xs) - Math.min(...xs) + PITCH_UM, h: 2 * thick };
      } else {
        footprint = { x: xs[0]! - thick, y: Math.min(...ys) - half, w: 2 * thick, h: Math.max(...ys) - Math.min(...ys) + PITCH_UM };
      }
      body = { ...body, standoff_um: 0, height_um: Math.max(w, h) };
    } else {
      footprint = outline;
    }
  } else if (gen?.type === 'dual_row_header') {
    const n = Math.max(1, Math.round(asNumber(params.pins_per_side, 1)));
    const spacing = Math.round(asNumber(params.row_spacing_um, PITCH_UM * 9));
    const size = asPoint(params.body_size_um, def.body.size_um);
    body = { ...body, size_um: size };
    const [w] = size;
    const left = asStringArray(params.left_pin_names) ?? [];
    const right = asStringArray(params.right_pin_names) ?? [];
    if (left.length !== n || right.length !== n) {
      issues.push(`left_pin_names/right_pin_names must each have pins_per_side (${n}) entries`);
    }
    const xLeft = Math.round((w - spacing) / 2);
    const xRight = xLeft + spacing;
    pins = [];
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const ln = left[i] ?? `L${i + 1}`;
      const rn = right[i] ?? `R${i + 1}`;
      for (const [name, x] of [
        [ln, xLeft],
        [rn, xRight]
      ] as [string, number][]) {
        if (seen.has(name)) issues.push(`duplicate pin name ${name}`);
        seen.add(name);
        pins.push({ name, local_um: [x, gen.first_pin_um + i * PITCH_UM], kind: 'header' });
      }
    }
    footprint = { x: 0, y: 0, w: size[0], h: size[1] };
    outline = footprint;
    // Scale the default drawing if the body size was changed.
    const sx = size[0] / def.body.size_um[0];
    const sy = size[1] / def.body.size_um[1];
    if (sx !== 1 || sy !== 1) render = scaleRender(def.render, sx, sy);
  } else if (gen?.type === 'axial_two_pin') {
    const span = Math.max(1, Math.round(asNumber(params.span_pitches, 4)));
    const value = typeof params.value === 'string' ? params.value : '';
    const w = span * PITCH_UM + PITCH_UM;
    body = { ...body, size_um: [w, PITCH_UM] };
    pins = [
      { name: 'P1', local_um: [PITCH_UM / 2, PITCH_UM / 2], kind: 'header' },
      { name: 'P2', local_um: [PITCH_UM / 2 + span * PITCH_UM, PITCH_UM / 2], kind: 'header' }
    ];
    const bodyW = Math.min(6300, span * PITCH_UM - 1200);
    const bodyX = (w - bodyW) / 2;
    render = [
      { t: 'line', x1: PITCH_UM / 2, y1: PITCH_UM / 2, x2: bodyX, y2: PITCH_UM / 2, stroke: '#8a8a8a', sw: 500 },
      { t: 'line', x1: bodyX + bodyW, y1: PITCH_UM / 2, x2: PITCH_UM / 2 + span * PITCH_UM, y2: PITCH_UM / 2, stroke: '#8a8a8a', sw: 500 },
      { t: 'rect', x: bodyX, y: 250, w: bodyW, h: PITCH_UM - 500, rx: 600, fill: '#d6c19a', stroke: '#6b5b3a', sw: 120 },
      { t: 'text', x: w / 2, y: PITCH_UM / 2 + 350, text: value, size: 900, fill: '#3b2f14', anchor: 'middle' }
    ];
    footprint = { x: bodyX, y: 0, w: bodyW, h: PITCH_UM };
    outline = { x: 0, y: 0, w, h: PITCH_UM };
  }

  render = applyRenderConfig(render, config);
  return { def, params, config, pins, body, footprint, outline, orientation, render, issues };
}

function scaleRender(prims: RenderPrimitiveDef[], sx: number, sy: number): RenderPrimitiveDef[] {
  return prims.map((p) => {
    switch (p.t) {
      case 'rect':
        return { ...p, x: p.x * sx, y: p.y * sy, w: p.w * sx, h: p.h * sy };
      case 'circle':
        return { ...p, cx: p.cx * sx, cy: p.cy * sy };
      case 'text':
        return { ...p, x: p.x * sx, y: p.y * sy };
      case 'line':
        return { ...p, x1: p.x1 * sx, y1: p.y1 * sy, x2: p.x2 * sx, y2: p.y2 * sy };
      case 'path':
        return p;
    }
  });
}

export function findPin(rc: ResolvedComponent, name: string): PinDef | undefined {
  return rc.pins.find((p) => p.name === name);
}
