import { describe, it, expect } from 'vitest';
import { validateComponentDefinition, type DesignDocument } from '@breadboard-studio/schema';
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

/**
 * A mechanical contact is not a resistor. The resistor rule was "current gets
 * across, but the two legs are not one node"; a closed switch is the opposite on
 * the second half — it *is* a wire — so it joins `direct` as well as `full`. That
 * is what makes a closed switch across a supply a short rather than a load, and
 * it is why the state has to come from the instance rather than the definition.
 */
function switchOp(closed: boolean): Op {
  return {
    op: 'add_component',
    component: {
      id: 'sw1',
      model: 'tactile_6x6@1',
      placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e10', anchor_pin: 'A', rotation_deg: 0 },
      params: { closed }
    }
  };
}

describe('a switch conducts only while it is closed', () => {
  const A = () => pinKey('sw1', 'A');
  const B = () => pinKey('sw1', 'B');

  it('is open by default and joins nothing', () => {
    const unset = build(
      [...oneBoard, { op: 'add_component', component: { id: 'sw1', model: 'tactile_6x6@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e10', anchor_pin: 'A', rotation_deg: 0 } } }],
      undefined,
      true
    );
    const conn = analyzeDesign(unset).connectivity;
    expect(conn.full.connected(A(), B()), 'an open contact carries no current').toBe(false);
    expect(conn.direct.connected(A(), B()), 'and is not one node').toBe(false);
    expect(conn.conducted).toEqual([]);
  });

  it('joins both graphs once closed, because a contact is a wire', () => {
    const conn = analyzeDesign(build([...oneBoard, switchOp(true)], undefined, true)).connectivity;
    expect(conn.full.connected(A(), B())).toBe(true);
    expect(conn.direct.connected(A(), B()), 'unlike a resistor, it makes one node').toBe(true);
    expect(conn.conducted).toEqual([{ componentId: 'sw1', kind: 'switch', pins: ['A', 'B'], ohms: 0, marking: null }]);
  });

  /** 3V3 → switch → GND, which is what a closed switch across a supply is. */
  function switchAcrossSupply(closed: boolean): DesignDocument {
    const base = build([...oneBoard, MCU, switchOp(closed)], undefined, true);
    return build(
      [
        { op: 'add_wire', wire: { id: 'w_pos', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'sw1', 'A') }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w_gnd', from: { hole: tapPoint(base, 'mcu', 'GND') }, to: { hole: tapPoint(base, 'sw1', 'B') }, color: 'black' } }
      ],
      base,
      true
    );
  }

  it('is neither a load nor a short while it is open', () => {
    const a = analyzeDesign(switchAcrossSupply(false));
    expect(a.results.some((r) => r.code === 'power_ground_short')).toBe(false);
    expect(a.results.some((r) => r.code.startsWith('passive_load'))).toBe(false);
  });

  it('is a short once closed, and the advice names the closed link', () => {
    const a = analyzeDesign(switchAcrossSupply(true));
    const short = a.results.find((r) => r.code === 'power_ground_short');
    expect(short?.severity).toBe('error');
    expect(short!.suggestion, 'point at the switch, not only at the wires').toContain('sw1');
  });

  it('in series with a resistor it is still a load, and still 3V3 / 220 Ω', () => {
    const base = build(
      [
        ...oneBoard,
        MCU,
        switchOp(true),
        { op: 'add_component', component: { id: 'r1', model: 'resistor_axial@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e20', anchor_pin: 'P1', rotation_deg: 0 }, params: { value: '220' } } }
      ],
      undefined,
      true
    );
    const design = build(
      [
        { op: 'add_wire', wire: { id: 'w1', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'sw1', 'A') } } },
        { op: 'add_wire', wire: { id: 'w2', from: { hole: tapPoint(base, 'sw1', 'B') }, to: { hole: tapPoint(base, 'r1', 'P1') } } },
        { op: 'add_wire', wire: { id: 'w3', from: { hole: tapPoint(base, 'r1', 'P2') }, to: { hole: tapPoint(base, 'mcu', 'GND') } } }
      ],
      base,
      true
    );
    const a = analyzeDesign(design);
    expect(a.results.some((r) => r.code === 'power_ground_short'), 'the contact is closed but the resistor is in the way').toBe(false);
    const load = a.results.find((r) => r.code === 'passive_load');
    expect(load, 'a closed switch adds 0 Ω, not an unknown').toBeDefined();
    expect(load!.message).toContain('15 mA');
  });
});

