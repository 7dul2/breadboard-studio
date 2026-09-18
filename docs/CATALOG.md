# 元件目录与建模指南

目录定义是 `packages/catalog/src/definitions/*.json` 中的纯 JSON，schema 见 `packages/schema/src/definition.schema.ts`。每个定义包含：唯一 `id`、`version`、名称、厂商/型号/版本、外形 `body`（板件是 `size_um` + `terminal_blocks`）、局部原点（左上角）、引脚坐标或参数化生成器、安装方式 `mount`、电气属性 `electrical` 与 `pin_meta`、原创正面绘图 `render`、可选反面绘图 `back_render`、可选策展标记 `featured`、来源 `sources`、许可 `license`、以及分开记录的 `geometry_status` / `electrical_status`。

## 证据状态

| 状态 | 含义 |
| --- | --- |
| `verified` | 该范围有可追溯证据与人工复核；几何需要实测（不是硬件认证）。 |
| `approximate` | 主要尺寸/数据来自资料，但细节未实测。 |
| `unknown` | 占位；使用前必须核实。 |

规则引擎对每个非 `verified` 的实例输出 `model_unverified`（needs_review），编辑器与导出图上显示徽标。**v0.1 内置定义没有任何几何是 verified。**

新增 `evidence[]` 的字段、升级/降级流程与社区实测表见 [VERIFICATION.md](VERIFICATION.md)。旧 verified 若缺证据会被拒绝导入，须补证据或显式降级。

## 内置定义（v0.1）

| 定义 | 几何 | 电气 | 说明 |
| --- | --- | --- | --- |
| `breadboard_400@1` | approximate | approximate | 30 列 + 4×25 孔轨（连续）；可拼接外形 82.55×53.34 mm，上下拼接时相邻 j/a 行中心距 25.40 mm。 |
| `breadboard_400_terminal@1` | approximate | approximate | 可拆拼装式的独立 300 孔中间接线板，不含电源条；高 35.56 mm。 |
| `breadboard_power_strip_25@1` | approximate | approximate | 可拆拼装式的独立 2×25 孔 `+/−` 电源条；高 12.70 mm，两轨互不导通。 |
| `breadboard_830@1` | approximate | approximate | 63 列 + 4×50 孔轨，每轨在 25/26 断开。 |
| `perfboard_5x7@1` | approximate | approximate | 5×7 cm、18×24 孔，2.54 mm；棕色酚醛板，每个焊盘独立。 |
| `perfboard_7x9@1` | approximate | approximate | 7×9 cm、27×35 孔，2.54 mm；绿色玻纤板，每个焊盘独立，行号可到 `AI`。 |
| `xiao_esp32s3_sense@1` | approximate | approximate | 2×7 针 2.54 mm，列距 15.24 mm，21×17.5 mm；USB-C 在上边缘，天线/摄像头区域单独描述。3V3 输出能力未填。 |
| `esp32s3_devkit_generic@1` | approximate | approximate | 通用双排针模板：`pins_per_side`、`row_spacing_um`、`body_size_um`、针名均可改；默认 DevKitC-1 44 针排布。 |
| `esp32s3_n16r8_dual_usb@1` | approximate | approximate | 27.94×57.15 mm 双 Type-C 44 针黑色开发板；N16R8、CH343、RGB、BOOT/RST，25.40 mm 排距跨面包板沟槽。 |
| `oled_0_96_i2c@1` / `oled_0_91_i2c@1` | approximate | approximate | 4 针单排 I²C 转接板，针序 `pin_names` 必须按丝印确认；地址 0x3C/0x3D。 |
| `oled_0_96_ssd1315_i2c@1` | approximate | approximate | 参考图中的 27×26.5 mm SSD1315 四针平躺模块；黑色屏幕，`display_color` 可切换白色/蓝色示例显示；`address_options` 0x3C/0x3D。 |
| `tft_1_77_st7735_spi@1` | approximate | approximate | 1.77 英寸 128×160 ST7735S SPI 屏，8 针 `GND/VCC/SCK/SDA/RES/RS/CS/LEDA`；背光脚 LEDA 未建模限流。 |
| `ttp223_module@1` | approximate | approximate | 3 针；输出电平随供电，`config.supply_v` 决定电平检查。 |
| `ttp224_module@1` | approximate | approximate | 35×29 mm 四路电容触摸模块，6 针；**唯一带 `back_render` 的定义**（60 个图元），元件库悬停详情并排显示正反面；针序与模式焊盘须按实物复核。 |
| `encoder_ky040@1` | approximate | approximate | EC11 / KY-040 类旋转编码器模块，5 针 `CLK/DT/SW/+/GND`；CLK/DT/SW 标为 `open_drain`，电平未知（`io_voltage_v: null`），上拉要按实物确认。 |
| `tactile_6x6@1` | approximate | approximate | 6×6×5 mm 四脚轻触按键，但**只建模两个电气端点** `A`/`B`（相距 2 个孔距）：另外两脚是同一开关的另一侧，接它们不会多出通路。 |
| `sht41_breakout@1` / `bmp390_breakout@1` / `ltr390_breakout@1` | unknown | approximate | 通用 I²C 转接板模板 + 芯片地址；转接板尺寸/针序/稳压未知。 |
| `sen66@1` | approximate | approximate | 板外线缆器件，6 端子 JST-GH；平均电流 ~90 mA，峰值未录入。 |
| `power_module_3v3@1` | unknown | unknown | 3V3/GND 输出占位；能力在 `config.capacity_ma` 填写。 |
| `resistor_axial@1` / `led_5mm@1` | approximate | approximate | 基础两端元件；两端之间不是短路。 |

