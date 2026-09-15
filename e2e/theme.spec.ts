import { test, expect, type Page } from '@playwright/test';
import { fresh } from './helpers';

/**
 * 深色模式（issue #23）：三档偏好（浅/深/跟随系统）、手动选择优先、
 * 偏好持久化、以及深色变量真的落在界面与画布上。
 */

async function themeOf(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null);
}

test.describe('深色模式', () => {
  test('① 默认跟随系统，系统切换时无需刷新自动跟随', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await fresh(page);
    expect(await themeOf(page)).toBe('dark');

    // 系统在会话中途切换：跟随系统这档要响应 matchMedia 变化
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('② 手动选择优先于系统设置，偏好持久保存', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await fresh(page);
    await page.getByTestId('theme-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await themeOf(page)).toBe('light');
    // 系统仍是深色，但手动选择赢
    expect(await page.evaluate(() => localStorage.getItem('breadboard-studio.v1.theme'))).toBe('light');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('③ 深色落到界面与画布变量上，刷新后仍是深色', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // body 背景与画布底色走的是深色变量（--bg: #10141a / --canvas-bg: #14181e）
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(16, 20, 26)');
    const canvasBg = await page.evaluate(() => getComputedStyle(document.querySelector('.canvas .canvas-bg')!).fill);
    expect(canvasBg).toBe('rgb(20, 24, 30)');

    // 开关状态与 aria-pressed
    await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'false');
  });

  test('④ 切回跟随系统后清除手动偏好', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme-system').click();
    expect(await page.evaluate(() => localStorage.getItem('breadboard-studio.v1.theme'))).toBe('system');
    // headless 默认 prefers-color-scheme: light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
