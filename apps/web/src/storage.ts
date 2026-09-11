import type { DesignDocument } from '@breadboard-studio/schema';
import { loadDesign, serializeDesign } from '@breadboard-studio/core';

const CURRENT_KEY = 'breadboard-studio.v1.current';
const PREVIOUS_KEY = 'breadboard-studio.v1.previous';
const CLIPBOARD_KEY = 'breadboard-studio.v1.clipboard';

export type StorageStatus = { state: 'saved'; at: string } | { state: 'error'; message: string } | { state: 'unavailable'; message: string } | { state: 'idle' };

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

export function saveCurrent(design: DesignDocument): StorageStatus {
  const s = storage();
  if (!s) return { state: 'unavailable', message: '浏览器本地存储不可用（隐私模式或已禁用），修改不会自动保存。' };
  try {
    s.setItem(CURRENT_KEY, serializeDesign(design));
    return { state: 'saved', at: new Date().toISOString() };
  } catch (e) {
    return { state: 'error', message: `本地保存失败：${(e as Error).message}。请导出 JSON 备份。` };
  }
}

export function loadCurrent(): DesignDocument | null {
  const s = storage();
  if (!s) return null;
  const text = s.getItem(CURRENT_KEY);
  if (!text) return null;
  const r = loadDesign(text);
  return r.ok && r.design ? r.design : null;
}

/** Raw stored text, for recovery paths that must see *why* a load failed. */
export function readCurrentText(): string | null {
  const s = storage();
  return s ? s.getItem(CURRENT_KEY) : null;
}

/** Keep the previous project so "新建/导入" can be undone. */
export function stashPrevious(design: DesignDocument): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PREVIOUS_KEY, serializeDesign(design));
  } catch {
    // best effort
  }
}

export function loadPrevious(): DesignDocument | null {
  const s = storage();
  if (!s) return null;
  const text = s.getItem(PREVIOUS_KEY);
  if (!text) return null;
  const r = loadDesign(text);
  return r.ok && r.design ? r.design : null;
}

export function readPreviousText(): string | null {
  const s = storage();
  return s ? s.getItem(PREVIOUS_KEY) : null;
}

export function hasPrevious(): boolean {
  const s = storage();
  return !!s && !!s.getItem(PREVIOUS_KEY);
}

/**
 * The copy buffer outlives the page, which is what makes 复制 → 打开另一个项目 → 粘贴
 * work at all. It is deliberately *not* the system clipboard: reading that back needs
 * a permission prompt, and the payload is our own JSON that no other app can use.
 */
export function saveClipboard(payload: unknown): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(CLIPBOARD_KEY, JSON.stringify(payload));
  } catch {
    // a full quota must never break the copy the user just made in memory
  }
}

export function loadClipboard<T>(): T | null {
  const s = storage();
  if (!s) return null;
  const text = s.getItem(CLIPBOARD_KEY);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
