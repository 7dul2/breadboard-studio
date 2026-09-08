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

/** Mirror of `SimVisualHook` in apps/web/src/testHooks.ts; display frames expose no pixels. */
export type SimVisualHook =
  | { kind: 'led'; feature: string; rgb: [number, number, number]; intensity: number }
  | { kind: 'display'; feature: string; width: number; height: number; enabled: boolean; onPixels: number; sha: string }
  | { kind: 'pressed'; feature: string; active: boolean };

/** Mirror of `SimulatorHookState` in apps/web/src/testHooks.ts. */
export interface SimulatorHookState {
  status: string;
  sessionId: string | null;
  programId: string | null;
  nowUs: number;
  speed: number;
  canEditTopology: boolean;
  allowed: string[];
  droppedMessages: number;
  diagnostics: {
    code: string;
    severity: string;
    message: string;
    atUs?: number;
    componentIds?: string[];
    netIds?: string[];
    pinAddresses?: string[];
    source?: { programId: string; line: number; column: number };
  }[];
  serial: { componentId: string; stream: string; text: string; atUs: number }[];
  nets: { netId: string; name?: string; value: string | number; drivers: { componentId: string; pin: string; value: string | number; strength: string }[] }[];
  visuals: Record<string, SimVisualHook[]>;
  editorOpen: boolean;
  dirty: boolean;
}

export function simulator(page: Page): Promise<SimulatorHookState> {
  return page.evaluate(() => (window as unknown as { __bbs: { simulator: () => SimulatorHookState } }).__bbs.simulator());
}

export function design(page: Page): Promise<{ schema_version: string; metadata: { name: string; revision: number }; boards: { id: string; position_um: [number, number] }[]; components: { id: string; placement: Record<string, unknown> }[]; wires: { id: string; from: Record<string, string>; to?: Record<string, string> }[]; programs?: { id: string; name: string; target_component_id: string; language: string; source: string }[]; simulation?: { active_program_id?: string; speed?: number; random_seed?: number; usb_powered_components?: string[] } }> {
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
