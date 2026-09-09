import { beforeEach, describe, expect, it } from 'vitest';
import { setSerialLinkFactory, useHardwareStore } from './hardwareStore';
import type { SerialLink } from './serial-link';

/** A link the test drives by hand: no browser, no board, no timers. */
function fakeLink(behaviour: { failOpen?: string; failReset?: string } = {}) {
  const calls: string[] = [];
  let emit: ((lines: readonly string[]) => void) | null = null;
  let close: ((reason: string | null) => void) | null = null;
  let open = false;

  const factory = (options: { onLines: (l: readonly string[]) => void; onClosed: (r: string | null) => void }): SerialLink => {
    emit = options.onLines;
    close = options.onClosed;
    return {
      get connected() {
        return open;
      },
      async open(baudRate: number) {
        calls.push(`open:${baudRate}`);
        if (behaviour.failOpen) throw new Error(behaviour.failOpen);
        open = true;
      },
      async close() {
        calls.push('close');
        open = false;
      },
      async pulseReset() {
        calls.push('reset');
        if (behaviour.failReset) throw new Error(behaviour.failReset);
      }
    };
  };
  return {
    factory,
    calls,
    receive: (...lines: string[]) => emit?.(lines),
    drop: (reason: string | null) => close?.(reason)
  };
}

const reset = () => useHardwareStore.setState({ status: 'disconnected', lines: [], error: null, support: { supported: true } });

beforeEach(() => {
  setSerialLinkFactory(null);
  reset();
});

describe('hardware connection', () => {
  it('opens at the chosen baud rate and collects what the board prints', async () => {
    const fake = fakeLink();
    setSerialLinkFactory(fake.factory);
    useHardwareStore.getState().setBaudRate(9600);

    await useHardwareStore.getState().connect();
    expect(useHardwareStore.getState().status).toBe('connected');
    expect(fake.calls).toEqual(['open:9600']);

    fake.receive('boot', 'ready');
    const lines = useHardwareStore.getState().lines;
    expect(lines.map((l) => l.text)).toEqual(['boot', 'ready']);
    // Wall-clock, not virtual time: this board has no clock we drive.
    expect(lines[0]!.atMs).toBeGreaterThan(0);

    await useHardwareStore.getState().disconnect();
    expect(useHardwareStore.getState().status).toBe('disconnected');
    expect(fake.calls).toContain('close');
  });

  it('treats a cancelled port picker as "no port", not as a failure to shout about', async () => {
    setSerialLinkFactory(fakeLink({ failOpen: 'No port selected by the user.' }).factory);
    await useHardwareStore.getState().connect();
    expect(useHardwareStore.getState().status).toBe('disconnected');
    expect(useHardwareStore.getState().error).toBe('没有选择串口。');
  });

  it('reports a real open failure with its reason', async () => {
    setSerialLinkFactory(fakeLink({ failOpen: 'The device is already open.' }).factory);
    await useHardwareStore.getState().connect();
    expect(useHardwareStore.getState().error).toContain('The device is already open.');
  });

  it('surfaces a yanked cable instead of pretending it is still connected', async () => {
    const fake = fakeLink();
    setSerialLinkFactory(fake.factory);
    await useHardwareStore.getState().connect();
    fake.receive('running');

    fake.drop('The device has been lost.');
    expect(useHardwareStore.getState().status).toBe('disconnected');
    expect(useHardwareStore.getState().error).toContain('连接已断开');
    expect(useHardwareStore.getState().lines.map((l) => l.text), 'what it printed is kept').toEqual(['running']);
  });

  it('refuses to connect when the browser cannot, and says why', async () => {
    useHardwareStore.setState({ support: { supported: false, reason: 'no-api', message: '这个浏览器没有 Web Serial' } });
    const fake = fakeLink();
    setSerialLinkFactory(fake.factory);

    await useHardwareStore.getState().connect();
    expect(useHardwareStore.getState().status).toBe('disconnected');
    expect(useHardwareStore.getState().error).toContain('Web Serial');
    expect(fake.calls, 'it never even tried').toEqual([]);
  });

  it('only pulses reset while connected, and reports a failure', async () => {
    const fake = fakeLink();
    setSerialLinkFactory(fake.factory);
    await useHardwareStore.getState().pulseReset();
    expect(fake.calls, 'nothing to reset while disconnected').toEqual([]);

    await useHardwareStore.getState().connect();
    await useHardwareStore.getState().pulseReset();
    expect(fake.calls).toContain('reset');

    setSerialLinkFactory(fakeLink({ failReset: 'signals unsupported' }).factory);
    reset();
    const failing = fakeLink({ failReset: 'signals unsupported' });
    setSerialLinkFactory(failing.factory);
    await useHardwareStore.getState().connect();
    await useHardwareStore.getState().pulseReset();
    expect(useHardwareStore.getState().error).toContain('复位失败');
  });

  it('clears the console without touching the connection', async () => {
    const fake = fakeLink();
    setSerialLinkFactory(fake.factory);
    await useHardwareStore.getState().connect();
    fake.receive('a', 'b');
    useHardwareStore.getState().clear();
    expect(useHardwareStore.getState().lines).toEqual([]);
    expect(useHardwareStore.getState().status, 'still connected').toBe('connected');
  });
});
