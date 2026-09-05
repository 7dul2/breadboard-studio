/**
 * Regenerates the shipped examples through the same transaction engine the
 * editor and CLI use, so every example is guaranteed to load and validate.
 *   pnpm tsx scripts/build-examples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeDesign, applyOps, buildModel, createEmptyDesign, serializeDesign, type Op } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import type { DesignDocument } from '@breadboard-studio/schema';

const root = join(import.meta.dirname, '..');
const outDir = join(root, 'examples');
const invalidDir = join(outDir, 'invalid');
mkdirSync(invalidDir, { recursive: true });

const FIXED_NOW = '2026-09-05T00:00:00.000Z';

function run(design: DesignDocument, ops: Op[], label: string, allowBlocking = false): DesignDocument {
  const r = applyOps(design, ops, { allow_blocking: allowBlocking, now: () => FIXED_NOW });
  if (!r.ok) {
    console.error(`[${label}] apply failed:`, JSON.stringify(r.error, null, 2));
    process.exit(1);
  }
  return r.design;
}

function holeGlobal(design: DesignDocument, addr: string): [number, number] {
  const model = buildModel(design, builtinCatalog());
  const [board, hole] = addr.split('.') as [string, string];
  const pb = model.boards.get(board)!;
  const h = pb.resolved.holes.get(hole)!;
  const t = pb.transform;
  return [t.position[0] + h.local_um[0], t.position[1] + h.local_um[1]];
}

function write(name: string, design: DesignDocument, dir = outDir): void {
  const a = analyzeDesign(design);
  const path = join(dir, name);
  writeFileSync(path, serializeDesign(design));
  const s = a.summary;
  console.log(`${name.padEnd(44)} error=${s.error} warning=${s.warning} needs_review=${s.needs_review} info=${s.info} blocking=${s.blocking}`);
}

// ---------------------------------------------------------------------------
// Example 1: desk device — ESP32-S3 DevKit + 0.96" OLED + TTP223 on one 830-hole board
// ---------------------------------------------------------------------------
let desk = createEmptyDesign('桌面设备：ESP32-S3 + OLED + 触摸键');
desk.metadata.created_at = FIXED_NOW;
desk.metadata.updated_at = FIXED_NOW;
desk.metadata.description =
  '当前桌面设备的面包板规划：通用 ESP32-S3 DevKit 模板（尺寸未实测，approximate）、0.96" I²C OLED、TTP223 触摸模块。全尺寸 830 孔板的电源轨在 25/26 之间断开，示例用两根跨段跳线把轨道接通。';
desk.metadata.author = 'Breadboard Studio examples';
desk.metadata.tags = ['esp32-s3', 'oled', 'ttp223', 'example'];
desk = run(
  desk,
  [
    { op: 'add_board', board: { id: 'bb', model: 'breadboard_830@1', name: '主板 830', position_um: [0, 0], rotation_deg: 0 } },
    {
      op: 'add_component',
      component: {
        id: 'mcu',
        name: 'ESP32-S3 DevKit',
        model: 'esp32s3_devkit_generic@1',
        placement: { kind: 'board', board_id: 'bb', anchor_hole: 'c3', anchor_pin: 'GND_1', rotation_deg: 90 },
        config: { i2c_sda_pin: 'GPIO8', i2c_scl_pin: 'GPIO9', supply_3v3_max_ma: null },
        notes: '排距/外形按 DevKitC-1 近似，请用卡尺核实后修改 params。c 排引脚可从 a/b 排引出；j 排引脚被板体遮挡，本例不使用。'
      }
    },
    {
      op: 'add_component',
      component: {
        id: 'oled',
        name: '0.96" OLED',
        model: 'oled_0_96_i2c@1',
        placement: { kind: 'board', board_id: 'bb', anchor_hole: 'j40', anchor_pin: 'GND', rotation_deg: 0 },
        params: { pin_names: ['GND', 'VCC', 'SCL', 'SDA'], body_size_um: [27000, 27000], mount_orientation: 'upright' },
        config: { i2c_address: 60 }
      }
    },
    {
      op: 'add_component',
      component: {
        id: 'touch',
        name: 'TTP223 触摸键',
        model: 'ttp223_module@1',
        placement: { kind: 'board', board_id: 'bb', anchor_hole: 'a50', anchor_pin: 'VCC', rotation_deg: 0 },
        config: { output_mode: 'active_high', toggle_mode: false, supply_v: 3.3 }
      }
    }
  ],
  'desk components'
);
const yA = holeGlobal(desk, 'bb.a13')[1];
const yB = holeGlobal(desk, 'bb.b10')[1];
const x43 = holeGlobal(desk, 'bb.h43')[0];
const x42 = holeGlobal(desk, 'bb.h42')[0];
desk = run(
  desk,
  [
    { op: 'add_wire', wire: { id: 'w1', name: '3V3 → 电源轨', from: { hole: 'bb.b24' }, to: { hole: 'bb.top_inner_19' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w2', name: 'GND → 电源轨', from: { hole: 'bb.b3' }, to: { hole: 'bb.top_outer_2' }, color: 'black' } },
    { op: 'add_wire', wire: { id: 'w3', name: '+ 轨跨段跳线', from: { hole: 'bb.top_inner_25' }, to: { hole: 'bb.top_inner_26' }, color: 'red', notes: '830 板电源轨在 25/26 之间断开' } },
    { op: 'add_wire', wire: { id: 'w4', name: '− 轨跨段跳线', from: { hole: 'bb.top_outer_25' }, to: { hole: 'bb.top_outer_26' }, color: 'black' } },
    { op: 'add_wire', wire: { id: 'w5', name: 'OLED VCC', from: { hole: 'bb.i41' }, to: { hole: 'bb.top_inner_33' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w6', name: 'OLED GND', from: { hole: 'bb.i40' }, to: { hole: 'bb.top_outer_33' }, color: 'black' } },
    { op: 'add_wire', wire: { id: 'w7', name: 'SDA GPIO8 → OLED', from: { hole: 'bb.a13' }, to: { hole: 'bb.h43' }, color: 'blue', route: 'flat', path_mode: 'manual', waypoints_um: [[x43, yA]] } },
    { op: 'add_wire', wire: { id: 'w8', name: 'SCL GPIO9 → OLED', from: { hole: 'bb.b10' }, to: { hole: 'bb.h42' }, color: 'yellow', route: 'flat', path_mode: 'manual', waypoints_um: [[x42, yB]] } },
    { op: 'add_wire', wire: { id: 'w9', name: '触摸 VCC', from: { hole: 'bb.b50' }, to: { hole: 'bb.top_inner_41' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w10', name: '触摸 GND', from: { hole: 'bb.b52' }, to: { hole: 'bb.top_outer_42' }, color: 'black' } },
    { op: 'add_wire', wire: { id: 'w11', name: '触摸 IO → GPIO4', from: { hole: 'bb.b51' }, to: { hole: 'bb.b21' }, color: 'green' } },
    { op: 'add_net_intent', net_intent: { id: 'n_sda', name: 'SDA', endpoints: ['mcu.GPIO8', 'oled.SDA'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_scl', name: 'SCL', endpoints: ['mcu.GPIO9', 'oled.SCL'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_touch', name: 'TOUCH', endpoints: ['mcu.GPIO4', 'touch.IO'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_3v3', name: '3V3', endpoints: ['mcu.3V3_1', 'oled.VCC', 'touch.VCC'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_gnd', name: 'GND', endpoints: ['mcu.GND_1', 'oled.GND', 'touch.GND'] } },
    { op: 'add_constraint', constraint: { id: 'c_note', type: 'note', text: 'DevKit 外形未实测：先量排距再依赖遮挡/可达孔结果。' } }
  ],
  'desk wires'
);
write('desk_device.breadboard.json', desk);

// ---------------------------------------------------------------------------
// Example 2: environment node — two 400-hole boards, XIAO ESP32-S3 Sense, SHT41/BMP390/LTR390, SEN66 off-board, power module
// ---------------------------------------------------------------------------
let env = createEmptyDesign('双面包板环境节点：XIAO ESP32-S3 Sense + 传感器 + SEN66');
env.metadata.created_at = FIXED_NOW;
env.metadata.updated_at = FIXED_NOW;
env.metadata.description =
  '两块 400 孔板沿短边拼接（栅格对齐，几何拼接不导通）。板 A：XIAO ESP32-S3 Sense + SHT41/BMP390/LTR390 立式 I²C 模块，由 XIAO 3V3 供电；板 B：SEN66 线缆落点与独立 3.3 V 电源。两块板只共地，不并联 3.3 V。';
env.metadata.author = 'Breadboard Studio examples';
env.metadata.tags = ['xiao', 'esp32-s3', 'sen66', 'i2c', 'example'];
env = run(
  env,
  [
    { op: 'add_board', board: { id: 'bb_a', model: 'breadboard_400@1', name: '板 A（主控）', position_um: [0, 0], rotation_deg: 0 } },
    { op: 'add_board', board: { id: 'bb_b', model: 'breadboard_400@1', name: '板 B（电源/SEN66）', attach_to: { board_id: 'bb_a', side: 'right', grid_align: true } } },
    {
      op: 'add_component',
      component: {
        id: 'mcu',
        name: 'XIAO ESP32-S3 Sense',
        model: 'xiao_esp32s3_sense@1',
        placement: { kind: 'board', board_id: 'bb_a', anchor_hole: 'b3', anchor_pin: 'D6', rotation_deg: 90 },
        notes: '旋转 90° 后 D 排在 b 行（a 行可引出），电源排在 f 行（g–j 可引出）。USB-C 朝右。'
      }
    },
    {
      op: 'add_component',
      component: { id: 'sht41', name: 'SHT41', model: 'sht41_breakout@1', placement: { kind: 'board', board_id: 'bb_a', anchor_hole: 'j12', anchor_pin: 'VCC', rotation_deg: 0 }, config: { i2c_address: 68, supply_voltage_v: null } }
    },
    {
      op: 'add_component',
      component: { id: 'bmp390', name: 'BMP390', model: 'bmp390_breakout@1', placement: { kind: 'board', board_id: 'bb_a', anchor_hole: 'j18', anchor_pin: 'VCC', rotation_deg: 0 }, config: { i2c_address: 119, supply_voltage_v: null } }
    },
    {
      op: 'add_component',
      component: { id: 'ltr390', name: 'LTR390', model: 'ltr390_breakout@1', placement: { kind: 'board', board_id: 'bb_a', anchor_hole: 'j24', anchor_pin: 'VCC', rotation_deg: 0 }, config: { i2c_address: 83, supply_voltage_v: null } }
    },
    {
      op: 'add_component',
      component: { id: 'sen66', name: 'SEN66', model: 'sen66@1', placement: { kind: 'off_board', position_um: [95000, 75000], rotation_deg: 0 }, notes: 'JST-GH 线缆落到板 B；SEL 接地选择 I²C。' }
    },
    {
      op: 'add_component',
      component: { id: 'psu', name: '3.3 V 电源', model: 'power_module_3v3@1', placement: { kind: 'off_board', position_um: [180000, 8000], rotation_deg: 0 }, config: { capacity_ma: null, peak_ma: null, input: 'USB 5V（待定）' }, notes: '输出能力未填写，规则会保留待审核项。' }
    }
  ],
  'env components'
);
env = run(
  env,
  [
    // board A power from XIAO 3V3
    { op: 'add_wire', wire: { id: 'w1', name: 'XIAO 3V3 → A 板 + 轨', from: { hole: 'bb_a.g7' }, to: { hole: 'bb_a.bottom_inner_5' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w2', name: 'XIAO GND → A 板 − 轨', from: { hole: 'bb_a.g8' }, to: { hole: 'bb_a.bottom_outer_6' }, color: 'black' } },
    { op: 'add_wire', wire: { id: 'w3', name: 'SHT41 VCC', from: { hole: 'bb_a.i12' }, to: { hole: 'bb_a.bottom_inner_9' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w4', name: 'SHT41 GND', from: { hole: 'bb_a.i13' }, to: { hole: 'bb_a.bottom_outer_10' }, color: 'black' } },
    { op: 'add_wire', wire: { id: 'w5', name: 'BMP390 VCC', from: { hole: 'bb_a.i18' }, to: { hole: 'bb_a.bottom_inner_13' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w6', name: 'BMP390 GND', from: { hole: 'bb_a.i19' }, to: { hole: 'bb_a.bottom_outer_14' }, color: 'black' } },
    { op: 'add_wire', wire: { id: 'w7', name: 'LTR390 VCC', from: { hole: 'bb_a.i24' }, to: { hole: 'bb_a.bottom_inner_18' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w8', name: 'LTR390 GND', from: { hole: 'bb_a.i25' }, to: { hole: 'bb_a.bottom_outer_19' }, color: 'black' } },
    // I2C bus (soft wires over the XIAO body)
    { op: 'add_wire', wire: { id: 'w9', name: 'SDA D4 → SHT41', from: { hole: 'bb_a.a5' }, to: { hole: 'bb_a.h15' }, color: 'blue', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w10', name: 'SCL D5 → SHT41', from: { hole: 'bb_a.a4' }, to: { hole: 'bb_a.h14' }, color: 'yellow', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w11', name: 'SDA → BMP390', from: { hole: 'bb_a.g15' }, to: { hole: 'bb_a.h21' }, color: 'blue' } },
    { op: 'add_wire', wire: { id: 'w12', name: 'SCL → BMP390', from: { hole: 'bb_a.g14' }, to: { hole: 'bb_a.h20' }, color: 'yellow' } },
    { op: 'add_wire', wire: { id: 'w13', name: 'SDA → LTR390', from: { hole: 'bb_a.g21' }, to: { hole: 'bb_a.h27' }, color: 'blue' } },
    { op: 'add_wire', wire: { id: 'w14', name: 'SCL → LTR390', from: { hole: 'bb_a.g20' }, to: { hole: 'bb_a.h26' }, color: 'yellow' } },
    // cross-board: I2C to board B, common ground
    { op: 'add_wire', wire: { id: 'w15', name: 'SDA 跨板 A→B', from: { hole: 'bb_a.f27' }, to: { hole: 'bb_b.a3' }, color: 'blue', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w16', name: 'SCL 跨板 A→B', from: { hole: 'bb_a.f26' }, to: { hole: 'bb_b.a5' }, color: 'yellow', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w17', name: '共地跨板', from: { hole: 'bb_a.bottom_outer_25' }, to: { hole: 'bb_b.bottom_outer_1' }, color: 'black' } },
    // board B: power module and SEN66 cable landing
    { op: 'add_wire', wire: { id: 'w18', name: '电源 3V3 → B 板 + 轨', from: { terminal: 'psu.3V3' }, to: { hole: 'bb_b.bottom_inner_2' }, color: 'red', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w19', name: '电源 GND → B 板 − 轨', from: { terminal: 'psu.GND' }, to: { hole: 'bb_b.bottom_outer_2' }, color: 'black', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w20', name: 'SEN66 VDD', from: { terminal: 'sen66.VDD' }, to: { hole: 'bb_b.bottom_inner_6' }, color: 'red', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w21', name: 'SEN66 GND', from: { terminal: 'sen66.GND' }, to: { hole: 'bb_b.bottom_outer_6' }, color: 'black', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w22', name: 'SEN66 SDA', from: { terminal: 'sen66.SDA' }, to: { hole: 'bb_b.b3' }, color: 'blue', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w23', name: 'SEN66 SCL', from: { terminal: 'sen66.SCL' }, to: { hole: 'bb_b.b5' }, color: 'yellow', route: 'elevated' } },
    { op: 'add_wire', wire: { id: 'w24', name: 'SEN66 SEL → GND', from: { terminal: 'sen66.SEL' }, to: { hole: 'bb_b.bottom_outer_7' }, color: 'black', route: 'elevated' } },
    { op: 'add_net_intent', net_intent: { id: 'n_sda', name: 'SDA', endpoints: ['mcu.D4', 'sht41.SDA', 'bmp390.SDA', 'ltr390.SDA', 'sen66.SDA'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_scl', name: 'SCL', endpoints: ['mcu.D5', 'sht41.SCL', 'bmp390.SCL', 'ltr390.SCL', 'sen66.SCL'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_gnd', name: 'GND', endpoints: ['mcu.GND', 'sht41.GND', 'bmp390.GND', 'ltr390.GND', 'sen66.GND', 'sen66.SEL', 'psu.GND'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_3v3_a', name: '3V3_A', endpoints: ['mcu.3V3', 'sht41.VCC', 'bmp390.VCC', 'ltr390.VCC'] } },
    { op: 'add_net_intent', net_intent: { id: 'n_3v3_b', name: '3V3_B', endpoints: ['psu.3V3', 'sen66.VDD'] } },
    { op: 'add_constraint', constraint: { id: 'c_isolate', type: 'isolate', a: 'mcu.3V3', b: 'psu.3V3', notes: 'XIAO 的 LDO 与外部电源不得并联' } },
    { op: 'add_constraint', constraint: { id: 'c_note', type: 'note', text: 'SEN66 峰值电流与电源模块能力未填写，供电评估保持待审核。' } }
  ],
  'env wires'
);
write('environment_node.breadboard.json', env);

// ---------------------------------------------------------------------------
// Counter-examples (must fail or warn in specific ways; see packages/cli tests)
// ---------------------------------------------------------------------------
const shortPG = run(desk, [{ op: 'add_wire', wire: { id: 'w_bad', name: '误接：+ 轨到 − 轨', from: { hole: 'bb.top_inner_20' }, to: { hole: 'bb.top_outer_20' }, color: 'red' } }], 'short');
write('short_power_ground.breadboard.json', shortPG, invalidDir);

const openNet = run(env, [{ op: 'remove_wire', id: 'w10' }], 'open net');
write('open_net_intent.breadboard.json', openNet, invalidDir);

const invalidHole = JSON.parse(serializeDesign(env)) as DesignDocument;
invalidHole.wires.push({ id: 'w_bad', from: { hole: 'bb_a.k7' }, to: { hole: 'bb_a.a31' }, color: 'red', route: 'flat', path_mode: 'auto', waypoints_um: [] });
write('invalid_hole.breadboard.json', invalidHole, invalidDir);

const dup = JSON.parse(serializeDesign(env)) as DesignDocument;
dup.wires.push({ ...dup.wires[0]!, id: 'sht41' });
write('duplicate_id.breadboard.json', dup, invalidDir);

const i2cConflict = run(
  env,
  [
    {
      op: 'add_component',
      component: { id: 'sht41_b', name: 'SHT41 #2', model: 'sht41_breakout@1', placement: { kind: 'board', board_id: 'bb_b', anchor_hole: 'j10', anchor_pin: 'VCC', rotation_deg: 0 }, config: { i2c_address: 68, supply_voltage_v: null } }
    },
    { op: 'add_wire', wire: { id: 'w25', from: { hole: 'bb_b.i13' }, to: { hole: 'bb_b.c3' }, color: 'blue' } },
    { op: 'add_wire', wire: { id: 'w26', from: { hole: 'bb_b.i12' }, to: { hole: 'bb_b.c5' }, color: 'yellow' } },
    { op: 'add_wire', wire: { id: 'w27', from: { hole: 'bb_b.i10' }, to: { hole: 'bb_b.bottom_inner_9' }, color: 'red' } },
    { op: 'add_wire', wire: { id: 'w28', from: { hole: 'bb_b.i11' }, to: { hole: 'bb_b.bottom_outer_9' }, color: 'black' } }
  ],
  'i2c conflict'
);
write('i2c_address_conflict.breadboard.json', i2cConflict, invalidDir);

const future = JSON.parse(serializeDesign(env)) as DesignDocument;
future.schema_version = '9.0';
writeFileSync(join(invalidDir, 'future_schema_version.breadboard.json'), serializeDesign(future));
console.log('future_schema_version.breadboard.json'.padEnd(44), '(rejected at load)');

const holeConflict = JSON.parse(serializeDesign(env)) as DesignDocument;
holeConflict.components.push({ id: 'led1', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb_a', anchor_hole: 'j12', anchor_pin: 'A', rotation_deg: 0 } });
write('hole_conflict.breadboard.json', holeConflict, invalidDir);

const shortedByRail = run(
  createEmptyDesign('反例：LED 两脚插在同一电源轨'),
  [
    { op: 'add_board', board: { id: 'bb', model: 'breadboard_400@1', position_um: [0, 0], rotation_deg: 0 } },
    { op: 'add_component', component: { id: 'led1', model: 'led_5mm@1', placement: { kind: 'board', board_id: 'bb', anchor_hole: 'top_inner_3', anchor_pin: 'A', rotation_deg: 0 } } }
  ],
  'shorted by rail'
);
write('pins_shorted_by_rail.breadboard.json', shortedByRail, invalidDir);

const wrongJson = '{"schema_version": "1.0", "boards": [}';
writeFileSync(join(invalidDir, 'malformed.breadboard.json'), wrongJson + '\n');
console.log('malformed.breadboard.json'.padEnd(44), '(rejected at parse)');
