import { describe, it, expect } from 'vitest';
import { OUTBOX_INTERVALS_MS, Outbox, type OutboxChannel } from '../src/worker/outbox.js';
import { SIM_PROTOCOL_VERSION, type DeviceVisualState, type RuntimeMessage } from '../src/types.js';
import type { WallClock } from '../src/contracts.js';

/** Hand-advanced wall clock: no `vi.useFakeTimers()`, no real time anywhere. */
class TestClock implements WallClock {
  private ms = 0;
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

function harness(sessionId = 'session-1'): { clock: TestClock; outbox: Outbox; batches: RuntimeMessage[][] } {
  const clock = new TestClock();
  const batches: RuntimeMessage[][] = [];
  const outbox = new Outbox({ clock, sessionId, emit: (messages) => batches.push(messages) });
  return { clock, outbox, batches };
}

function led(feature: string, on: boolean): DeviceVisualState {
  return { kind: 'led', feature, rgb: on ? [255, 255, 255] : [0, 0, 0], intensity: on ? 1 : 0 };
}

/** Number of batches (postMessage calls) that carried at least one message of `channel`. */
function sendsOf(batches: RuntimeMessage[][], channel: OutboxChannel): number {
  return batches.filter((batch) => batch.some((message) => message.type === channel)).length;
}

function messagesOf<K extends OutboxChannel>(batches: RuntimeMessage[][], channel: K): Extract<RuntimeMessage, { type: K }>[] {
  return batches.flat().filter((message): message is Extract<RuntimeMessage, { type: K }> => message.type === channel);
}

describe('Outbox', () => {
  it('⑫ keeps every channel under the spec §14 refresh ceilings over 1000 ms of 16 ms ticks', () => {
    const { clock, outbox, batches } = harness();
    let ticks = 0;
    for (let ms = 0; ms < 1000; ms += 16) {
      ticks += 1;
      outbox.post({ type: 'visual-diff', states: { mcu: [led('RGB', ms % 32 === 0)] } });
      outbox.post({ type: 'serial', componentId: 'mcu', stream: 'stdout', text: `line ${ms}\n`, atUs: ms * 1000 });
      outbox.post({ type: 'status', status: 'running', nowUs: ms * 1000 });
      outbox.post({ type: 'io-snapshot', nets: [] });
      outbox.post({ type: 'profile', eventsPerSecond: 100, queueDepth: 1 });
      outbox.post({ type: 'diagnostic', diagnostic: { code: 'floating_input', severity: 'warning', message: `t=${ms}` } });
      outbox.tick();
      clock.advance(16);
    }
    expect(ticks).toBe(63);

    // Spec §14: OLED refresh ≤ 30 FPS, serial refresh ≤ 20 FPS.
    expect(sendsOf(batches, 'visual-diff')).toBeLessThanOrEqual(30);
    expect(sendsOf(batches, 'serial')).toBeLessThanOrEqual(20);
    // Exact quantisation of a 16 ms tick against each threshold (plan §4.6):
    // 48 / 64 / 112 / 208 / 512 ms actual intervals.
    expect(sendsOf(batches, 'visual-diff')).toBe(21);
    expect(sendsOf(batches, 'serial')).toBe(16);
    expect(sendsOf(batches, 'status')).toBe(9);
    expect(sendsOf(batches, 'io-snapshot')).toBe(5);
    expect(sendsOf(batches, 'profile')).toBe(2);

    // Throttling delays serial, it never drops or merges lines: the two lines
    // produced after the last send (t=976, t=992) are still queued.
    expect(messagesOf(batches, 'serial')).toHaveLength(61);
    outbox.flush();
    expect(messagesOf(batches, 'serial')).toHaveLength(63);
    // Diagnostics are evidence: they are queued but never throttled.
    expect(sendsOf(batches, 'diagnostic')).toBe(63);
    expect(messagesOf(batches, 'diagnostic')).toHaveLength(63);
  });

  it('merges visual-diff by componentId and stamps its own revision', () => {
    const { clock, outbox, batches } = harness();
    outbox.post({ type: 'visual-diff', states: { mcu: [led('RGB', false)], touch: [{ kind: 'pressed', feature: '触摸区', active: false }] } });
    // Same component posted twice in one window: the newer array wins wholesale.
    outbox.post({ type: 'visual-diff', states: { mcu: [led('RGB', true), { kind: 'pressed', feature: 'BOOT', active: true }] } });
    outbox.flush();

    const first = messagesOf(batches, 'visual-diff')[0];
    expect(Object.keys(first.states).sort()).toEqual(['mcu', 'touch']);
    expect(first.states.mcu).toHaveLength(2);
    expect(first.states.mcu[0]).toMatchObject({ kind: 'led', intensity: 1 });
    expect(first.states.touch).toHaveLength(1);
    expect(first.revision).toBe(1);

    clock.advance(1000);
    outbox.post({ type: 'visual-diff', states: { mcu: [led('RGB', false)] } });
    outbox.tick();
    const second = messagesOf(batches, 'visual-diff')[1];
    expect(second.revision).toBe(2);
    // The merge map is emptied on send, so an untouched component is not resent.
    expect(Object.keys(second.states)).toEqual(['mcu']);
  });

  it('batches serial lines without concatenating them', () => {
    const { outbox, batches } = harness();
    outbox.post({ type: 'serial', componentId: 'mcu', stream: 'stdout', text: 'Ready\n', atUs: 10 });
    outbox.post({ type: 'serial', componentId: 'mcu', stream: 'stdout', text: 'Touched\n', atUs: 20 });
    outbox.post({ type: 'serial', componentId: 'mcu', stream: 'stderr', text: 'oops\n', atUs: 30 });
    outbox.tick();

    expect(batches).toHaveLength(1);
    const lines = messagesOf(batches, 'serial');
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.text)).toEqual(['Ready\n', 'Touched\n', 'oops\n']);
    expect(lines.map((line) => line.atUs)).toEqual([10, 20, 30]);
    expect(lines[2].stream).toBe('stderr');
  });

