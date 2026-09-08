import { describe, it, expect } from 'vitest';
import type { DesignDocument } from '@breadboard-studio/schema';
import type { Op } from '../src/index.js';
import { analyzeDesign, groupHoles, holeAddress, parseResistance, pinKey } from '../src/index.js';
import { build, oneBoard } from './helpers.js';

/**
 * A resistor conducts, and that is *not* the same as being one node.
 *
 * `internal_nets` — the obvious mechanism — would have been wrong twice over: it
 * would make a supply-to-ground resistor look like a dead short, and it would
 * silence `pins_shorted_by_board` for a resistor whose legs sit in one column,
 * which is a real mistake. So conduction joins `full` (current can flow) and
 * leaves `direct` (the same electrical node) alone, and each rule picks the one
 * it actually means.
 */

const MCU: Op = {
  op: 'add_component',
  component: { id: 'mcu', model: 'xiao_esp32s3_sense@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 } }
};

/**
 * A free hole in the same five-hole group as `componentId.pin` — where you would
 * actually put the wire, since the pin's own hole is taken.
 */
function tapPoint(design: DesignDocument, componentId: string, pin: string): string {
  const model = analyzeDesign(design).model;
  const placed = model.components.get(componentId)!.pins.find((p) => p.name === pin);
  if (!placed?.hole) throw new Error(`${componentId}.${pin} is not in a hole`);
  const occupied = new Set(
    [...model.components.values()].flatMap((pc) => pc.pins.filter((p) => p.hole).map((p) => holeAddress(p.hole!.board_id, p.hole!.hole)))
  );
  const free = groupHoles(model, holeAddress(placed.hole.board_id, placed.hole.hole)).find((h) => !occupied.has(h));
  if (!free) throw new Error(`no free hole beside ${componentId}.${pin}`);
  return free;
}

/** MCU 3V3 → resistor → MCU GND, the circuit the whole question is about. */
function railToRailThrough(value: string | undefined, span = 4): DesignDocument {
  const base = build([...oneBoard, MCU]);
  const p1Hole = 'e10';
  const withResistor = build(
    [
      {
        op: 'add_component',
        component: {
          id: 'r1',
          model: 'resistor_axial@1',
          placement: { kind: 'board', board_id: 'bb', anchor_hole: p1Hole, anchor_pin: 'P1', rotation_deg: 0 },
          ...(value === undefined ? {} : { params: { value, span_pitches: span } })
        }
      }
    ],
    base,
    true
  );
  return build(
    [
      { op: 'add_wire', wire: { id: 'w_pos', from: { hole: tapPoint(withResistor, 'mcu', '3V3') }, to: { hole: tapPoint(withResistor, 'r1', 'P1') }, color: 'red' } },
      { op: 'add_wire', wire: { id: 'w_gnd', from: { hole: tapPoint(withResistor, 'mcu', 'GND') }, to: { hole: tapPoint(withResistor, 'r1', 'P2') }, color: 'black' } }
    ],
    withResistor,
    true
  );
}

describe('parseResistance', () => {
  it('reads the forms actually printed on parts', () => {
    expect(parseResistance('220')).toBe(220);
    expect(parseResistance('4.7k')).toBe(4700);
    expect(parseResistance('4k7'), 'the multiplier standing in for the decimal point').toBe(4700);
    expect(parseResistance('1M')).toBe(1_000_000);
    expect(parseResistance('10K')).toBe(10_000);
    expect(parseResistance('330 ohm')).toBe(330);
    expect(parseResistance('470Ω')).toBe(470);
    expect(parseResistance(1000)).toBe(1000);
  });

  it('returns null rather than inventing a number', () => {
    for (const bad of ['', '  ', 'brown-black-red', 'k', '4.7kk', null, undefined, {}, NaN]) {
      expect(parseResistance(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('a resistor conducts without being one node', () => {
  it('joins its legs where current flows, but not where identity matters', () => {
    const conn = analyzeDesign(railToRailThrough('220')).connectivity;
    const p1 = pinKey('r1', 'P1');
    const p2 = pinKey('r1', 'P2');
    expect(conn.full.connected(p1, p2), 'current can get across').toBe(true);
    expect(conn.direct.connected(p1, p2), 'but they are not the same node').toBe(false);
    expect(conn.conducted).toEqual([{ componentId: 'r1', kind: 'resistor', pins: ['P1', 'P2'], ohms: 220, marking: '220' }]);
    // and the supply really does reach ground through it
    expect(conn.full.connected(pinKey('mcu', '3V3'), pinKey('mcu', 'GND'))).toBe(true);
    expect(conn.direct.connected(pinKey('mcu', '3V3'), pinKey('mcu', 'GND'))).toBe(false);
  });

  it('is a load, not a short, and reports the current it draws', () => {
    const a = analyzeDesign(railToRailThrough('220'));
    expect(a.results.some((r) => r.code === 'power_ground_short'), 'a resistor is not a short').toBe(false);
    const load = a.results.find((r) => r.code === 'passive_load');
    expect(load, 'the useful fact is the current').toBeDefined();
    expect(load!.severity).toBe('info');
    expect(load!.message, '3.3 V / 220 Ω = 15 mA').toContain('15 mA');
    expect(load!.objects).toContain('r1');
  });

  it('warns when the value makes it a load a breadboard should not carry', () => {
    const a = analyzeDesign(railToRailThrough('10'));
    const hot = a.results.find((r) => r.code === 'passive_load_excessive');
    expect(hot?.severity).toBe('warning');
    expect(hot!.message).toContain('330 mA');
    expect(a.results.some((r) => r.code === 'power_ground_short'), 'still not a short — it is a bad choice of part').toBe(false);
  });

  it('says "unknown" instead of guessing when the marking is unreadable', () => {
    const a = analyzeDesign(railToRailThrough('brown-black-red'));
    const unknown = a.results.find((r) => r.code === 'passive_load_unknown');
    expect(unknown?.severity).toBe('needs_review');
    expect(a.results.some((r) => r.code === 'passive_load')).toBe(false);
  });

  it('treats a 0 Ω marking as what it is', () => {
    const a = analyzeDesign(railToRailThrough('0'));
    expect(a.results.some((r) => r.code === 'power_ground_short')).toBe(true);
  });

  it('still calls a bare wire between power and ground a short', () => {
    // The regression that matters: teaching the rules about resistors must not
    // teach them to forgive the real thing.
    const base = build([...oneBoard, MCU]);
    const shorted = build(
      [{ op: 'add_wire', wire: { id: 'w1', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'mcu', 'GND') }, color: 'red' } }],
      base,
      true
    );
    const a = analyzeDesign(shorted);
    const short = a.results.find((r) => r.code === 'power_ground_short');
    expect(short?.severity).toBe('error');
    expect(short!.endpoints).toContain('mcu.3V3');
  });

  it('still flags a resistor whose legs are pushed into one column', () => {
    // Conduction must not be mistaken for `internal_nets`: these two legs really
    // are shorted by the board, and the resistor is doing nothing.
    const base = build([...oneBoard, MCU]);
    const collapsed = build(
      [
        {
          op: 'add_component',
          // Turned upright, both legs land in the same five-hole column (e20 and c20).
          component: { id: 'r1', model: 'resistor_axial@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e20', anchor_pin: 'P1', rotation_deg: 270 }, params: { value: '220', span_pitches: 2 } }
        }
      ],
      base,
      true
    );
    const a = analyzeDesign(collapsed);
    expect(a.results.some((r) => r.code === 'pins_shorted_by_board' && r.objects.includes('r1'))).toBe(true);
  });
});