/** A minimal two-pin part definition whose conduction kind is the only thing that varies. */
function linkDef(id: string, kind: string): Record<string, unknown> {
  return {
    kind: 'component',
    id,
    version: 1,
    name: id,
    category: 'passive',
    mount: 'breadboard',
    origin: 'top_left',
    generator: { type: 'axial_two_pin' },
    params_schema: { type: 'object', additionalProperties: false, properties: { span_pitches: { type: 'integer', minimum: 2, maximum: 12 } } },
    params_default: { span_pitches: 2 },
    body: { size_um: [7620, 2540], height_um: 1000, standoff_um: 0 },
    pins: [],
    pin_meta: { P1: { role: 'passive', direction: 'passive' }, P2: { role: 'passive', direction: 'passive' } },
    conduction: [{ kind, pins: ['P1', 'P2'] }],
    electrical: { supply_voltage_v: null, supply_current_ma: null, io_voltage_v: null, i2c: null },
    render: [],
    geometry_status: 'approximate',
    electrical_status: 'approximate',
    sources: [{ title: 'test fixture' }],
    license: { spdx: 'MIT', attribution: 'test fixture' }
  };
}

/**
 * `short` and `open` are statements the rules can trust: a link is a wire, and a
 * capacitor joins nothing at DC. Neither is a resistor, so neither may be summed
 * as an impedance — and `open` is a declaration, not an omission.
 */
