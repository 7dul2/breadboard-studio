import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, applyLayout, clampPanelWidth, parseLayout, previewPanelWidth, serializeLayout } from './layout';

/**
 * 纯函数部分（node 环境可测）：越界回落 + 拖拽夹紧。
 * CSS 变量落地、拖拽与折叠在 e2e/panels.spec.ts 里走真浏览器。
 */
describe('parseLayout', () => {
  it('falls back to the defaults for missing, empty or corrupt values', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('null')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('[260,340]')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('"left"')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('42')).toEqual(DEFAULT_LAYOUT);
  });

  it('round-trips a saved layout', () => {
    const layout = { leftWidth: 320, rightWidth: 200, leftCollapsed: true, rightCollapsed: false };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it('falls back per field, so one bad number does not reset the other panel', () => {
    const parsed = parseLayout(JSON.stringify({ leftWidth: 300, rightWidth: 'wide', leftCollapsed: true }));
    expect(parsed).toEqual({ leftWidth: 300, rightWidth: DEFAULT_LAYOUT.rightWidth, leftCollapsed: true, rightCollapsed: false });
  });

  it('treats out-of-range widths as absent rather than clamping them', () => {
    // 越界说明存档被改坏了：夹到边界等于替用户做一个他没做过的决定。
    for (const bad of [PANEL_MIN_WIDTH - 1, PANEL_MAX_WIDTH + 1, 0, -300, 5000, NaN, Infinity]) {
      expect(parseLayout(JSON.stringify({ leftWidth: bad, rightWidth: bad }))).toEqual(DEFAULT_LAYOUT);
    }
    expect(parseLayout(JSON.stringify({ leftWidth: PANEL_MIN_WIDTH, rightWidth: PANEL_MAX_WIDTH }))).toEqual({
      leftWidth: PANEL_MIN_WIDTH,
      rightWidth: PANEL_MAX_WIDTH,
      leftCollapsed: false,
      rightCollapsed: false
    });
  });

  it('only a literal true collapses a panel', () => {
    // 折叠会藏起整个面板，所以只有明确的 true 才算数：`"true"` / 1 / 对象都不折叠。
    for (const bad of ['true', 1, {}, [], null]) {
      const parsed = parseLayout(JSON.stringify({ leftCollapsed: bad, rightCollapsed: bad }));
      expect(parsed.leftCollapsed).toBe(false);
      expect(parsed.rightCollapsed).toBe(false);
    }
    expect(parseLayout(JSON.stringify({ leftCollapsed: true })).leftCollapsed).toBe(true);
  });

  it('rounds fractional widths', () => {
    expect(parseLayout(JSON.stringify({ leftWidth: 300.6 })).leftWidth).toBe(301);
  });
});

describe('clampPanelWidth', () => {
  it('pins the allowed range and the defaults (issue #39: 200–520, 默认 260/340)', () => {
    // 字面量是故意的：拿被测常量同时当输入和期望，改常量时测试不会失败，等于没钉住。
    expect(PANEL_MIN_WIDTH).toBe(200);
    expect(PANEL_MAX_WIDTH).toBe(520);
    expect(DEFAULT_LAYOUT).toEqual({ leftWidth: 260, rightWidth: 340, leftCollapsed: false, rightCollapsed: false });
  });

  it('keeps a dragged width inside the allowed range', () => {
    expect(clampPanelWidth(300)).toBe(300);
    expect(clampPanelWidth(200)).toBe(200);
    expect(clampPanelWidth(520)).toBe(520);
    expect(clampPanelWidth(1)).toBe(200);
    expect(clampPanelWidth(519.6)).toBe(520);
    expect(clampPanelWidth(10_000)).toBe(520);
    expect(clampPanelWidth(-40)).toBe(200);
  });

  it('rounds to whole pixels so the canvas delta is an integer', () => {
    expect(clampPanelWidth(300.4)).toBe(300);
    expect(clampPanelWidth(300.5)).toBe(301);
  });

  it('never returns NaN, whatever a drag computes', () => {
    // 拖动不可能产出 ±Infinity，所以这里只是保证任何输入都不会把 NaN 写进宽度变量。
    expect(clampPanelWidth(NaN)).toBe(200);
    expect(clampPanelWidth(Infinity)).toBe(200);
    expect(clampPanelWidth(-Infinity)).toBe(200);
  });
});

/**
 * CSS 变量是 styles.css 与面板之间唯一的接口，所以变量名和「折叠写 0」这两条契约
 * 在这里钉住（DOM 侧的效果由 e2e/panels.spec.ts 量真实宽度来兜）。
 */
describe('applyLayout / previewPanelWidth', () => {
  // node 环境没有 document：给一个只记 setProperty 的替身，就能直接看这两个函数写了什么。
  let restore: (() => void) | null = null;

  function stubDocument(): Map<string, string> {
    const writes = new Map<string, string>();
    const globals = globalThis as unknown as { document?: unknown };
    const original = globals.document;
    globals.document = { documentElement: { style: { setProperty: (key: string, value: string) => writes.set(key, value) } } };
    restore = () => {
      globals.document = original;
    };
    return writes;
  }

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('writes the two variables, and 0px when a panel is collapsed', () => {
    const writes = stubDocument();
    applyLayout({ leftWidth: 320, rightWidth: 200, leftCollapsed: false, rightCollapsed: true });
    expect(writes.get('--panel-left-width')).toBe('320px');
    expect(writes.get('--panel-right-width')).toBe('0px');
  });

  it('preview writes one variable and stays inside the range', () => {
    const writes = stubDocument();
    previewPanelWidth('left', 480.6);
    expect(writes.get('--panel-left-width')).toBe('481px');
    previewPanelWidth('right', 9000);
    expect(writes.get('--panel-right-width')).toBe('520px');
  });
});