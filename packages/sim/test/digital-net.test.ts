import { describe, it, expect } from 'vitest';
import { DigitalNetKernel, resolveNet, type DigitalNetOptions } from '../src/digital-net.js';
import type { DigitalValue, SimDiagnostic, SimNet } from '../src/types.js';

/**
 * Plan §5.3, cases ① – ⑯. Two device pins on one wired net plus one pin that is
 * deliberately left off `pinToNet`, which is the shape stage 2 relies on.
 */
const NET_A = 'net_a';
const NET_B = 'net_b';

const NETS: SimNet[] = [
  { id: NET_A, members: ['mcu.GPIO8', 'oled.SDA'], pins: ['mcu.GPIO8', 'oled.SDA'], name: 'SDA' },
  { id: NET_B, members: ['mcu.GPIO9', 'oled.SCL'], pins: ['mcu.GPIO9', 'oled.SCL'] }
];

const PIN_TO_NET: Record<string, string> = {
  'mcu.GPIO8': NET_A,
  'oled.SDA': NET_A,
  'mcu.GPIO9': NET_B,
  'oled.SCL': NET_B
};

function makeKernel(overrides: Partial<DigitalNetOptions> = {}): { net: DigitalNetKernel; diagnostics: SimDiagnostic[]; setNow: (us: number) => void } {
  const diagnostics: SimDiagnostic[] = [];
  let nowUs = 0;
  const net = new DigitalNetKernel({
    nets: NETS,
    pinToNet: PIN_TO_NET,
    onDiagnostic: (d) => diagnostics.push(d),
    now: () => nowUs,
    ...overrides
  });
  return {
    net,
    diagnostics,
    setNow: (us) => {
      nowUs = us;
    }
  };
}

const MCU_SDA = { componentId: 'mcu', pin: 'GPIO8' };
const OLED_SDA = { componentId: 'oled', pin: 'SDA' };

describe('resolveNet (plan §5.1 truth table)', () => {
  it('① no driver, or every end released, resolves to Z', () => {
    expect(resolveNet([])).toEqual({ value: 'Z', contention: false });
    expect(resolveNet([{ value: 'Z', strength: 'strong' }, { value: 'Z', strength: 'pull' }])).toEqual({ value: 'Z', contention: false });
  });

  it('② a single strong driver wins', () => {
    expect(resolveNet([{ value: 0, strength: 'strong' }])).toEqual({ value: 0, contention: false });
    expect(resolveNet([{ value: 1, strength: 'strong' }])).toEqual({ value: 1, contention: false });
  });

  it('③ two strong drivers agreeing is not a contention', () => {
    expect(resolveNet([{ value: 1, strength: 'strong' }, { value: 1, strength: 'strong' }])).toEqual({ value: 1, contention: false });
  });

  it('④ a lone pull decides the net', () => {
    expect(resolveNet([{ value: 1, strength: 'pull' }])).toEqual({ value: 1, contention: false });
    expect(resolveNet([{ value: 1, strength: 'pull' }, { value: 'Z', strength: 'strong' }])).toEqual({ value: 1, contention: false });
    // weak is implemented even though stages 1-3 have no user for it.
    expect(resolveNet([{ value: 0, strength: 'weak' }, { value: 1, strength: 'pull' }])).toEqual({ value: 1, contention: false });
  });

  it('⑤ strong 0 beats pull 1 without a contention', () => {
    expect(resolveNet([{ value: 0, strength: 'strong' }, { value: 1, strength: 'pull' }])).toEqual({ value: 0, contention: false });
  });

  it('⑩ strong 0 against strong 1 is X', () => {
    expect(resolveNet([{ value: 0, strength: 'strong' }, { value: 1, strength: 'strong' }])).toEqual({ value: 'X', contention: true });
  });

  it('⑫ pull 0 against pull 1 is X as well (plan extension: no resistor values in v0.2)', () => {
    expect(resolveNet([{ value: 0, strength: 'pull' }, { value: 1, strength: 'pull' }])).toEqual({ value: 'X', contention: true });
  });
});

