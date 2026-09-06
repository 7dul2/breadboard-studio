import { expect, type Page } from '@playwright/test';

export interface BbsState {
  selectedIds: string[];
  selectedHole: string | null;
  tool: string;
  storage: { state: string };
  dslDirty: boolean;
  buildMode: boolean;
  past: number;
  future: number;
}

export async function fresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

export function state(page: Page): Promise<BbsState> {
  return page.evaluate(() => (window as unknown as { __bbs: { state: () => BbsState } }).__bbs.state());
}

export function design(page: Page): Promise<{ metadata: { name: string; revision: number }; boards: { id: string; position_um: [number, number] }[]; components: { id: string; placement: Record<string, unknown> }[]; wires: { id: string; from: Record<string, string>; to?: Record<string, string> }[] }> {
  return page.evaluate(() => (window as unknown as { __bbs: { getDesign: () => never } }).__bbs.getDesign());
}

export function analysis(page: Page): Promise<{ results: { code: string; severity: string; endpoints: string[]; objects: string[] }[]; nets: { name: string; pins: string[] }[]; summary: { error: number; warning: number; needs_review: number; blocking: number }; hash: string }> {
  return page.evaluate(() => (window as unknown as { __bbs: { getAnalysis: () => never } }).__bbs.getAnalysis());
}

export async function clickHole(page: Page, addr: string, opts: { modifiers?: ('Shift')[] } = {}): Promise<void> {
  const el = page.locator(`[data-hole="${addr}"]`).first();
  await el.scrollIntoViewIfNeeded();
  await el.click({ force: true, modifiers: opts.modifiers });
}

export async function addFromLibrary(page: Page, modelId: string): Promise<void> {
  await page.getByTestId(`lib-${modelId}`).click();
}

export async function loadExample(page: Page, key: string): Promise<void> {
  await page.getByTestId('menu-project').click();
  await page.getByTestId(`example-${key}`).click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

export async function fit(page: Page): Promise<void> {
  await page.getByTestId('fit').click();
}
