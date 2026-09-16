import { describe, expect, it } from 'vitest';
import { parseThemePreference, resolveTheme } from './theme';

/**
 * 纯函数部分（node 环境可测）：偏好解析 + 手动选择优先于系统。
 * 存取与 `<html data-theme>` 的落地在 e2e/theme.spec.ts 里走真浏览器。
 */
describe('parseThemePreference', () => {
  it('accepts the three stored values', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');
  });

  it('falls back to system for missing or corrupt values', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('')).toBe('system');
    expect(parseThemePreference('DARK')).toBe('system');
    expect(parseThemePreference('{"a":1}')).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('manual selection beats the system setting', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('system follows the OS theme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
