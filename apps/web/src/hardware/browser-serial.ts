/**
 * The one part of the hardware feature that needs a browser and a board.
 *
 * Everything above it works against `SerialLink`, so the panel, the buffer and the
 * decoder are all testable without either. Nothing here touches the simulator: a
 * real board's pins are wired to whatever is physically on the user's desk, and the
 * app's modelled OLED and sensors are not in that circuit.
 */
import { LineDecoder, type SerialLink } from './serial-link';

/** The slice of Web Serial this uses, so the file states its own dependency. */
interface WebSerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
}

interface WebSerial {
  requestPort(): Promise<WebSerialPort>;
}

export interface BrowserSerialOptions {
  onLines(lines: readonly string[]): void;
  /** Called when the read loop ends — cable pulled, board reset, or a close. */
  onClosed(reason: string | null): void;
  /** Injected in tests; defaults to the real `navigator.serial`. */
  serial?: WebSerial;
  /** How long EN is held low for a reset pulse. */
  resetHoldMs?: number;
}

/**
 * The classic ESP dev-board auto-reset circuit maps RTS → EN and DTR → IO0, both
 * active low through a transistor pair, so asserting RTS alone pulls EN down and
 * releases it into a **normal** boot. DTR is held de-asserted deliberately: pulling
 * IO0 down as well is what puts the chip into download mode instead.
 *
 * A board connected through its **native** USB port has no such circuit at all, so
 * this is a no-op there — which is why the UI says "pulse reset" rather than
 * promising the board restarted.
 */
const RESET_HOLD_MS = 100;

export function browserSerialLink(options: BrowserSerialOptions): SerialLink {
  const serial = options.serial ?? (navigator as unknown as { serial: WebSerial }).serial;
  const holdMs = options.resetHoldMs ?? RESET_HOLD_MS;

  let port: WebSerialPort | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let closing = false;

  async function pump(): Promise<void> {
    const decoder = new LineDecoder();
    let reason: string | null = null;
    try {
      for (;;) {
        const active = reader;
        if (!active) break;
        const { value, done } = await active.read();
        if (done) break;
        if (value) {
          const lines = decoder.push(value);
          if (lines.length) options.onLines(lines);
        }
      }
    } catch (e) {
      // A yanked cable surfaces here; it is information, not a crash.
      if (!closing) reason = (e as Error).message;
    } finally {
      const rest = decoder.flush();
      if (rest.length) options.onLines(rest);
      options.onClosed(reason);
    }
  }

  return {
    get connected() {
      return port !== null;
    },

    async open(baudRate: number) {
      if (port) return;
      // `requestPort` must be called from a user gesture and shows the browser's own
      // picker; a cancelled dialog rejects, which the caller reports as "no port".
      const chosen = await serial.requestPort();
      await chosen.open({ baudRate });
      port = chosen;
      closing = false;
      const readable = chosen.readable;
      if (!readable) {
        port = null;
        throw new Error('串口已打开但不可读取');
      }
      reader = readable.getReader();
      void pump();
    },

    async close() {
      closing = true;
      const active = reader;
      reader = null;
      if (active) {
        try {
          await active.cancel();
        } catch {
          // already gone
        }
        active.releaseLock();
      }
      const open = port;
      port = null;
      if (open) await open.close();
    },

    async pulseReset() {
      if (!port) throw new Error('还没有连接串口');
      await port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await port.setSignals({ requestToSend: false });
    }
  };
}
