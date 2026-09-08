import { describe, expect, it } from 'vitest';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { toGlobal, type Transform } from '@breadboard-studio/core';
import { mm, transformAttr } from '@breadboard-studio/render';
import type { ComponentDefinition, FeatureDef, PointUm, RotationDeg } from '@breadboard-studio/schema';
import type { DeviceVisualState } from '@breadboard-studio/sim';
import {
  clampIntensity,
  controlTestId,
  featureRect,
  inscribedCircle,
  overlayControls,
  overlayDisplays,
  overlayVisuals,
  parseHexColor,
  rgbFill,
  visualTestId,
  type FeatureSource
} from './overlay-geometry';

const catalog = builtinCatalog();

function definition(id: string): ComponentDefinition {
  const def = catalog.getComponent(id);
  if (!def) throw new Error(`missing definition ${id}`);
  return def;
}

const MCU = 'esp32s3_n16r8_dual_usb@1';
const TOUCH = 'ttp223_module@1';
const OLED = 'oled_0_96_ssd1315_i2c@1';

/** Applies the SVG group transform the overlay renders under, so a test can check where a rect lands. */
function applyTransformAttr(attr: string, point: [number, number]): [number, number] {
  const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) rotate\((-?\d+)\)$/.exec(attr);
  if (!m) throw new Error(`unexpected transform: ${attr}`);
  const [tx, ty, deg] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const rad = (deg * Math.PI) / 180;
  const [x, y] = point;
  return [tx + x * Math.cos(rad) - y * Math.sin(rad), ty + x * Math.sin(rad) + y * Math.cos(rad)];
}