describe('conduction kinds beyond resistors', () => {
  function place(kind: 'short' | 'open'): DesignDocument {
    return build(
      [
        ...oneBoard,
        { op: 'add_definition', definition: linkDef(`link_${kind}`, kind) },
        { op: 'add_component', component: { id: 'l1', model: `link_${kind}@1`, placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e10', anchor_pin: 'P1', rotation_deg: 0 } } }
      ],
      undefined,
      true
    );
  }

  it('a link is a wire: it joins both graphs', () => {
    const conn = analyzeDesign(place('short')).connectivity;
    expect(conn.full.connected(pinKey('l1', 'P1'), pinKey('l1', 'P2'))).toBe(true);
    expect(conn.direct.connected(pinKey('l1', 'P1'), pinKey('l1', 'P2'))).toBe(true);
    expect(conn.conducted).toEqual([{ componentId: 'l1', kind: 'short', pins: ['P1', 'P2'], ohms: 0, marking: null }]);
  });

  it('an open part joins nothing at all and is not a conducted path', () => {
    const conn = analyzeDesign(place('open')).connectivity;
    expect(conn.full.connected(pinKey('l1', 'P1'), pinKey('l1', 'P2'))).toBe(false);
    expect(conn.direct.connected(pinKey('l1', 'P1'), pinKey('l1', 'P2'))).toBe(false);
    expect(conn.conducted).toEqual([]);
  });

  it('accepts all five conduction kinds', () => {
    for (const kind of ['resistor', 'switch', 'diode', 'short', 'open']) {
      expect(validateComponentDefinition(linkDef('k', kind)).ok, kind).toBe(true);
    }
  });
});

/**
 * A diode is one-way: `pins[0]` is the anode, `pins[1]` the cathode, and the
 * reverse direction must not conduct. The direction lives in a directed edge
 * that only `full` follows, so `direct` (node identity) stays untouched — and
 * a reverse-biased diode must not look like a wire.
 */
describe('diode: one-way conduction', () => {
  /** A placed diode d1 at e10: P1 is the anode, P2 the cathode. */
  function diodeBoard(): DesignDocument {
    return build(
      [
        ...oneBoard,
        MCU,
        { op: 'add_definition', definition: linkDef('diode_1n4148', 'diode') },
        { op: 'add_component', component: { id: 'd1', model: 'diode_1n4148@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e10', anchor_pin: 'P1', rotation_deg: 0 } } }
      ],
      undefined,
      true
    );
  }

  it('a diode conducts one way and must not conduct the other', () => {
    const base = diodeBoard();
    const design = build(
      [{ op: 'add_wire', wire: { id: 'w1', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'd1', 'P1') }, color: 'red' } }],
      base,
      true
    );
    const conn = analyzeDesign(design).connectivity;
    expect(conn.full.connected(pinKey('mcu', '3V3'), pinKey('d1', 'P2')), 'forward must conduct').toBe(true);
    // Without the direction check this would look like a wire.
    expect(conn.full.connected(pinKey('d1', 'P2'), pinKey('mcu', '3V3')), 'reverse must not conduct').toBe(false);
    // The diode's legs are different nodes, like a resistor's.
    expect(conn.direct.connected(pinKey('mcu', '3V3'), pinKey('d1', 'P2'))).toBe(false);
    expect(conn.conducted).toEqual([{ componentId: 'd1', kind: 'diode', pins: ['P1', 'P2'], ohms: 0, marking: null }]);
  });

  it('current crosses a diode and a resistor in series one way, and stops the other way', () => {
    const base = build(
      [
        ...oneBoard,
        MCU,
        { op: 'add_definition', definition: linkDef('diode_1n4148', 'diode') },
        { op: 'add_component', component: { id: 'd1', model: 'diode_1n4148@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e10', anchor_pin: 'P1', rotation_deg: 0 } } },
        { op: 'add_component', component: { id: 'r1', model: 'resistor_axial@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'e20', anchor_pin: 'P1', rotation_deg: 0 }, params: { value: '220' } } }
      ],
      undefined,
      true
    );
    // Forward: 3V3 → d1.P1 (anode) → d1.P2 → r1.P1 → r1.P2 → GND.
    const forward = build(
      [
        { op: 'add_wire', wire: { id: 'w1', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'd1', 'P1') }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w2', from: { hole: tapPoint(base, 'd1', 'P2') }, to: { hole: tapPoint(base, 'r1', 'P1') }, color: 'orange' } },
        { op: 'add_wire', wire: { id: 'w3', from: { hole: tapPoint(base, 'r1', 'P2') }, to: { hole: tapPoint(base, 'mcu', 'GND') }, color: 'black' } }
      ],
      base,
      true
    );
    // Reverse wiring: 3V3 → r1.P2 → r1.P1 → d1.P2 (cathode) — the diode blocks here.
    const reverse = build(
      [
        { op: 'add_wire', wire: { id: 'w1', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'r1', 'P2') }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w2', from: { hole: tapPoint(base, 'r1', 'P1') }, to: { hole: tapPoint(base, 'd1', 'P2') }, color: 'orange' } },
        { op: 'add_wire', wire: { id: 'w3', from: { hole: tapPoint(base, 'd1', 'P1') }, to: { hole: tapPoint(base, 'mcu', 'GND') }, color: 'black' } }
      ],
      base,
      true
    );
    const fwd = analyzeDesign(forward).connectivity;
    expect(fwd.full.connected(pinKey('mcu', '3V3'), pinKey('mcu', 'GND')), 'forward reaches ground').toBe(true);
    expect(fwd.full.connected(pinKey('mcu', 'GND'), pinKey('mcu', '3V3')), 'current does not run backwards').toBe(false);
    const rev = analyzeDesign(reverse).connectivity;
    expect(rev.full.connected(pinKey('mcu', '3V3'), pinKey('mcu', 'GND')), 'the diode blocks this way').toBe(false);
    // In this wiring the anode faces ground, so ground is the direction that conducts.
    expect(rev.full.connected(pinKey('mcu', 'GND'), pinKey('mcu', '3V3'))).toBe(true);
  });

  it('a wire bridging the diode moots the one-way edge', () => {
    const base = diodeBoard();
    const design = build(
      [{ op: 'add_wire', wire: { id: 'w1', from: { hole: tapPoint(base, 'd1', 'P1') }, to: { hole: tapPoint(base, 'd1', 'P2') } } }],
      base,
      true
    );
    const conn = analyzeDesign(design).connectivity;
    expect(conn.full.connected(pinKey('d1', 'P1'), pinKey('d1', 'P2'))).toBe(true);
    expect(conn.full.connected(pinKey('d1', 'P2'), pinKey('d1', 'P1'))).toBe(true);
  });

  it('a reverse diode across the supply conducts nothing and is no short', () => {
    const base = diodeBoard();
    // d1.P1 (anode) to GND, d1.P2 (cathode) to 3V3: the diode faces the wrong way.
    const design = build(
      [
        { op: 'add_wire', wire: { id: 'w_pos', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'd1', 'P2') }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w_gnd', from: { hole: tapPoint(base, 'mcu', 'GND') }, to: { hole: tapPoint(base, 'd1', 'P1') }, color: 'black' } }
      ],
      base,
      true
    );
    const a = analyzeDesign(design);
    expect(a.connectivity.full.connected(pinKey('mcu', '3V3'), pinKey('mcu', 'GND')), 'reverse must not conduct').toBe(false);
    expect(a.results.some((r) => r.code === 'power_ground_short'), 'a reverse diode is not a short').toBe(false);
    expect(a.results.some((r) => r.code === 'passive_load' || r.code === 'passive_load_unknown'), 'nothing conducts, so there is no load').toBe(false);
  });

  it('a forward diode across the supply is a short, and the advice names the diode', () => {
    const base = diodeBoard();
    // d1.P1 (anode) to 3V3, d1.P2 (cathode) to GND: the diode faces the supply.
    const design = build(
      [
        { op: 'add_wire', wire: { id: 'w_pos', from: { hole: tapPoint(base, 'mcu', '3V3') }, to: { hole: tapPoint(base, 'd1', 'P1') }, color: 'red' } },
        { op: 'add_wire', wire: { id: 'w_gnd', from: { hole: tapPoint(base, 'mcu', 'GND') }, to: { hole: tapPoint(base, 'd1', 'P2') }, color: 'black' } }
      ],
      base,
      true
    );
    const a = analyzeDesign(design);
    expect(a.connectivity.full.connected(pinKey('mcu', '3V3'), pinKey('mcu', 'GND')), 'forward conducts').toBe(true);
    const short = a.results.find((r) => r.code === 'power_ground_short');
    expect(short, 'a forward diode across the supply is a short').toBeDefined();
    expect(short!.message).toContain('d1');
    expect(short!.suggestion).toContain('限流电阻');
  });
});