主控定义的 `electrical.i2c` 除 `sda_pin`/`scl_pin` 外可写 `controllers`（独立 I²C 控制器数量，ESP32-S3 为 2）与 `mappable: true`（额外总线可用任意 GPIO 角色引脚）；额外总线由实例 `config.i2c_buses` 声明。器件定义的 `address_options` 列出可通过跳线/电阻选择的地址，自动排线只会在这些选项里改地址。

来源链接写在各定义的 `sources` 字段中，可用 `pnpm bb catalog inspect <ref> --json` 查看。

## 默认视图与折叠 `featured`

元件库不再用硬编码白名单决定露出哪些型号（issue #32）。`featured: true` 的定义进默认视图；没有这个字段的定义仍然在库里，只是折叠进所属类目的「更多内置型号」，点开就能添加。几条约定：

- 搜索框覆盖**整个目录**（含折叠项），所以折叠永远不是不可达：搜到即添加，不需要先展开。
- 折叠状态只活在当前会话（切换左侧页签不丢，刷新回到默认折叠），不写进设计文件。
- **内嵌进当前设计的定义始终钉在可见位置**，不管它有没有 `featured`——否则导入一份自带定义的设计会看起来「少了件」。
- 非 `verified` 的定义在卡片上显示状态徽标，文案与画布徽标同源（`几何近似` / `电气未知` 等，两处共用 `modelStatusText()`）。徽标是提醒不是禁令：`unknown` 的占位定义默认折叠，但照样能添加，后果写在 `notes` 里。
- 目录测试把精选集合钉死（`packages/catalog/test/catalog.test.ts`）：新增定义不会悄悄改变默认视图，精选型号也不会悄悄掉进折叠区。

当前 24 个内置定义里 12 个是精选：`breadboard_400`、`breadboard_400_terminal`、`breadboard_830`、`breadboard_power_strip_25`、`perfboard_5x7`、`perfboard_7x9`、`esp32s3_n16r8_dual_usb`、`oled_0_96_ssd1315_i2c`、`ttp224_module`、`tft_1_77_st7735_spi`、`encoder_ky040`、`tactile_6x6`。其余 12 个（XIAO、通用 DevKit 模板、0.96/0.91 英寸通用 OLED、TTP223、三个传感器转接板、SEN66、电源模块、电阻、LED）折叠在各自类目下，搜索照样直达。