describe('featureRect', () => {
  it('converts a catalog feature rect from µm to mm', () => {
    // esp32s3 "RGB": { x: 17820, y: 16220, w: 3560, h: 3560 }
    expect(featureRect(definition(MCU), 'RGB')).toEqual({ x: 17.82, y: 16.22, width: 3.56, height: 3.56 });
    // ttp223 "触摸区": { x: 3000, y: 1500, w: 9000, h: 6000 }
    expect(featureRect(definition(TOUCH), '触摸区')).toEqual({ x: 3, y: 1.5, width: 9, height: 6 });
  });

  it('returns null when the label is unknown', () => {
    expect(featureRect(definition(MCU), 'BOOT2')).toBeNull();
    expect(featureRect(definition(TOUCH), 'RGB')).toBeNull();
    expect(featureRect({ features: undefined }, 'RGB')).toBeNull();
  });

  it('returns null when the labelled feature carries no usable rect', () => {
    const noRect: FeatureDef[] = [{ type: 'led', label: 'RGB' }];
    expect(featureRect({ features: noRect }, 'RGB')).toBeNull();
    const degenerate: FeatureDef[] = [{ type: 'led', label: 'RGB', rect_um: { x: 10, y: 10, w: 0, h: 500 } }];
    expect(featureRect({ features: degenerate }, 'RGB')).toBeNull();
    const broken = [{ type: 'led', label: 'RGB', rect_um: { x: 0, y: 0, w: Number.NaN, h: 10 } }] as FeatureDef[];
    expect(featureRect({ features: broken }, 'RGB')).toBeNull();
  });

  it('takes the first labelled feature that has a rect', () => {
    const features: FeatureDef[] = [
      { type: 'button', label: 'BOOT' },
      { type: 'button', label: 'BOOT', rect_um: { x: 1000, y: 2000, w: 3000, h: 4000 } }
    ];
    expect(featureRect({ features }, 'BOOT')).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('inscribedCircle', () => {
  it('centres in the rect and takes the shorter side', () => {
    expect(inscribedCircle({ x: 2, y: 4, width: 8, height: 6 })).toEqual({ cx: 6, cy: 7, r: 3 });
  });
});

describe('rgbFill / clampIntensity', () => {
  it('formats and clamps channels', () => {
    expect(rgbFill([0, 128, 255])).toBe('rgb(0, 128, 255)');
    expect(rgbFill([-5, 300, 12.4])).toBe('rgb(0, 255, 12)');
    expect(rgbFill([Number.NaN, 0, 0])).toBe('rgb(0, 0, 0)');
  });

  it('clamps intensity into [0, 1]', () => {
    expect(clampIntensity(0.5)).toBe(0.5);
    expect(clampIntensity(4)).toBe(1);
    expect(clampIntensity(-1)).toBe(0);
    expect(clampIntensity(Number.NaN)).toBe(0);
  });
});

describe('overlayVisuals', () => {
  const mcu = definition(MCU);

  it('pairs led and pressed states with their feature rects', () => {
    const states: DeviceVisualState[] = [
      { kind: 'led', feature: 'RGB', rgb: [10, 20, 30], intensity: 1 },
      { kind: 'pressed', feature: 'BOOT', active: true },
      { kind: 'pressed', feature: 'RST', active: false }
    ];
    const painted = overlayVisuals(mcu, states);
    expect(painted.map((v) => `${v.kind}:${v.feature}`)).toEqual(['led:RGB', 'pressed:BOOT', 'pressed:RST']);
    const led = painted[0]!;
    expect(led).toMatchObject({ kind: 'led', fill: 'rgb(10, 20, 30)', opacity: 1 });
    if (led.kind !== 'led') throw new Error('expected an led');
    expect(led.circle).toEqual({ cx: 17.82 + 1.78, cy: 16.22 + 1.78, r: 1.78 });
    expect(painted[1]).toMatchObject({ kind: 'pressed', active: true, rect: { x: 7, y: 26.7, width: 3.9, height: 3.4 } });
  });

  it('drops a state whose feature label matches nothing in the definition', () => {
    const states: DeviceVisualState[] = [
      { kind: 'led', feature: 'LED_BUILTIN', rgb: [255, 0, 0], intensity: 1 },
      { kind: 'pressed', feature: 'BOOT', active: true }
    ];
    expect(overlayVisuals(mcu, states).map((v) => v.feature)).toEqual(['BOOT']);
  });

  it('drops a state whose feature exists but has no rect', () => {
    const def: FeatureSource = { features: [{ type: 'led', label: 'RGB' }] };
    expect(overlayVisuals(def, [{ kind: 'led', feature: 'RGB', rgb: [1, 2, 3], intensity: 1 }])).toEqual([]);
  });

  it('leaves display states to M-S3 and survives an empty frame', () => {
    const oled = definition(OLED);
    const display: DeviceVisualState[] = [
      { kind: 'display', feature: '128×64 OLED', width: 128, height: 64, pixels: new Uint8Array(0), color: '#fff', enabled: true }
    ];
    expect(overlayVisuals(oled, display)).toEqual([]);
    expect(overlayVisuals(oled, undefined)).toEqual([]);
    expect(overlayVisuals(oled, [])).toEqual([]);
  });

  it('keeps the last state when one frame repeats a (kind, feature) pair', () => {
    const states: DeviceVisualState[] = [
      { kind: 'led', feature: 'RGB', rgb: [0, 0, 0], intensity: 0 },
      { kind: 'led', feature: 'RGB', rgb: [0, 255, 0], intensity: 1 }
    ];
    const painted = overlayVisuals(mcu, states);
    expect(painted).toHaveLength(1);
    expect(painted[0]).toMatchObject({ fill: 'rgb(0, 255, 0)', opacity: 1 });
  });
});

describe('overlayControls', () => {
  it('reads the controls straight from the catalog definition', () => {
    expect(overlayControls(definition(MCU))).toEqual([
      { controlId: 'boot', action: 'press', feature: 'BOOT', rect: { x: 7, y: 26.7, width: 3.9, height: 3.4 } },
      { controlId: 'rst', action: 'press', feature: 'RST', rect: { x: 7, y: 31.9, width: 3.9, height: 3.4 } }
    ]);
    expect(overlayControls(definition(TOUCH))).toEqual([
      { controlId: 'touch', action: 'touch', feature: '触摸区', rect: { x: 3, y: 1.5, width: 9, height: 6 } }
    ]);
  });

  it('has nothing to place for a part without controls', () => {
    expect(overlayControls(definition(OLED))).toEqual([]);
    expect(overlayControls({ features: [] })).toEqual([]);
  });

  it('skips sliders (not on the canvas this milestone) and controls without a rect', () => {
    const def: FeatureSource = {
      features: [
        { type: 'sensor_window', label: '滑杆', rect_um: { x: 0, y: 0, w: 1000, h: 1000 } },
        { type: 'button', label: '无区域' }
      ],
      simulation: {
        controls: [
          { id: 'level', feature_label: '滑杆', action: 'slider', channel: 'level' },
          { id: 'ghost', feature_label: '无区域', action: 'press', channel: 'ghost' },
          { id: 'missing', feature_label: '不存在的标签', action: 'press', channel: 'missing' }
        ]
      }
    };
    expect(overlayControls(def)).toEqual([]);
  });
});

describe('test ids', () => {
  it('are stable and component scoped', () => {
    expect(controlTestId('touch_1', 'touch')).toBe('sim-control-touch_1:touch');
    expect(visualTestId('mcu_1', 'led', 'RGB')).toBe('sim-visual-mcu_1:led:RGB');
  });
});

describe('rotation is carried by the group transform, not by the rect', () => {
  const touch = definition(TOUCH);
  const position: PointUm = [40000, 25000];

  // The overlay draws feature rects unrotated, inside `<g transform={transformAttr(pc.transform)}>`.
  // What has to hold is that the composition lands on the same point core computes for a pin:
  // if the rect were pre-rotated the overlay would be rotated twice.
  for (const rotation of [0, 90, 180, 270] as RotationDeg[]) {
    it(`places the touch pad correctly at ${rotation}°`, () => {
      const transform: Transform = { position, rotation };
      const rect = featureRect(touch, '触摸区')!;
      expect(rect).not.toBeNull();
      for (const corner of [
        [3000, 1500],
        [12000, 7500]
      ] as PointUm[]) {
        const expected = toGlobal(corner, transform);
        const drawn = applyTransformAttr(transformAttr(transform), [mm(corner[0]), mm(corner[1])]);
        expect(drawn[0]).toBeCloseTo(mm(expected[0]), 6);
        expect(drawn[1]).toBeCloseTo(mm(expected[1]), 6);
      }
    });
  }

  it('keeps the rect itself in the unrotated definition frame', () => {
    const flat = featureRect(touch, '触摸区');
    expect(flat).toEqual({ x: 3, y: 1.5, width: 9, height: 6 });
    expect(transformAttr({ position, rotation: 270 })).toBe('translate(40 25) rotate(270)');
  });
});

describe('display panels', () => {
  const oled: FeatureSource = {
    features: [
      { type: 'display', label: '128×64 OLED', rect_um: { x: 2000, y: 3000, w: 22000, h: 11000 } },
      { type: 'silk', label: '型号', rect_um: { x: 0, y: 0, w: 4000, h: 2000 } }
    ],
    simulation: {
      visuals: [
        { id: 'screen', feature_label: '128×64 OLED', kind: 'display', channel: 'framebuffer' },
        { id: 'led', feature_label: '型号', kind: 'led', channel: 'rgb' },
        { id: 'ghost', feature_label: '不存在的丝印', kind: 'display', channel: 'other' }
      ]
    }
  } as FeatureSource;

  it('places a panel from the catalog binding, not from a runtime frame', () => {
    // The panel must exist before the first frame, or an OLED that is off would
    // have nowhere to be black.
    expect(overlayDisplays(oled)).toEqual([{ channel: 'framebuffer', feature: '128×64 OLED', rect: { x: 2, y: 3, width: 22, height: 11 } }]);
  });

  it('ignores non-display visuals and labels the drawing does not have', () => {
    expect(overlayDisplays({ features: [], simulation: { visuals: [] } } as FeatureSource)).toEqual([]);
    expect(overlayDisplays({ features: [] } as FeatureSource)).toEqual([]);
    // 'ghost' names a label with no feature, 'led' is not a display: both dropped.
    expect(overlayDisplays(oled).map((d) => d.channel)).toEqual(['framebuffer']);
  });

  it('turns the panel colour into channels, and never into a dead-looking black', () => {
    expect(parseHexColor('#f8fafc')).toEqual([248, 250, 252]);
    expect(parseHexColor('#38bdf8')).toEqual([56, 189, 248]);
    expect(parseHexColor('  #38BDF8 ')).toEqual([56, 189, 248]);
    for (const bad of ['', 'blue', '#fff', 'rgb(1,2,3)', '#12345g']) {
      expect(parseHexColor(bad), bad).toEqual([248, 250, 252]);
    }
  });
});
