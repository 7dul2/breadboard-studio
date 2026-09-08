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
| `breadboard_400@1` | approximate | approximate | 30 列 + 4×25 孔轨（连续）；可拼接外形 82.55×53.34 mm，上下拼接时相邻 j/a 行中心距 25.40 mm。 |
| `breadboard_400_terminal@1` | approximate | approximate | 可拆拼装式的独立 300 孔中间接线板，不含电源条；高 35.56 mm。 |
| `breadboard_power_strip_25@1` | approximate | approximate | 可拆拼装式的独立 2×25 孔 `+/−` 电源条；高 12.70 mm，两轨互不导通。 |
| `breadboard_830@1` | approximate | approximate | 63 列 + 4×50 孔轨，每轨在 25/26 断开。 |
| `xiao_esp32s3_sense@1` | approximate | approximate | 2×7 针 2.54 mm，列距 15.24 mm，21×17.5 mm；USB-C 在上边缘，天线/摄像头区域单独描述。3V3 输出能力未填。 |
| `esp32s3_devkit_generic@1` | approximate | approximate | 通用双排针模板：`pins_per_side`、`row_spacing_um`、`body_size_um`、针名均可改；默认 DevKitC-1 44 针排布。 |
| `esp32s3_n16r8_dual_usb@1` | approximate | approximate | 27.94×57.15 mm 双 Type-C 44 针黑色开发板；N16R8、CH343、RGB、BOOT/RST，25.40 mm 排距跨面包板沟槽。 |
| `oled_0_96_i2c@1` / `oled_0_91_i2c@1` | approximate | approximate | 4 针单排 I²C 转接板，针序 `pin_names` 必须按丝印确认；地址 0x3C/0x3D。 |
| `oled_0_96_ssd1315_i2c@1` | approximate | approximate | 参考图中的 27×26.5 mm SSD1315 四针平躺模块；黑色屏幕，`display_color` 可切换白色/蓝色示例显示；`address_options` 0x3C/0x3D。 |

主控定义的 `electrical.i2c` 除 `sda_pin`/`scl_pin` 外可写 `controllers`（独立 I²C 控制器数量，ESP32-S3 为 2）与 `mappable: true`（额外总线可用任意 GPIO 角色引脚）；额外总线由实例 `config.i2c_buses` 声明。器件定义的 `address_options` 列出可通过跳线/电阻选择的地址，自动排线只会在这些选项里改地址。
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

## 仿真绑定 `simulation`

定义可选的 `simulation` 字段只声明“这个型号由哪个驱动模拟、引脚/控件/视觉如何对应”；具体行为写在 `packages/sim` 的驱动里，不进 JSON：

| 字段 | 说明 |
| --- | --- |
| `driver` | 版本化驱动 id，如 `mcu.esp32s3.behavioral@1`。规则引擎据此判断程序目标是否可仿真（缺少时报 `program_target_unsupported`）。 |
| `pins` | 引脚名 → 驱动通道（字符串，如 `"IO": "out"`）或 GPIO 号（数字，如 `"GPIO4": 4`）。 |
| `properties` | 驱动常量，如 OLED 的 `width`/`height`、MCU 的 `boot_gpio`/`rgb_gpio`/`uart0`。 |
| `controls[]` | 可交互区域 `{ id, feature_label, action: press|touch|toggle|slider, channel }`。 |
| `visuals[]` | 随运行状态变化的外观 `{ id, feature_label, kind: led|display|state, channel }`。 |

`feature_label` 必须与同一定义 `features[].label` 完全一致：点击命中区域与渲染区域继续由目录几何决定，驱动只通过 `channel` 收发事件。`features[].type` 新增 `led`（板载 RGB、单个 LED 的发光区域）。schema 见 `packages/schema/src/definition.schema.ts`，目录测试会校验这些字段。

当前声明的驱动：

