# 元件目录与建模指南

目录定义是 `packages/catalog/src/definitions/*.json` 中的纯 JSON，schema 见 `packages/schema/src/definition.schema.ts`。每个定义包含：唯一 `id`、`version`、名称、厂商/型号/版本、外形 `body`、局部原点（左上角）、引脚坐标或参数化生成器、安装方式 `mount`、电气属性 `electrical` 与 `pin_meta`、原创绘图 `render`、来源 `sources`、许可 `license`、以及分开记录的 `geometry_status` / `electrical_status`。

## 证据状态

| 状态 | 含义 |
| --- | --- |
| `verified` | 与注明的资料或实测吻合（不是硬件认证）。 |
| `approximate` | 主要尺寸/数据来自资料，但细节未实测。 |
| `unknown` | 占位；使用前必须核实。 |

规则引擎对每个非 `verified` 的实例输出 `model_unverified`（needs_review），编辑器与导出图上显示徽标。**v0.1 内置定义没有任何几何是 verified。**

## 内置定义（v0.1）

| 定义 | 几何 | 电气 | 说明 |
| --- | --- | --- | --- |
| `breadboard_400@1` | approximate | approximate | 30 列 + 4×25 孔轨（连续）；外形 82.55×54.6 mm，轨孔半孔距偏移。 |
| `breadboard_830@1` | approximate | approximate | 63 列 + 4×50 孔轨，每轨在 25/26 断开。 |
| `xiao_esp32s3_sense@1` | approximate | approximate | 2×7 针 2.54 mm，列距 15.24 mm，21×17.5 mm；USB-C 在上边缘，天线/摄像头区域单独描述。3V3 输出能力未填。 |
| `esp32s3_devkit_generic@1` | approximate | approximate | 通用双排针模板：`pins_per_side`、`row_spacing_um`、`body_size_um`、针名均可改；默认 DevKitC-1 44 针排布。 |
| `oled_0_96_i2c@1` / `oled_0_91_i2c@1` | approximate | approximate | 4 针单排 I²C 转接板，针序 `pin_names` 必须按丝印确认；地址 0x3C/0x3D。 |
| `ttp223_module@1` | approximate | approximate | 3 针；输出电平随供电，`config.supply_v` 决定电平检查。 |
| `sht41_breakout@1` / `bmp390_breakout@1` / `ltr390_breakout@1` | unknown | approximate | 通用 I²C 转接板模板 + 芯片地址；转接板尺寸/针序/稳压未知。 |
| `sen66@1` | approximate | approximate | 板外线缆器件，6 端子 JST-GH；平均电流 ~90 mA，峰值未录入。 |
| `power_module_3v3@1` | unknown | unknown | 3V3/GND 输出占位；能力在 `config.capacity_ma` 填写。 |
| `resistor_axial@1` / `led_5mm@1` | approximate | verified/approximate | 基础两端元件；两端之间不是短路。 |

来源链接写在各定义的 `sources` 字段中，可用 `pnpm bb catalog inspect <ref> --json` 查看。

## 参数化生成器

| `generator.type` | params | 结果 |
| --- | --- | --- |
| `single_row_header` | `pin_names[]`、`body_size_um`、`mount_orientation` | 一排 2.54 mm 针，位于 `edge` 边、距边 `inset_um`。`upright`（默认）只占用针排窄条；`flat` 整板遮挡。 |
| `dual_row_header` | `pins_per_side`、`row_spacing_um`、`body_size_um`、`left_pin_names[]`、`right_pin_names[]` | 两列针，第一针距顶边 `first_pin_um`。 |
| `axial_two_pin` | `span_pitches`、`value` | 两脚相距 N 孔距。 |

没有 `generator` 时使用显式 `pins[]`。

## 添加一个简单模块（不改应用代码）

1. 复制 `examples/custom_definition_example.json`，修改 `id`、`name`、`pin_names`、`pin_meta`、`electrical`、`render`，如实填写 `geometry_status`/`electrical_status` 和 `sources`。
2. 在编辑器里“元件库 → 导入定义”，或用 CLI：

   ```json
   { "ops": [ { "op": "add_definition", "definition": { ...你的 JSON... } } ] }
   ```

   定义会内嵌到设计文件的 `embedded_catalog`，随文件一起分发；同名同版本时内嵌定义优先。
3. 想贡献到内置目录：把 JSON 放到 `packages/catalog/src/definitions/`，在 `packages/catalog/src/index.ts` 增加一行 import 与一个数组项，运行 `pnpm test`（目录测试会做 schema 校验）。

## 绘图与许可

`render` 中的图形是原创矢量（矩形/圆/文字/路径），单位 µm，坐标相对元件左上角。不要复制 Tinkercad/Fritzing/厂商的图片或 SVG；引用第三方资产必须确认再分发许可并在 `license.attribution` 与 `THIRD_PARTY_NOTICES.md` 中注明。
