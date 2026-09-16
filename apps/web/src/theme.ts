import { useEffect, useState } from 'react';

/**
 * 主题（issue #23）：浅色 / 深色 / 跟随系统。
 *
 * 分层很薄：纯函数负责「偏好 → 实际主题」的解析（node 环境可单测），
 * DOM 只做一件事 —— 把解析结果写到 `<html data-theme>`，styles.css 里所有
 * 颜色变量跟着这个属性切换。localStorage 的 key 沿用 storage.ts 的
 * `breadboard-studio.v1.*` 命名；index.html 里的启动脚本用同一个 key 在
 * 首帧之前写好 data-theme，避免「先浅后深」的闪烁。
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'breadboard-studio.v1.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

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

/** 只认识三档；存坏了/没存过 = 跟随系统（与首次使用的默认一致）。 */
export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DARK_QUERY).matches;
}

/** 手动选择优先于系统设置；只有 system 这档才看系统。 */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function loadThemePreference(): ThemePreference {
  const s = storage();
  return parseThemePreference(s ? s.getItem(THEME_STORAGE_KEY) : null);
}

export function saveThemePreference(preference: ThemePreference): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 存不进去就只在本次会话内生效，别打断用户
  }
}

/** 把解析结果写到 `<html data-theme>`；CSS 与画布覆盖样式全部挂在这个属性上。 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark());
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

// ---- 模块级小商店：工具栏之外的消费者（将来可能有）也保持同一份偏好 ----
let current: ThemePreference = 'system';
let initialized = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  current = loadThemePreference();
  applyTheme(current);
}

/** main.tsx 在渲染前调用：即使 React 还没挂载，CSS 变量也已经就位。 */
export function initTheme(): void {
  ensureInit();
}

export function setThemePreference(next: ThemePreference): void {
  ensureInit();
  current = next;
  saveThemePreference(next);
  applyTheme(next);
  notify();
}

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

export function useTheme(): ThemeState {
  ensureInit();
  const [preference, setPreference] = useState(current);
  useEffect(() => {
    const listener = () => setPreference(current);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  // 「跟随系统」响应系统主题变化；light/dark 是手动选择，系统变了也不跟。
  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      applyTheme(preference);
      notify();
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);
  return { preference, resolved: resolveTheme(preference, systemPrefersDark()), setPreference: setThemePreference };
}