## 洞洞板定义

洞洞板使用与面包板相同的 `BoardDefinition`，但 `render.style` 为 `perfboard`，不声明电源轨或中央沟槽。每个物理行可以建模为一个只含单行的 `terminal_block`，这样每个孔天然是独立导通组；行标签可以是一个或多个 ASCII 字母（例如 `A`、`AA`；schema 的 `rows` 允许 `^[A-Za-z]+$`）。元件仍通过普通板上锚点放置，导线、自动布线、校验、接线向导和 SVG/PNG 导出复用同一套板机制。

洞洞板的电气语义与面包板有三处不同，都在模型层实现，不是界面特例：

- **每个焊盘独立导通**（`groupHoles('pb.A1') === ['pb.A1']`），没有「同列五孔」这种隐式分组。
- **导线可以落在已被引脚占用的焊盘上**：焊接面本来就可以在同一个焊点再焊一根线，所以这里不报 `wire_endpoint_occupied`。同一焊盘上的**第二根导线**仍然报 `wire_hole_conflict`。
- **自动排线对洞洞板外设只认引脚自己的焊盘**：该焊盘空闲就用它，被占则跳过并报 `solder_pad_in_use`（不会去用同组其它孔，因为根本没有同组）。洞洞板上的主机引脚也可以从自己的焊盘出线。