describe('DigitalNetKernel', () => {
  it('① an attached but undriven net reads Z', () => {
    const { net, diagnostics } = makeKernel();
    expect(net.attach(MCU_SDA)).toBe(NET_A);
    expect(net.valueOf(NET_A)).toBe<DigitalValue>('Z');
    expect(diagnostics).toEqual([]);
  });

  it('② a single strong driver sets the whole net', () => {
    const { net } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    net.drive(MCU_SDA, 1);
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(1);
    expect(net.readPin(OLED_SDA)).toBe<DigitalValue>(1);
  });

  it('③ two ends driving the same value raise nothing', () => {
    const { net, diagnostics } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    net.drive(MCU_SDA, 0);
    net.drive(OLED_SDA, 0);
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(0);
    expect(diagnostics).toEqual([]);
  });

  it('④ a lone pull 1 drives the net high', () => {
    const { net } = makeKernel();
    net.attach(MCU_SDA);
    net.drive(MCU_SDA, 1, 'pull');
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(1);
  });

  it('⑤ strong 0 wins over pull 1 on the same net', () => {
    const { net, diagnostics } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    net.drive(MCU_SDA, 1, 'pull');
    net.drive(OLED_SDA, 0, 'strong');
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(0);
    expect(diagnostics).toEqual([]);
  });

  it('⑥ an open-drain end clamps a written 1 to Z, and the pull-up takes over on release', () => {
    const { net, diagnostics } = makeKernel();
    net.attach(MCU_SDA, { openDrain: false });
    net.attach(OLED_SDA, { openDrain: true });
    net.drive(MCU_SDA, 1, 'pull'); // idle-high supplied by the controller side
    net.drive(OLED_SDA, 0, 'strong');
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(0);

    net.drive(OLED_SDA, 1, 'strong'); // clamped to Z at the writing end
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(1);
    const oled = net.view().find((v) => v.netId === NET_A)!.drivers.find((d) => d.componentId === 'oled')!;
    expect(oled.value).toBe<DigitalValue>('Z');
    expect(diagnostics).toEqual([]);
  });

  it('⑦ an unwired pin gets a private single-point net that stays Z and never shows in view()', () => {
    const { net } = makeKernel();
    const netId = net.attach({ componentId: 'touch', pin: 'IO' });
    expect(netId).toBe('unconnected:touch.IO');
    expect(net.netIdOf({ componentId: 'touch', pin: 'IO' })).toBe('unconnected:touch.IO');
    net.drive({ componentId: 'touch', pin: 'IO' }, 1);
    // The value is real on the private net, it simply reaches nobody.
    expect(net.valueOf('unconnected:touch.IO')).toBe<DigitalValue>(1);
    expect(net.view().map((v) => v.netId)).not.toContain('unconnected:touch.IO');
    expect(net.view({ includeUnconnected: true }).map((v) => v.netId)).toContain('unconnected:touch.IO');
  });

  it('⑧ a subscriber only hears about its own net, in registration order', () => {
    const { net } = makeKernel();
    net.attach(MCU_SDA);
    net.attach({ componentId: 'mcu', pin: 'GPIO9' });
    const seen: string[] = [];
    net.subscribe(NET_A, 'oled', (c) => seen.push(`a1:${c.from}->${c.to}`));
    net.subscribe(NET_A, 'oled', () => seen.push('a2'));
    net.subscribe(NET_B, 'oled', () => seen.push('b'));

    net.drive(MCU_SDA, 1);
    expect(seen).toEqual(['a1:Z->1', 'a2']);

    seen.length = 0;
    net.drive({ componentId: 'mcu', pin: 'GPIO9' }, 0);
    expect(seen).toEqual(['b']);
  });

  it('⑧ unsubscribing removes exactly one listener', () => {
    const { net } = makeKernel();
    net.attach(MCU_SDA);
    const seen: string[] = [];
    const off = net.subscribe(NET_A, 'oled', () => seen.push('first'));
    net.subscribe(NET_A, 'oled', () => seen.push('second'));
    off();
    net.drive(MCU_SDA, 1);
    expect(seen).toEqual(['second']);
  });

  it('⑧ a NetChange carries the current virtual time without advancing it', () => {
    const { net, setNow } = makeKernel();
    net.attach(MCU_SDA);
    setNow(1234);
    const changes: number[] = [];
    net.subscribe(NET_A, 'oled', (c) => changes.push(c.atUs));
    net.drive(MCU_SDA, 1);
    expect(changes).toEqual([1234]);
  });

  it('⑨ view() is stable: two calls are field-for-field equal and sorted', () => {
    const { net } = makeKernel();
    net.attach(OLED_SDA);
    net.attach(MCU_SDA);
    net.attach({ componentId: 'oled', pin: 'SCL' });
    net.attach({ componentId: 'mcu', pin: 'GPIO9' });
    net.attach({ componentId: 'touch', pin: 'IO' });
    net.drive(MCU_SDA, 1, 'pull');
    net.drive({ componentId: 'mcu', pin: 'GPIO9' }, 0);

    const first = net.view();
    const second = net.view();
    expect(second).toEqual(first);
    expect(first.map((v) => v.netId)).toEqual([NET_A, NET_B]);
    expect(first[0]!.name).toBe('SDA');
    expect(first[1]!.name).toBeUndefined();
    expect(first[0]!.drivers.map((d) => `${d.componentId}.${d.pin}`)).toEqual(['mcu.GPIO8', 'oled.SDA']);
    expect(first[0]!).toEqual({
      netId: NET_A,
      name: 'SDA',
      value: 1,
      drivers: [
        { componentId: 'mcu', pin: 'GPIO8', value: 1, strength: 'pull' },
        { componentId: 'oled', pin: 'SDA', value: 'Z', strength: 'strong' }
      ]
    });
  });

  it('⑩ strong 0 against strong 1 is X and raises exactly one digital_contention', () => {
    const { net, diagnostics, setNow } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    setNow(500);
    net.drive(MCU_SDA, 0);
    net.drive(OLED_SDA, 1);
    expect(net.valueOf(NET_A)).toBe<DigitalValue>('X');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'digital_contention',
      severity: 'warning',
      atUs: 500,
      netIds: [NET_A],
      componentIds: ['mcu', 'oled'],
      pinAddresses: ['mcu.GPIO8', 'oled.SDA']
    });
    // Still deduped while the condition holds.
    net.drive(MCU_SDA, 0);
    expect(diagnostics).toHaveLength(1);
  });

  it('⑪ conflict → recovery → conflict produces exactly two diagnostics', () => {
    const { net, diagnostics } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    net.drive(MCU_SDA, 0);
    net.drive(OLED_SDA, 1);
    expect(diagnostics).toHaveLength(1);

    net.drive(OLED_SDA, 'Z'); // recovered: the net is 0 again
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(0);
    expect(diagnostics).toHaveLength(1);

    net.drive(OLED_SDA, 1); // conflicting again: re-armed, so it reports again
    expect(net.valueOf(NET_A)).toBe<DigitalValue>('X');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.code)).toEqual(['digital_contention', 'digital_contention']);
  });

  it('⑫ pull 0 against pull 1 is X in the kernel too', () => {
    const { net, diagnostics } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    net.drive(MCU_SDA, 0, 'pull');
    net.drive(OLED_SDA, 1, 'pull');
    expect(net.valueOf(NET_A)).toBe<DigitalValue>('X');
    expect(diagnostics.map((d) => d.code)).toEqual(['digital_contention']);
  });

  it('⑬ reading a floating net returns Z with exactly one floating_input and never throws', () => {
    const { net, diagnostics, setNow } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    setNow(42);

    expect(net.readPin(MCU_SDA, { diagnose: true })).toBe<DigitalValue>('Z');
    expect(net.readPin(MCU_SDA, { diagnose: true })).toBe<DigitalValue>('Z');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'floating_input',
      severity: 'warning',
      atUs: 42,
      componentIds: ['mcu'],
      pinAddresses: ['mcu.GPIO8'],
      netIds: [NET_A]
    });
    // warning, never error: the controller must not fault the session for it.
    expect(diagnostics.every((d) => d.severity !== 'error')).toBe(true);

    // Re-armed once the net stops floating, so a later float reports again.
    net.drive(OLED_SDA, 1);
    expect(net.readPin(MCU_SDA, { diagnose: true })).toBe<DigitalValue>(1);
    expect(diagnostics).toHaveLength(1);
    net.drive(OLED_SDA, 'Z');
    expect(net.readPin(MCU_SDA, { diagnose: true })).toBe<DigitalValue>('Z');
    expect(diagnostics).toHaveLength(2);
  });

  it('⑬ reading without diagnose stays silent, and an X read reports contention', () => {
    const { net, diagnostics } = makeKernel();
    net.attach(MCU_SDA);
    net.attach(OLED_SDA);
    expect(net.readPin(MCU_SDA)).toBe<DigitalValue>('Z');
    expect(diagnostics).toEqual([]);

    const other = makeKernel();
    other.net.attach(MCU_SDA);
    other.net.attach(OLED_SDA);
    other.net.attach({ componentId: 'touch', pin: 'IO' });
    // Contention raised by the solver, then read by a third party.
    other.net.drive(MCU_SDA, 0);
    other.net.drive(OLED_SDA, 1);
    other.diagnostics.length = 0;
    expect(other.net.readPin({ componentId: 'oled', pin: 'SDA' }, { diagnose: true })).toBe<DigitalValue>('X');
    expect(other.diagnostics.map((d) => d.code)).toEqual(['digital_contention']);
  });

  it('⑭ driving X throws: that is a kernel bug, not a user error', () => {
    const { net } = makeKernel();
    net.attach(MCU_SDA);
    expect(() => net.drive(MCU_SDA, 'X')).toThrow(/X/);
    expect(net.valueOf(NET_A)).toBe<DigitalValue>('Z');
  });

  it('⑮ two mutually inverting listeners terminate with execution_budget_exceeded', () => {
    const { net, diagnostics } = makeKernel({ maxSettleRounds: 8 });
    const a = { componentId: 'mcu', pin: 'GPIO8' };
    const b = { componentId: 'mcu', pin: 'GPIO9' };
    net.attach(a);
    net.attach(b);
    // A copies onto B, B inverts back onto A: the pair can never settle.
    net.subscribe(NET_A, 'oled', (c) => net.drive(b, c.to === 1 ? 1 : 0));
    net.subscribe(NET_B, 'oled', (c) => net.drive(a, c.to === 1 ? 0 : 1));

    net.drive(a, 1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'execution_budget_exceeded', severity: 'error' });
    expect(diagnostics[0]!.netIds!.length).toBeGreaterThan(0);
  });

  it('⑮ a listener that drives once does not trip the oscillation guard', () => {
    const { net, diagnostics } = makeKernel();
    const a = { componentId: 'mcu', pin: 'GPIO8' };
    const b = { componentId: 'mcu', pin: 'GPIO9' };
    net.attach(a);
    net.attach(b);
    net.subscribe(NET_A, 'oled', (c) => net.drive(b, c.to === 1 ? 1 : 0));
    net.drive(a, 1);
    expect(net.valueOf(NET_B)).toBe<DigitalValue>(1);
    expect(diagnostics).toEqual([]);
  });

  it('⑯ an unpowered device drives Z on every end and is restored when power returns', () => {
    const { net } = makeKernel();
    net.attach(MCU_SDA);
    net.attach({ componentId: 'mcu', pin: 'GPIO9' });
    net.attach(OLED_SDA);
    net.drive(MCU_SDA, 1);
    net.drive({ componentId: 'mcu', pin: 'GPIO9' }, 0);
    net.drive(OLED_SDA, 0, 'pull');

    const changes: string[] = [];
    net.subscribe(NET_A, 'oled', (c) => changes.push(`${c.from}->${c.to}`));

    net.setDevicePowered('mcu', false);
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(0); // only the oled pull is left
    expect(net.valueOf(NET_B)).toBe<DigitalValue>('Z');
    const mcuDriver = net.view().find((v) => v.netId === NET_A)!.drivers.find((d) => d.componentId === 'mcu')!;
    expect(mcuDriver.value).toBe<DigitalValue>('Z');
    expect(changes).toEqual(['1->0']);

    net.setDevicePowered('mcu', true);
    expect(net.valueOf(NET_A)).toBe<DigitalValue>(1);
    expect(net.valueOf(NET_B)).toBe<DigitalValue>(0);
    expect(changes).toEqual(['1->0', '0->1']);
  });

  it('⑯ an unpowered reader gets Z without a floating_input (that Z is expected)', () => {
    const { net, diagnostics } = makeKernel();
    net.attach(OLED_SDA);
    net.setDevicePowered('oled', false);
    expect(net.readPin(OLED_SDA, { diagnose: true })).toBe<DigitalValue>('Z');
    expect(diagnostics).toEqual([]);
  });
});

