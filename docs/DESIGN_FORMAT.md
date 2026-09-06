# 设计文件格式 `.breadboard.json`（schema 1.0）

声明式 JSON，JSON Schema 2020-12 定义见 `packages/schema/src/design.schema.ts`（`pnpm bb schema` 可直接输出）。字段使用 snake_case；所有长度为整数微米。完整可解析示例：`examples/environment_node.breadboard.json`、`examples/desk_device.breadboard.json`。

## 顶层

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema_version` | 是 | 当前 `"1.0"`。未支持的版本被拒绝，不做猜测式迁移。 |
| `catalog_versions` | 是 | `{ "builtin": "0.1.0" }`，记录保存时用到的目录版本。 |
| `metadata` | 是 | `name`、`revision`（每次事务 +1）、`description?`、`author?`、`created_at?`、`updated_at?`、`tags?`、`notes?`。 |
| `boards` | 是 | 面包板实例数组。 |
| `components` | 是 | 元件实例数组。 |
| `wires` | 是 | 导线数组。 |
| `net_intents` | 是 | 期望连通的端点集合（只校验，不生成导线）。 |
| `constraints` | 是 | 约束数组。 |
| `embedded_catalog` | 否 | `{ boards?: [...], components?: [...] }`，内嵌的定义，优先于内置目录中同名同版本的定义。外观编辑器保存的绘图也放在这里；其 `render` 图元带 `g` 部件标签。 |
| `view` | 否 | 视图状态：`zoom`、`center_um`、`show_hole_labels`、`show_pin_labels`、`build_done`（已完成的线 id）。不参与校验与哈希。 |

## 面包板 `boards[]`

```json
{ "id": "bb_a", "name": "板 A", "model": "breadboard_400@1", "position_um": [0, 0], "rotation_deg": 0, "locked": false, "notes": "" }
```

- `model`：`<定义 id>@<版本>`。内置：`breadboard_400@1`（轨道连续）、`breadboard_830@1`（每条轨在 25/26 断开）。
- `position_um`：板体左上角的全局坐标；`rotation_deg` ∈ {0, 90, 180, 270}，顺时针。
- 孔名：`a1`–`j30`（830 板到 `j63`）；轨孔 `top_outer_1`…、`top_inner_…`、`bottom_inner_…`、`bottom_outer_…`。

## 元件 `components[]`

```json
{
  "id": "mcu",
  "name": "XIAO ESP32-S3 Sense",
  "model": "xiao_esp32s3_sense@1",
  "placement": { "kind": "board", "board_id": "bb_a", "anchor_hole": "b3", "anchor_pin": "D6", "rotation_deg": 90 },
  "params": { },
  "config": { "i2c_address": 68 },
  "locked": false,
  "notes": ""
}
```

- 板上放置：锚点引脚 `anchor_pin` 插在 `anchor_hole`，其余引脚落孔由几何派生。
- 板外放置：`{ "kind": "off_board", "position_um": [x, y], "rotation_deg": 0 }`。
- `params`：模板参数（针序 `pin_names`、外形 `body_size_um`、`mount_orientation`、双排针 `pins_per_side`/`row_spacing_um`/`left_pin_names`/`right_pin_names`、电阻 `span_pitches` 等），由定义的 `params_schema` 校验。
- `config`：电气配置（`i2c_address`、`supply_voltage_v`、`supply_v`、`capacity_ma`、`i2c_sda_pin`/`i2c_scl_pin` 等），由 `config_schema` 校验。显式 `null` 表示“未知”，会进入待审核项。主控的 `i2c_buses: [{ "sda": "GPIO12", "scl": "GPIO11" }]` 声明第 2 条起的 I²C 总线（目录 `electrical.i2c.controllers` 给出控制器数量、`mappable` 表示可映射到任意 GPIO）；规则引擎按每条总线分别检查地址冲突，自动排线遇到同地址器件时会自动填写。

## 导线 `wires[]`

```json
{ "id": "w9", "name": "SDA D4 → SHT41", "from": { "hole": "bb_a.a5" }, "to": { "hole": "bb_a.h15" }, "color": "blue", "route": "elevated", "path_mode": "auto", "waypoints_um": [[16955, 20000], [42385, 20000]] }
```

- 端点：`{ "hole": "board.hole" }` 或 `{ "terminal": "component.pin" }`（仅板外/未插入的引脚）。
- `to` 缺失 = 悬空草稿，报 `wire_dangling`，不导通。
- `color`：命名色（red/black/blue/yellow/green/white/orange/purple/brown/gray）或 `#rrggbb`。颜色不参与电气规则。
- `route`：`flat` 贴板硬跳线 / `elevated` 抬高软线。
- `path_mode`：`auto`（引擎生成并写回 `waypoints_um`）/ `manual`（保留用户拐点）。
- 长度不保存，由引擎按折线计算，不含插入深度、弯折与连接器余量。

## 网络意图 `net_intents[]`

```json
{ "id": "n_sda", "name": "SDA", "endpoints": ["mcu.D4", "sht41.SDA", "sen66.SDA"] }
```

端点可以是 `component.pin` 或 `board.hole`。未连通 → `net_intent_open`；两个意图被连到一起 → `net_intent_merged`。

## 约束 `constraints[]`

| type | 字段 | 规则 |
| --- | --- | --- |
| `isolate` | `a`, `b` | 两端点不得导通（`isolation_violated`）。 |
| `wire_length_max_um` | `max_um`, `wire_ids?` | 估算长度超限 → `wire_too_long`。 |
| `note` | `text` | 仅备注。 |

## 稳定性约定

- 所有 `id` 匹配 `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`，在整个文件内唯一。
- 往返（导出 → 导入）保留 id、坐标、端点、目录版本；内容哈希不变。
- 未知字段被拒绝（`additionalProperties: false`），避免静默丢失内容。
