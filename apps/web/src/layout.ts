import { useSyncExternalStore } from 'react';

/**
 * 左右面板的宽度与折叠（issue #39）。
 *
 * 分层与 theme.ts 一样薄：纯函数负责「存了什么 → 用什么布局」的解析（node 环境可单测），
 * 一个模块级小商店保存当前值，DOM 只做一件事 —— 把结果写成 `<html>` 上的
 * `--panel-left-width` / `--panel-right-width`。styles.css 里 `.left` / `.right` 的宽度、
 * 以及盖在画布上的 `.model-detail-layer` 的 inset 都读这两个变量，所以「面板宽度」
 * 只有这一个来源。
 *
 * 两条边界：
 * - 布局不是设计数据。它不进 store、不进撤销栈、不参与导出，撤销一次编辑不会顺带
 *   把面板宽度改回去；反过来拖把手也不会把设计标成「未保存」。
 * - 变量值为 0 表示「折叠」，而不是把面板从 DOM 里拿掉：仿真面板折叠时仍在挂载，
 *   会话视图不会被卸载打断。宽度为 0 的面板靠边缘那条常驻轨道（rail）展开。
 */
export type PanelSide = 'left' | 'right';

export interface PanelLayout {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const LAYOUT_STORAGE_KEY = 'breadboard-studio.v1.layout';
/** 拖拽区间：再窄属性面板会挤成一条，再宽画布就没地方了。 */
export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_WIDTH = 520;
/** 默认值就是改动前面板的样子，所以「没存过布局」和「清空 localStorage」看到的界面不变。 */
export const DEFAULT_LAYOUT: PanelLayout = { leftWidth: 260, rightWidth: 340, leftCollapsed: false, rightCollapsed: false };

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__bbs_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL_MIN_WIDTH;
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, value)));
}

/**
 * 越界或类型不对一律回落默认值，而不是夹到最近的边界：存档被改坏时，悄悄把面板
 * 改成 200 或 520 是在替用户做一个他没做过的决定，回到默认才是「没存过」的语义。
 */
function parseWidth(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= PANEL_MIN_WIDTH && raw <= PANEL_MAX_WIDTH ? Math.round(raw) : fallback;
}

export function parseLayout(raw: string | null): PanelLayout {
  const fallback: PanelLayout = { ...DEFAULT_LAYOUT };
  if (!raw) return fallback;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fallback;
  const o = data as Record<string, unknown>;
  return {
    leftWidth: parseWidth(o.leftWidth, DEFAULT_LAYOUT.leftWidth),
    rightWidth: parseWidth(o.rightWidth, DEFAULT_LAYOUT.rightWidth),
    leftCollapsed: o.leftCollapsed === true,
    rightCollapsed: o.rightCollapsed === true
  };
}

export function serializeLayout(layout: PanelLayout): string {
  return JSON.stringify(layout);
}

export function loadLayout(): PanelLayout {
  const s = storage();
  return parseLayout(s ? s.getItem(LAYOUT_STORAGE_KEY) : null);
}

export function saveLayout(layout: PanelLayout): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(LAYOUT_STORAGE_KEY, serializeLayout(layout));
  } catch {
    // 存不进去就只在本次会话内生效，别打断用户
  }
}

/** 折叠时写 0：`.left/.right` 的宽度由 max(轨道, 变量) 决定，所以折叠后面板只剩那条轨道。 */
export function applyLayout(layout: PanelLayout): void {
  const root = document.documentElement.style;
  root.setProperty('--panel-left-width', `${layout.leftCollapsed ? 0 : layout.leftWidth}px`);
  root.setProperty('--panel-right-width', `${layout.rightCollapsed ? 0 : layout.rightWidth}px`);
}

// ---- 模块级小商店：把手、快捷键、将来的快捷键表共用同一份布局 ----
let current: PanelLayout = { ...DEFAULT_LAYOUT };
let initialized = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function commit(next: PanelLayout): void {
  current = next;
  applyLayout(current);
  saveLayout(current);
  notify();
}

/** main.tsx 在渲染前调用：即使 React 还没挂载，面板宽度也已经就位。 */
export function initLayout(): void {
  if (initialized) return;
  initialized = true;
  current = loadLayout();
  applyLayout(current);
}

function ensureInit(): PanelLayout {
  if (!initialized) initLayout();
  return current;
}

export function getLayout(): PanelLayout {
  return ensureInit();
}

export function isPanelCollapsed(side: PanelSide, layout: PanelLayout = ensureInit()): boolean {
  return side === 'left' ? layout.leftCollapsed : layout.rightCollapsed;
}

export function panelWidth(side: PanelSide, layout: PanelLayout = ensureInit()): number {
  return side === 'left' ? layout.leftWidth : layout.rightWidth;
}

export function setPanelWidth(side: PanelSide, width: number): void {
  const layout = ensureInit();
  const next = side === 'left' ? { ...layout, leftWidth: clampPanelWidth(width) } : { ...layout, rightWidth: clampPanelWidth(width) };
  if (next.leftWidth === layout.leftWidth && next.rightWidth === layout.rightWidth) return;
  commit(next);
}

export function togglePanel(side: PanelSide): void {
  const layout = ensureInit();
  commit(side === 'left' ? { ...layout, leftCollapsed: !layout.leftCollapsed } : { ...layout, rightCollapsed: !layout.rightCollapsed });
}

/**
 * 拖动过程中的即时反馈：只改 CSS 变量，不动状态、不落盘。一次拖动里
 * localStorage 只写一次（pointerup 时），而画布每一帧都跟着动。
 */
export function previewPanelWidth(side: PanelSide, width: number): void {
  document.documentElement.style.setProperty(side === 'left' ? '--panel-left-width' : '--panel-right-width', `${clampPanelWidth(width)}px`);
}

export interface LayoutState extends PanelLayout {
  setWidth: (side: PanelSide, width: number) => void;
  toggle: (side: PanelSide) => void;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 只在 commit 时换对象，所以这个快照的引用在两次改动之间是稳定的（useSyncExternalStore 的要求）。 */
function getSnapshot(): PanelLayout {
  return ensureInit();
}

/** 用 useSyncExternalStore 而不是 useState + useEffect 订阅：首次渲染与订阅之间没有空窗。 */
export function useLayout(): LayoutState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snapshot, setWidth: setPanelWidth, toggle: togglePanel };
}