describe('edge trace', () => {
  it('records only real changes, and draining empties it', () => {
    const kernel = new DigitalNetKernel({
      nets: [{ id: 'n1', members: [], pins: [] }],
      pinToNet: { 'a.P': 'n1', 'b.P': 'n1' },
      onDiagnostic: () => {},
      now: () => clock
    });
    let clock = 0;
    kernel.attach({ componentId: 'a', pin: 'P' });
    kernel.attach({ componentId: 'b', pin: 'P' });

    clock = 100;
    kernel.drive({ componentId: 'a', pin: 'P' }, 1);
    clock = 200;
    kernel.drive({ componentId: 'a', pin: 'P' }, 1); // same value: not an edge
    clock = 300;
    kernel.drive({ componentId: 'a', pin: 'P' }, 0);

    const first = kernel.drainTransitions();
    expect(first.transitions).toEqual([
      { netId: 'n1', atUs: 100, value: 1 },
      { netId: 'n1', atUs: 300, value: 0 }
    ]);
    expect(first.dropped).toBe(0);
    expect(kernel.drainTransitions().transitions, 'draining is destructive').toEqual([]);
  });

  it('drops the oldest edge when the buffer fills, and counts what it dropped', () => {
    let clock = 0;
    const kernel = new DigitalNetKernel({
      nets: [{ id: 'n1', members: [], pins: [] }],
      pinToNet: { 'a.P': 'n1' },
      onDiagnostic: () => {},
      now: () => clock,
      traceCapacity: 3
    });
    kernel.attach({ componentId: 'a', pin: 'P' });
    for (let i = 1; i <= 6; i++) {
      clock = i * 10;
      kernel.drive({ componentId: 'a', pin: 'P' }, i % 2 === 1 ? 1 : 0);
    }

    const drained = kernel.drainTransitions();
    // A hole in the timeline must never be silent, so the count is part of the result.
    expect(drained.transitions.map((t) => t.atUs)).toEqual([40, 50, 60]);
    expect(drained.dropped).toBe(3);
  });
});
