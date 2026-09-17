import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, clampPanelWidth, parseLayout, serializeLayout } from './layout';

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
  it('keeps a dragged width inside the allowed range', () => {
    expect(clampPanelWidth(300)).toBe(300);
    expect(clampPanelWidth(PANEL_MIN_WIDTH)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(PANEL_MAX_WIDTH)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(1)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(10_000)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(-40)).toBe(PANEL_MIN_WIDTH);
  });

  it('rounds to whole pixels so the canvas delta is an integer', () => {
    expect(clampPanelWidth(300.4)).toBe(300);
    expect(clampPanelWidth(300.5)).toBe(301);
  });

  it('never returns NaN, whatever a drag computes', () => {
    expect(clampPanelWidth(NaN)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(Infinity)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(-Infinity)).toBe(PANEL_MIN_WIDTH);
  });
});