洞洞板尺寸编辑的“行数”是整块板的物理行数，而不是面包板每个接线块的行数；派生时按整行裁剪，所以 `AA` 这样的多字母行号保持稳定。`5×7` 与 `7×9` 型号都能在创建时、属性面板或画布尺寸把手中按 2.54 mm 孔距派生自定义列/行数（列 5–120，行 1–原行数）；派生定义内嵌进设计，见 [`DESIGN_FORMAT.md`](DESIGN_FORMAT.md#面包板-boards)。洞洞板默认不提供面包板式机械拼装入口（拼接对话框与吸附都只认面包板）。

画布的「视图」菜单里有「洞洞板翻到焊接面」开关。**当前实现是全局翻转**：翻一块板会把所有板、元件与导线一起镜像，而且翻面后文字也会镜像。这是已知缺陷，需求与验收见 [`PERFBOARD_UX.md`](PERFBOARD_UX.md)。

## 引脚元数据 `pin_meta`

每根引脚除 `role`、`direction`、`drive`、电压等字段外，还有以下决定工具行为的字段：

| 字段 | 含义 |
| --- | --- |
| `auto_wire` | 给自动排线的**偏好**：`avoid` 只在没有别的空闲引脚时才用（strapping、USB），`skip` 从不自动接，`to_ground` / `to_power` 表示这是应当接到地/电源的配置脚。 |
| `multiplex` | `strapping` / `usb` / `jtag` 数组；接线时提示启动/外设复用风险，自动排线优先避让。 |
| `reserved` | 关于板子的**事实**：这根引脚虽然引到了排针上，但已被板载存储器占用（`flash` / `psram`），根本不能当作外接 GPIO 使用。 |

两者强度不同。`reserved` 比 `auto_wire: "skip"` 更硬：自动排线不但不会选它，用 `signal_pins` 指名它也会直接报错（线接得上，但不会工作）；仿真器还会拒绝把它当 GPIO 建模——程序对它的 `pinMode` / `digitalWrite` / `digitalRead` 一律不生效，引脚保持高阻、读回 0，并报出一条 `reserved_pin_used`（warning）。请在 `notes` 里写清后果，诊断与排线报告都会引用它。

`reserved` 是**型号**属性而不是芯片属性：ESP32-S3 只有配八线 PSRAM（N16R8 里的 R8）的模组才占用 GPIO35–37，同样封装的 N8R2 这三根是自由的。内置定义里 `esp32s3_n16r8_dual_usb@1` 与 `esp32s3_devkit_generic@1` 按各自 `model` 字段声明的 N16R8 标了 `"reserved": "psram"`；`xiao_esp32s3_sense@1` 虽然也带 8 MB PSRAM，但 14 针排针根本没有把这三根线引出来，因此没有可标的引脚。手里的板子若不是八线 PSRAM 型号，复制一份定义去掉该标记即可。

## 导通 `conduction`

`conduction` 声明一个两端元件**怎么导通**。它和 `internal_nets` 是两件事：`internal_nets` 说两根引脚就是同一个节点（模块内部共地），`conduction` 说两脚之间有电流通路，但未必是同一节点。

| `kind` | 语义 | 进哪些图 |
| --- | --- | --- |
| `resistor` | 阻抗：电流能过去，但两脚不是同一节点 | 只进 `full` |
| `switch` | 机械触点：**闭合时才有通路，而且闭合时两脚就是同一节点** | 闭合时进 `full` 与 `direct` |
| `diode` | 单向导通：`pins[0]` 是阳极、`pins[1]` 是阴极，电流只按这个方向过去 | 有向边，只被 `full` 跟随；`direct` 不进 |
| `short` | 0 Ω 链接（跳线、焊桥、0 Ω 电阻），等同导线 | 进 `full` 与 `direct` |
| `open` | 声明该元件在直流下**不导通**（如电容） | 都不进 |

字段：`pins`（恰好两个终端），`value_param`（`resistor` 专用，指向 `params` 里的阻值标注），`state_param`（`switch` 专用，指向 `params` 里的布尔闭合状态，默认 `"closed"`）。

这个区分决定校验怎么说话。`full` 回答"电流能不能从这里到那里"，`direct` 回答"这是不是同一个电学节点"：电源与地落在同一个 `full` 上但不同 `direct`，是负载；落在同一个 `direct` 上，是短路。于是：

- 电阻跨电源与地 → `passive_load`（附估算电流），不是短路；
- **闭合的开关**跨电源与地 → `power_ground_short`（error），建议里会点名这个闭合链接；
- 开关与电阻串联后跨电源与地 → 开关按 0 Ω 计入，仍按阻值算电流。

开关状态是**实例属性**而不是型号属性（它是搭建/接线时的状态）：轻触按键 `tactile_6x6@1` 的 `params.closed` 默认 `false`（松开），属性面板里渲染成复选框。仿真里"按一下"的交互式按压仍然需要驱动，见 `simulation`。

**二极管**已实现（#40）：`pins[0]` 是阳极、`pins[1]` 是阴极，方向存在一条**有向边**里，只有 `full` 跟随——`direct` 不动，所以两脚仍不是同一节点，反向截止的二极管不会看起来像导线（有锁定反向的单测）。后果因此分得清：

- **正向**跨电源与地 → `power_ground_short`（error），文案点名这个二极管并建议串限流电阻；
- **反向**跨电源与地 → 无电流，也不报错（隔离与复用检查跟随 `full`，正向二极管算破坏隔离、计入已用，反向不算）；
- 二极管与电阻串联后跨电源与地 → 电流照算；**压降未建模**：正向按 0 Ω 算，约 0.7 V 的 Vf 不进估算，且电源与地分属不同网络（这正是节点语义的正确结果），`passive_load` 的信息暂缺。

真实 diode 定义（1N4148 等）随后续元件目录条目进 `packages/catalog`。同理，`open` 是一次**声明**而不是省略——"没写导通路径"和"写了不导通"是两件事，规则不该去猜。

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
| `controls[]` | 可交互区域 `{ id, feature_label, action: press|touch|toggle|slider, channel, range? }`。滑杆的 `range`（`min`/`max`/`step`/`default`/`unit`）属于**元件**而不是界面：−40…125 °C 是 SHT4x 的能量程，面板不该知道 SHT4x 是什么。 |
| `visuals[]` | 随运行状态变化的外观 `{ id, feature_label, kind: led|display|state, channel }`。 |

`feature_label` 必须与同一定义 `features[].label` 完全一致：点击命中区域与渲染区域继续由目录几何决定，驱动只通过 `channel` 收发事件。`features[].type` 包含 `led`（板载 RGB、单个 LED 的发光区域）、`button`、`sensor_window`、`display` 等。schema 见 `packages/schema/src/definition.schema.ts`，目录测试会校验这些字段。

当前声明的驱动（8 个，注册表在 `packages/sim/src/devices/registry.ts`）：

| driver | 定义 | 绑定 |
| --- | --- | --- |
| `mcu.esp32s3.behavioral@1` | `esp32s3_n16r8_dual_usb@1`、`esp32s3_devkit_generic@1`、`xiao_esp32s3_sense@1` | `pins` 为 GPIO 号；N16R8 有 `BOOT`/`RST` 按键控件（`press`）与 `RGB` 视觉（`led`）；XIAO 记录用户 LED（GPIO21，低电平点亮）。 |
| `input.ttp223@1` | `ttp223_module@1` | `触摸区` 控件（`touch`）→ `IO` 输出通道 `out`。 |
| `display.ssd1315@1` | `oled_0_96_i2c@1`、`oled_0_91_i2c@1`、`oled_0_96_ssd1315_i2c@1` | `SDA`/`SCL`/`VCC`/`GND` 通道，`properties.width/height`，屏幕视觉（`display`，通道 `framebuffer`）。 |
| `output.led@1` | `led_5mm@1` | `A`/`K` → `anode`/`cathode`，`LED` 视觉（`led`，通道 `glow`）。 |
| `sensor.sht4x@1` | `sht41_breakout@1` | I²C 通道；`传感器` 上的温度/湿度滑杆控件（`slider`，通道 `temperature_c`/`humidity_rh`，范围 −40…125 °C / 0…100 %RH）。 |
| `sensor.ltr390@1` | `ltr390_breakout@1` | I²C 通道；环境光（`ambient_lux`）与 UV 指数（`uv_index`）滑杆。 |
| `sensor.sen6x@1` | `sen66@1` | I²C 通道；九个空气质量量各自一个滑杆（`pm1_ugm3` 等），不强加 PM1 ≤ PM2.5 ≤ PM4 ≤ PM10 的物理约束。 |
| `sensor.bmp390@1` | `bmp390_breakout@1` | I²C 通道；气压（`pressure_hpa`，300–1250）与温度滑杆。器件报**原始 ADC 值**，补偿多项式由程序自己跑。 |

**行为已实现**（阶段 1–4）：这些绑定对应的驱动都在 `packages/sim` 里，给主控写程序能真的驱动板载 RGB、点亮 LED、把画面写进 OLED、读到滑杆上的传感器值。设计、运行态与诊断码的完整说明见 [`SIMULATOR_DESIGN.md`](SIMULATOR_DESIGN.md)；`program_target_unsupported` 只在目标型号**没有** `simulation.driver` 时出现，不是「阶段未到」。目录里还有一批没有驱动的型号（TFT、编码器、轻触按键、TTP224 等），它们能放置、接线、导出，但仿真时不会动。

## 添加一个简单模块（不改应用代码）

1. 复制 `examples/custom_definition_example.json`，修改 `id`、`name`、`pin_names`、`pin_meta`、`electrical`、`render`，如实填写 `geometry_status`/`electrical_status` 和 `sources`。想让它进默认视图再加 `featured: true`，否则它会折叠在对应类目的「更多内置型号」里。
2. 在编辑器里“元件库 → 导入定义”，或用 CLI：

   ```json
   { "ops": [ { "op": "add_definition", "definition": { ...你的 JSON... } } ] }
   ```

   定义会内嵌到设计文件的 `embedded_catalog`，随文件一起分发；同名同版本时内嵌定义优先。
3. 想贡献到内置目录：把 JSON 放到 `packages/catalog/src/definitions/`，在 `packages/catalog/src/index.ts` 增加一行 import 与一个数组项，运行 `pnpm test`（目录测试会做 schema 校验）。

## 绘图与许可

`render` 中的图形是原创正面矢量（矩形/圆/文字/路径），单位 µm，坐标相对元件左上角。元件可选用同样格式和坐标系的 `back_render` 描绘反面；存在时元件库悬停详情会同时显示正反面，不存在时仍只显示正面。`pin_render` 可将自动生成的针脚改成圆形焊点、设置焊孔与颜色，或在模型自行绘制丝印时隐藏默认针脚名。不要复制 Tinkercad/Fritzing/厂商的图片或 SVG；引用第三方资产必须确认再分发许可并在 `license.attribution` 与 `THIRD_PARTY_NOTICES.md` 中注明。

## 外观编辑器（在浏览器里修正绘图）

绘图和实物对不上（小电容位置、数量、朝向）时不必手改 JSON：在编辑器里选中该型号的任意一个实例，属性面板点“编辑外观绘图…”。

- 绘图按 `render` 图元自动分成“部件”：相邻/重叠的图元合成一个部件（例如一颗贴片电容 = 丝印框 + 本体 + 两个端头）；PCB 底板、模组屏蔽罩等大面积图元各自独立，不会把叠在上面的东西吞掉。带 `g` 标签的图元按标签分组，保存时会给所有图元补上 `g`，之后分组稳定。
- 操作：点选 / Shift 加选 / 框选；拖动或方向键（0.1 mm，Shift 1 mm）移动；⌘D 复制、Delete 删除、R 旋转 90°；右侧可直接输入部件左上角坐标；滚轮缩放，Alt+拖动平移。橙色圆圈是引脚的真实坐标，用来对位；引脚、外形、电气数据在这里都不会改。
- 底图：加载一张实物照片（横向照片会自动转 90°，可再按“转底图 90°”），把“底图长边 (mm)”改成照片里板子长边的真实尺寸，勾选“拖动底图”把针脚对到橙色圆圈上，然后调整透明度对照着搬元件。
- 保存，三个去处，按持久程度排：
  - **“写回元件库”**（只在本地 `pnpm dev` 下出现）：直接覆盖 `packages/catalog/src/definitions/<id>.json`，也就是内置目录真正读的那个文件。改一次所有项目都对，文件本身受 git 管理，写错了 `git checkout` 就回来。**绘图本身画错了，就该走这条。** 写入前浏览器会用 `validateComponentDefinition`（内置目录启动时跑的同一个校验器）挡一道，不合 schema 就不发；服务端只允许覆盖已存在的 `<id>.json`，且 `kind`/`id`/`version` 必须与原文件一致，不能新建、不能跨目录。记得同步更新 `status_notes` 说明依据。
  - “保存到本项目”：通过 `add_definition` 内嵌进当前设计（同一 `id@version`，仅本项目内覆盖内置定义，可撤销）。**只活在这一份文档里**——`replace_design` 在新文档没带 `embedded_catalog` 时会把它删掉，所以应用 DSL 草稿、导入、载入示例、新建项目，以及撤销回到保存之前，都会让绘图退回内置版本（DSL 那条路会额外提示一句）。适合“这块板子我这个项目里想画得不一样”，不适合“库里画错了”。
  - “导出定义 JSON”：下载完整定义，手动复制回 `packages/catalog/src/definitions/`。没有本地 dev server 时用它。

I²C 上拉用 `electrical.i2c.pullups` 建模，内置目录暂为 unknown。字段与规则限制见 [静态规则的边界](VERIFICATION.md#静态规则的边界)。
