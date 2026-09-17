import { expect, type Page } from '@playwright/test';

export interface BbsState {
  selectedIds: string[];
  selectedHole: string | null;
  tool: string;
  mode: string;
  rightTab: string;
  hasClipboard: boolean;
  storage: { state: string };
  dslDirty: boolean;
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
  | { kind: 'display'; feature: string; width: number; height: number; enabled: boolean; onPixels: number; sha: string; storedPixelBytes: number }
  | { kind: 'pressed'; feature: string; active: boolean };

/** Mirror of `SimulatorHookState` in apps/web/src/testHooks.ts. */
export interface SimulatorHookState {
  status: string;
  sessionId: string | null;
  programId: string | null;
  nowUs: number;
  speed: number;
  canEditTopology: boolean;
  trace: { netId: string; atUs: number; value: string | number }[];
  traceDropped: number;
  recording: { atUs: number; componentId: string; controlId: string; value: boolean | number }[];
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

/**
 * Inject one control event (`window.__bbs.simulatorControl`, plan §9.9). Returns
 * false when no session is executing or the component has no such control, which
 * is what the negative cases assert.
 */
export function simulatorControl(page: Page, componentId: string, controlId: string, value: boolean | number): Promise<boolean> {
  return page.evaluate(
    ([id, control, v]) =>
      (window as unknown as { __bbs: { simulatorControl: (a: string, b: string, c: boolean | number) => boolean } }).__bbs.simulatorControl(
        id as string,
        control as string,
        v as boolean | number
      ),
    [componentId, controlId, value] as const
  );
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

/**
 * Open the 视图 popover (issue #37). Display-only switches (孔号 / 针脚名 /
 * 导通高亮 / 聚焦选中 / 焊接面) live in there now, not in the main bar. It stays
 * open while you flip several of them; Esc or a click outside closes it.
 */
export async function openViewMenu(page: Page): Promise<void> {
  await page.getByTestId('view-menu').click();
  await expect(page.locator('.view-popover')).toBeVisible();
}

/**
 * Open the 接线选项 popover (issue #37). With the wire tool active, the colour
 * palette and the routing select moved off the main bar into a contextual
 * popover, so they have to be opened before use. The popover closes on a canvas
 * click, so re-open it after drawing if you need to change colour again.
 */
export async function openWireOptions(page: Page): Promise<void> {
  await page.getByTestId('wire-options').click();
  await expect(page.locator('.wire-options-popover')).toBeVisible();
}

/**
 * Grab a connected wire's endpoint on the canvas and drop it on another hole or
 * pin, the way a user re-plugs a jumper without deleting and redrawing the wire.
 */
export async function dragWireEnd(page: Page, wireId: string, end: 'from' | 'to', target: string): Promise<void> {
  const handle = page.locator(`[data-wire="${wireId}"][data-end="${end}"].wire-end-hit`).first();
  await handle.scrollIntoViewIfNeeded();
  const a = await handle.boundingBox();
  expect(a, `导线 ${wireId} 的 ${end} 端应当有可抓取的手柄`).not.toBeNull();
  const targetEl = page.locator(`[data-hole="${target}"], [data-pin="${target}"]`).first();
  const b = await targetEl.boundingBox();
  expect(b, `${target} 应当在画布上`).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 12 });
  await page.mouse.up();
}

/**
 * 面板宽度（issue #39）。`--panel-*-width` 是用户设定的宽度，折叠时写 0；面板在页面上
 * 实际占的宽度由 `panelWidth` 量（它就是布局后的盒子宽度，折叠后剩下边缘那条常驻轨道；
 * 该面板没渲染时是 0）。画布让出的宽度等于面板宽度的差值，而不是变量本身。
 */
export function panelWidthVar(page: Page, side: 'left' | 'right'): Promise<number> {
  return page.evaluate((s) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--panel-${s}-width`)), side);
}

export function panelWidth(page: Page, side: 'left' | 'right'): Promise<number> {
  return page.evaluate((s) => document.getElementById(`panel-${s}`)?.getBoundingClientRect().width ?? 0, side);
}

/** 画布列当前拿到的宽度（px）。折叠/拖拽面板时必须真的变，不能只是看着变了。 */
export function canvasWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect().width);
}

/** 布局视口宽度（不含滚动条）：两个面板与画布宽度之和就是它。 */
export function viewportWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.clientWidth);
}

/** 拖面板轨道（issue #39）：`outward > 0` = 把面板拖宽，左右两侧用同一个符号。 */
export async function dragPanelRail(page: Page, side: 'left' | 'right', outward: number): Promise<void> {
  const box = await page.getByTestId(`panel-rail-${side}`).boundingBox();
  expect(box, `${side} 面板的轨道应当可见可拖`).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (side === 'left' ? outward : -outward), y, { steps: 8 });
  await page.mouse.up();
}

/** 点面板轨道折叠 / 展开。 */
export async function togglePanelRail(page: Page, side: 'left' | 'right'): Promise<void> {
  await page.getByTestId(`panel-rail-${side}`).click();
}

export async function loadExample(page: Page, key: string): Promise<void> {
  await page.getByTestId('menu-project').click();
  await page.getByTestId(`example-${key}`).click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

export async function fit(page: Page): Promise<void> {
  await page.getByTestId('fit').click();
}

/**
 * Switch to 仿真: the transport and the 仿真 panel appear, the editing tools go
 * away. Waiting on `sim-run` is what makes the click synchronous for the caller.
 */
export async function enterSim(page: Page): Promise<void> {
  await page.getByTestId('mode-sim').click();
  await expect(page.getByTestId('sim-run')).toBeVisible();
}

/** Back to 搭建: any live session is stopped and the design is editable again. */
export async function enterBuild(page: Page): Promise<void> {
  await page.getByTestId('mode-build').click();
  await expect(page.getByTestId('tool-select')).toBeVisible();
}

/** Switch to 实机: the cable panel appears, and nothing that writes the design stays. */
export async function enterHardware(page: Page): Promise<void> {
  await page.getByTestId('mode-hardware').click();
  await expect(page.getByTestId('hardware-panel')).toBeVisible();
}

/** What the fake port recorded, so a test can check the wire and not just the screen. */
export interface FakeSerialState {
  opened: number[];
  signals: { dataTerminalReady?: boolean; requestToSend?: boolean }[];
  closes: number;
}

/**
 * Install a fake `navigator.serial` before the app loads.
 *
 * A headless browser has no board, but the code under test is the real one:
 * `browserSerialLink` opens this port, reads its stream and pulses its signals, so
 * the test covers the adapter and the line decoder, not a stand-in for them. Call
 * this before `fresh()` — support is detected when the module first evaluates.
 */
export async function fakeSerial(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Fake {
      cancelPicker?: boolean;
      failOpen?: string;
      emit(text: string): void;
      drop(reason: string): void;
      state(): { opened: number[]; signals: unknown[]; closes: number };
    }
    const recorded = { opened: [] as number[], signals: [] as unknown[], closes: 0 };
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stream: ReadableStream<Uint8Array> | null = null;
    const fake: Fake = {
      emit: (text) => controller?.enqueue(new TextEncoder().encode(text)),
      drop: (reason) => controller?.error(new Error(reason)),
      state: () => ({ opened: [...recorded.opened], signals: [...recorded.signals], closes: recorded.closes })
    };
    const port = {
      async open(options: { baudRate: number }) {
        if (fake.failOpen) throw new Error(fake.failOpen);
        recorded.opened.push(options.baudRate);
      },
      async close() {
        recorded.closes += 1;
        stream = null;
        controller = null;
      },
      async setSignals(signals: unknown) {
        recorded.signals.push(signals);
      },
      get readable() {
        stream ??= new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          }
        });
        return stream;
      }
    };
    (window as unknown as { __fakeSerial: Fake }).__fakeSerial = fake;
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: {
        async requestPort() {
          if (fake.cancelPicker) throw new Error('No port selected by the user.');
          return port;
        }
      }
    });
  });
}

/** Push one chunk of bytes out of the fake board. Newlines are the caller's business. */
export function emitSerial(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => (window as unknown as { __fakeSerial: { emit: (s: string) => void } }).__fakeSerial.emit(t), text);
}

export function fakeSerialState(page: Page): Promise<FakeSerialState> {
  return page.evaluate(() => (window as unknown as { __fakeSerial: { state: () => FakeSerialState } }).__fakeSerial.state());
}
