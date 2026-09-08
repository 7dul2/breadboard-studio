import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, migrateDesign, validateDesignSchema, validateComponentDefinition, designSchema } from '../src/index.js';

const base = {
  schema_version: '1.0',
  catalog_versions: { builtin: '0.1.0' },
  metadata: { name: '旧项目', revision: 3, notes: '保留' },
  boards: [{ id: 'bb', model: 'breadboard_400@1', position_um: [0, 0], rotation_deg: 0 }],
  components: [{ id: 'mcu', model: 'esp32s3_n16r8_dual_usb@1', placement: { kind: 'off_board', position_um: [1000, 2000], rotation_deg: 90 }, config: { rgb_led_color: [1, 2, 3] } }],
  wires: [{ id: 'w1', from: { hole: 'bb.a1' }, to: { hole: 'bb.a2' }, color: 'red', route: 'flat', path_mode: 'auto', waypoints_um: [] }],
  net_intents: [{ id: 'n1', name: 'GND', endpoints: ['mcu.GND_1', 'bb.a1'] }],
  constraints: [{ id: 'c1', type: 'note', text: 'x' }],
  view: { zoom: 2, build_done: ['w1'] }
};

describe('schema 1.1 migration', () => {
  it('upgrades 1.0 → 1.1 without touching any content and without mutating the input', () => {
    const input = JSON.parse(JSON.stringify(base));
    const r = migrateDesign(input);
    expect(r.ok).toBe(true);
    expect(r.from).toBe('1.0');
    expect(r.to).toBe(SCHEMA_VERSION);
    expect(r.migrated).toBe(true);
    const doc = r.doc as typeof base;
    expect(doc.schema_version).toBe('1.1');
    const { schema_version: _a, ...restIn } = base;
    const { schema_version: _b, ...restOut } = doc;
    expect(restOut).toEqual(restIn);
    expect(input.schema_version).toBe('1.0');
    expect('programs' in doc).toBe(false);
    expect('simulation' in doc).toBe(false);
    expect(validateDesignSchema(doc).ok).toBe(true);
  });

  it('accepts 1.1 as-is and rejects unknown versions explicitly', () => {
    const current = migrateDesign({ ...base, schema_version: '1.1' });
    expect(current.ok).toBe(true);
    expect(current.migrated).toBe(false);
    for (const v of ['0.9', '1.2', '9.0']) {
      const r = migrateDesign({ ...base, schema_version: v });
      expect(r.ok, v).toBe(false);
      expect(r.error, v).toContain(v);
    }
    expect(migrateDesign({ ...base, schema_version: undefined }).ok).toBe(false);
    expect(migrateDesign([]).ok).toBe(false);
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1.0');
    expect((designSchema as { $id: string }).$id).toContain('1.1');
  });

  it('validates programs and simulation sections structurally', () => {
    const program = { id: 'program_main', name: '主程序', target_component_id: 'mcu', language: 'studio-ts', source: 'export async function setup() {}\n', entry: 'main.ts' };
    const good = { ...base, schema_version: '1.1', programs: [program], simulation: { active_program_id: 'program_main', speed: 2, random_seed: 7, usb_powered_components: ['mcu'] } };
    expect(validateDesignSchema(good).issues).toEqual([]);
    const badLanguage = validateDesignSchema({ ...good, programs: [{ ...program, language: 'python' }] });
    expect(badLanguage.ok).toBe(false);
    expect(badLanguage.issues.some((i) => i.path.includes('/programs/0/language'))).toBe(true);
    expect(validateDesignSchema({ ...good, programs: [{ ...program, extra: 1 }] }).ok).toBe(false);
    expect(validateDesignSchema({ ...good, programs: [{ id: 'p', name: 'x', target_component_id: 'mcu', language: 'studio-ts' }] }).ok).toBe(false);
    expect(validateDesignSchema({ ...good, simulation: { speed: 3 } }).ok).toBe(false);
    expect(validateDesignSchema({ ...good, simulation: { random_seed: -1 } }).ok).toBe(false);
    expect(validateDesignSchema({ ...good, simulation: { runtime_state: {} } }).ok).toBe(false);
  });

  it('validates the optional simulation binding of component definitions', () => {
    const def = {
      kind: 'component',
      id: 'sim_part',
      version: 1,
      name: 'x',
      category: 'input',
      mount: 'breadboard',
      origin: 'top_left',
      body: { size_um: [5000, 5000], height_um: 1000, standoff_um: 0 },
      pins: [{ name: 'OUT', local_um: [0, 0], kind: 'header' }],
      pin_meta: { OUT: { role: 'signal_out' } },
      electrical: {},
      features: [{ type: 'button', label: '触摸区', rect_um: { x: 0, y: 0, w: 100, h: 100 } }],
      simulation: { driver: 'input.ttp223@1', pins: { OUT: 'out' }, controls: [{ id: 'touch', feature_label: '触摸区', action: 'touch', channel: 'touch' }], visuals: [{ id: 'led', feature_label: '触摸区', kind: 'led', channel: 'led' }] },
      render: [],
      geometry_status: 'unknown',
      electrical_status: 'unknown',
      sources: [{ title: 't' }],
      license: { spdx: 'MIT' }
    };
    expect(validateComponentDefinition(def).issues).toEqual([]);
    expect(validateComponentDefinition({ ...def, simulation: { driver: 'no-version' } }).ok).toBe(false);
    expect(validateComponentDefinition({ ...def, simulation: { driver: 'x@1', controls: [{ id: 'a', feature_label: 'b', action: 'wave', channel: 'c' }] } }).ok).toBe(false);
    expect(validateComponentDefinition({ ...def, simulation: { driver: 'x@1', behaviour: 'inline' } }).ok).toBe(false);
  });

  it('rejects simulation bindings that point at features or pins the definition does not have', () => {
    const base = {
      kind: 'component',
      id: 'sim_part',
      version: 1,
      name: 'x',
      category: 'input',
      mount: 'breadboard',
      origin: 'top_left',
      body: { size_um: [5000, 5000], height_um: 1000, standoff_um: 0 },
      pins: [{ name: 'OUT', local_um: [0, 0], kind: 'header' }],
      pin_meta: { OUT: { role: 'signal_out' } },
      electrical: {},
      features: [{ type: 'button', label: '触摸区', rect_um: { x: 0, y: 0, w: 100, h: 100 } }],
      render: [],
      geometry_status: 'unknown',
      electrical_status: 'unknown',
      sources: [{ title: 't' }],
      license: { spdx: 'MIT' }
    };
    const withSim = (simulation: Record<string, unknown>) => validateComponentDefinition({ ...base, simulation });

    const missingFeature = withSim({ driver: 'input.ttp223@1', controls: [{ id: 'touch', feature_label: '不存在', action: 'touch', channel: 'touch' }] });
    expect(missingFeature.ok).toBe(false);
    expect(missingFeature.issues[0]!.path).toBe('/simulation/controls/0/feature_label');
    expect(missingFeature.issues[0]!.message).toContain('触摸区');

    const missingVisual = withSim({ driver: 'output.led@1', visuals: [{ id: 'glow', feature_label: 'LED', kind: 'led', channel: 'glow' }] });
    expect(missingVisual.ok).toBe(false);
    expect(missingVisual.issues[0]!.path).toBe('/simulation/visuals/0/feature_label');

    const badPin = withSim({ driver: 'input.ttp223@1', pins: { NOPE: 'out' } });
    expect(badPin.ok).toBe(false);
    expect(badPin.issues[0]!.path).toBe('/simulation/pins/NOPE');

    const duplicateId = withSim({
      driver: 'input.ttp223@1',
      controls: [{ id: 'same', feature_label: '触摸区', action: 'touch', channel: 'a' }],
      visuals: [{ id: 'same', feature_label: '触摸区', kind: 'state', channel: 'b' }]
    });
    expect(duplicateId.ok).toBe(false);
    expect(duplicateId.issues[0]!.message).toContain('重复的绑定 id');

    expect(withSim({ driver: 'input.ttp223@1', pins: { OUT: 'out' }, controls: [{ id: 'touch', feature_label: '触摸区', action: 'touch', channel: 'touch' }] }).issues).toEqual([]);
    // Parametric definitions have no explicit pins; pin_meta carries the names.
    expect(validateComponentDefinition({ ...base, pins: [], generator: { type: 'single_row_header', edge: 'bottom', inset_um: 1270 }, simulation: { driver: 'input.ttp223@1', pins: { OUT: 'out' } } }).issues).toEqual([]);
  });
});