| driver | 定义 | 绑定 |
| --- | --- | --- |
| `mcu.esp32s3.behavioral@1` | `esp32s3_n16r8_dual_usb@1`、`esp32s3_devkit_generic@1`、`xiao_esp32s3_sense@1` | `pins` 为 GPIO 号；N16R8 有 `BOOT`/`RST` 按键控件（`press`）与 `RGB` 视觉（`led`）；XIAO 记录用户 LED（GPIO21，低电平点亮）。 |
| `input.ttp223@1` | `ttp223_module@1` | `触摸区` 控件（`touch`）→ `IO` 输出通道 `out`。 |
| `display.ssd1315@1` | `oled_0_96_i2c@1`、`oled_0_91_i2c@1`、`oled_0_96_ssd1315_i2c@1` | `SDA`/`SCL`/`VCC`/`GND` 通道，`properties.width/height`，屏幕视觉（`display`，通道 `framebuffer`）。 |
| `output.led@1` | `led_5mm@1` | `A`/`K` → `anode`/`cathode`，`LED` 视觉（`led`，通道 `glow`）。 |
| `sensor.sht4x@1` | `sht41_breakout@1` | I²C 通道；`传感器` 上的温度/湿度滑杆控件（`slider`，通道 `temperature_c`/`humidity_rh`）。 |

**行为尚未实现**：阶段 0 只保存并校验这些绑定，驱动本身在阶段 1+ 实现（见 `docs/SIMULATOR_DESIGN.md`）；现在给主控写程序不会让任何元件动起来。

## 添加一个简单模块（不改应用代码）

1. 复制 `examples/custom_definition_example.json`，修改 `id`、`name`、`pin_names`、`pin_meta`、`electrical`、`render`，如实填写 `geometry_status`/`electrical_status` 和 `sources`。
2. 在编辑器里“元件库 → 导入定义”，或用 CLI：

   ```json
   { "ops": [ { "op": "add_definition", "definition": { ...你的 JSON... } } ] }
   ```

   定义会内嵌到设计文件的 `embedded_catalog`，随文件一起分发；同名同版本时内嵌定义优先。
3. 想贡献到内置目录：把 JSON 放到 `packages/catalog/src/definitions/`，在 `packages/catalog/src/index.ts` 增加一行 import 与一个数组项，运行 `pnpm test`（目录测试会做 schema 校验）。

## 绘图与许可

`render` 中的图形是原创矢量（矩形/圆/文字/路径），单位 µm，坐标相对元件左上角。`pin_render` 可将自动生成的针脚改成圆形焊点、设置焊孔与颜色，或在模型自行绘制丝印时隐藏默认针脚名。不要复制 Tinkercad/Fritzing/厂商的图片或 SVG；引用第三方资产必须确认再分发许可并在 `license.attribution` 与 `THIRD_PARTY_NOTICES.md` 中注明。

## 外观编辑器（在浏览器里修正绘图）

绘图和实物对不上（小电容位置、数量、朝向）时不必手改 JSON：在编辑器里选中该型号的任意一个实例，属性面板点“编辑外观绘图…”。

- 绘图按 `render` 图元自动分成“部件”：相邻/重叠的图元合成一个部件（例如一颗贴片电容 = 丝印框 + 本体 + 两个端头）；PCB 底板、模组屏蔽罩等大面积图元各自独立，不会把叠在上面的东西吞掉。带 `g` 标签的图元按标签分组，保存时会给所有图元补上 `g`，之后分组稳定。
- 操作：点选 / Shift 加选 / 框选；拖动或方向键（0.1 mm，Shift 1 mm）移动；⌘D 复制、Delete 删除、R 旋转 90°；右侧可直接输入部件左上角坐标；滚轮缩放，Alt+拖动平移。橙色圆圈是引脚的真实坐标，用来对位；引脚、外形、电气数据在这里都不会改。
- 底图：加载一张实物照片（横向照片会自动转 90°，可再按“转底图 90°”），把“底图长边 (mm)”改成照片里板子长边的真实尺寸，勾选“拖动底图”把针脚对到橙色圆圈上，然后调整透明度对照着搬元件。
- 保存：“保存到本项目”通过 `add_definition` 把改后的定义内嵌进设计（同一 `id@version`，本项目内覆盖内置定义，可撤销）；“导出定义 JSON”下载完整定义，把它复制回 `packages/catalog/src/definitions/` 即可让所有项目生效（记得同步更新 `status_notes` 说明依据）。