  it('stamps the envelope on every message and emits one batch per drain', () => {
    const { outbox, batches } = harness('session-42');
    outbox.post({ type: 'status', status: 'paused', nowUs: 500 });
    outbox.post({ type: 'serial', componentId: 'mcu', stream: 'stdout', text: 'x\n', atUs: 1 });
    outbox.flush();
    expect(batches).toHaveLength(1);
    for (const message of batches[0]) {
      expect(message.protocol).toBe(SIM_PROTOCOL_VERSION);
      expect(message.sessionId).toBe('session-42');
    }
    // Payload channels are emitted before the status that describes them.
    expect(batches[0].map((message) => message.type)).toEqual(['serial', 'status']);
  });

  it('coalesces status, io-snapshot and profile to the newest value', () => {
    const { outbox, batches } = harness();
    outbox.post({ type: 'status', status: 'running', nowUs: 1 });
    outbox.post({ type: 'status', status: 'running', nowUs: 2 });
    outbox.post({ type: 'status', status: 'paused', nowUs: 3 });
    outbox.post({ type: 'profile', eventsPerSecond: 1, queueDepth: 1 });
    outbox.post({ type: 'profile', eventsPerSecond: 2, queueDepth: 2 });
    outbox.flush();
    expect(messagesOf(batches, 'status')).toHaveLength(1);
    expect(messagesOf(batches, 'status')[0]).toMatchObject({ status: 'paused', nowUs: 3 });
    expect(messagesOf(batches, 'profile')).toHaveLength(1);
    expect(messagesOf(batches, 'profile')[0]).toMatchObject({ eventsPerSecond: 2 });
  });

  it('flush() ignores the intervals, re-arms them and emits nothing when empty', () => {
    const { clock, outbox, batches } = harness();
    outbox.post({ type: 'status', status: 'running', nowUs: 0 });
    outbox.tick();
    expect(batches).toHaveLength(1);

    // Well inside the 100 ms status window: a tick sends nothing, flush does.
    clock.advance(5);
    outbox.post({ type: 'status', status: 'paused', nowUs: 7 });
    outbox.tick();
    expect(batches).toHaveLength(1);
    expect(outbox.pending).toBe(1);
    outbox.flush();
    expect(batches).toHaveLength(2);
    expect(outbox.pending).toBe(0);

    // Nothing pending: no empty postMessage.
    outbox.flush();
    outbox.tick();
    expect(batches).toHaveLength(2);

    // The forced flush re-armed the window, so the next send waits again.
    clock.advance(50);
    outbox.post({ type: 'status', status: 'running', nowUs: 9 });
    outbox.tick();
    expect(batches).toHaveLength(2);
    clock.advance(60);
    outbox.tick();
    expect(batches).toHaveLength(3);
  });

  it('clear() drops pending content without sending it', () => {
    const { outbox, batches } = harness();
    outbox.post({ type: 'serial', componentId: 'mcu', stream: 'stdout', text: 'gone\n', atUs: 1 });
    outbox.post({ type: 'visual-diff', states: { mcu: [led('RGB', true)] } });
    expect(outbox.pending).toBe(2);
    outbox.clear();
    expect(outbox.pending).toBe(0);
    outbox.flush();
    expect(batches).toHaveLength(0);
  });

  it('pins the per-channel intervals from plan §4.6', () => {
    expect(OUTBOX_INTERVALS_MS).toEqual({ 'visual-diff': 33, serial: 50, status: 100, 'io-snapshot': 200, profile: 500, diagnostic: 0 });
  });
});
