/**
 * Talking to a real board over Web Serial (阶段 5 RFC §5.1).
 *
 * This is deliberately **not** a `SimulationBackend` and must never be registered
 * as one. It cannot supply five of that interface's ten methods — `pause`, `step`,
 * `reset` in virtual time, `setSpeed` and `setBreakpoints` — because there is no
 * clock to drive and no way to halt a real MCU at a net transition. Pretending
 * otherwise is the exact failure the RFC declined phase 5 to avoid.
 *
 * What it does do is small and true: open the port the user picks, decode its bytes
 * into lines, and pulse the reset line. The simulated OLED and sensors are **not**
 * in that circuit — the board's pins are wired to whatever is physically on the
 * user's desk — so nothing here feeds the device models.
 *
 * The Web Serial calls sit behind `SerialLink` so the logic above them is testable
 * without a browser or a board; `browserSerialLink()` is the only part that needs
 * either.
 */

/** Why the hardware panel cannot run, in the user's terms. */
export type SerialSupport =
  | { supported: true }
  | { supported: false; reason: 'no-api'; message: string }
  | { supported: false; reason: 'insecure-context'; message: string };

/**
 * Web Serial exists only in Chromium-family browsers and only in a secure context.
 * Both failures are reported rather than hidden: a button that silently does
 * nothing is worse than a sentence explaining why the browser cannot do this.
 */
export function detectSerialSupport(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator, secure = typeof window === 'undefined' ? true : window.isSecureContext): SerialSupport {
  const hasApi = !!nav && typeof nav === 'object' && 'serial' in (nav as Record<string, unknown>);
  if (!hasApi) {
    return {
      supported: false,
      reason: 'no-api',
      message: '这个浏览器没有 Web Serial：目前只有 Chrome、Edge 等 Chromium 系浏览器支持它，Firefox 与 Safari 都没有实现。'
    };
  }
  if (!secure) {
    return {
      supported: false,
      reason: 'insecure-context',
      message: 'Web Serial 只在安全上下文里可用：请通过 https:// 或 http://localhost 打开本页。'
    };
  }
  return { supported: true };
}

/** Baud rates worth offering; 115200 is what every ESP-IDF example prints at. */
export const BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600] as const;
export const DEFAULT_BAUD = 115200;

export interface SerialLink {
  /** Ask the user to pick a port and open it. Rejects if they cancel. */
  open(baudRate: number): Promise<void>;
  close(): Promise<void>;
  /** Pulse DTR/RTS the way esptool does to reset the board. */
  pulseReset(): Promise<void>;
  readonly connected: boolean;
}

/**
 * Incremental byte → line decoder.
 *
 * Serial data arrives in arbitrary chunks: a line can be split across three of
 * them and a multi-byte UTF-8 character across two. `TextDecoder` with
 * `{ stream: true }` holds a partial character until its rest arrives, and the
 * tail buffer here does the same for a partial line — so a line is only emitted
 * once it is complete, never in halves.
 */
export class LineDecoder {
  private readonly decoder = new TextDecoder('utf-8');
  private tail = '';

  /** Complete lines in `chunk`, with the trailing partial one held back. */
  push(chunk: Uint8Array): string[] {
    this.tail += this.decoder.decode(chunk, { stream: true });
    const parts = this.tail.split('\n');
    // The last element is whatever came after the final newline — a partial line.
    this.tail = parts.pop() ?? '';
    return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  /** Whatever is still buffered, for when the port closes mid-line. */
  flush(): string[] {
    const rest = this.tail + this.decoder.decode();
    this.tail = '';
    if (!rest) return [];
    return [rest.endsWith('\r') ? rest.slice(0, -1) : rest];
  }
}

/** One line of output, with the moment it was received. */
export interface SerialLine {
  text: string;
  /** Wall-clock milliseconds. Real hardware has no virtual clock — that is the point. */
  atMs: number;
}

/** Keep the console bounded; a board printing at 115200 fills memory otherwise. */
export const MAX_LINES = 2000;

export function appendLines(existing: readonly SerialLine[], incoming: readonly SerialLine[]): SerialLine[] {
  const merged = [...existing, ...incoming];
  return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
}
