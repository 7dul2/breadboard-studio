# 定义证据与实测协作

`verified` 表示该版本定义的某一范围经过记录与人工复核，不是硬件认证，也不保证任意同名商品一致。仿真通过、单元测试通过、丝印照片或来源标题本身都不能证明实物尺寸和电气连接正确。当前内置定义没有 verified 项；此前通用电阻的电气 verified 因缺可追溯证据降为 approximate。

## 状态与证据等级

定义继续使用 `geometry_status` / `electrical_status`，另用可选 `evidence[]` 记录每个范围的证据。没有证据字段的旧 approximate/unknown 定义仍可加载。

| 状态/等级 | 要求 |
| --- | --- |
| unknown | 未掌握足够数据，不猜测。 |
| approximate | 有资料或初步测量，范围不全、未复核或板型不确定。 |
| documented | 有可访问的数据手册、原理图等资料，并记录章节、核对方法和结论。 |
| measured | 有具体样品和可复核的尺寸/导通/测量结果，注明方法、误差和条件。 |
| verified | 对该范围的证据经人工审查；几何至少含 measured，电气允许 documented 或 measured。 |

每条 evidence 包含 `facet`（geometry/electrical）、`level`（documented/measured）、`source_url`（HTTP(S) 报告/资料链接）、`scope`（板型、版本、核对字段与未覆盖项）、`method`、`result`、`recorded_at`（YYYY-MM-DD）。复核后添加 `reviewer` 与 `reviewed_at`，复核日期不得早于记录日期。链接、姓名、日期只是可追溯记录，不是数字签名；程序不能证明照片真实或审查已经实际完成。

几何复核应覆盖外形、排距、孔距、针脚坐标、安装方向和离板高度。元件电气复核应覆盖针序、角色、电压、内部连接及该定义声明的接口信息；面包板电气复核应覆盖接线区分组、电源轨连续性/断点和轨间隔离。只有部分字段获得证据时仍保持 approximate，在 scope 写清已知与未知，不用整体 verified 掩盖缺口。

## 流转

1. 贡献者提交 [实测报告](https://github.com/7dul2/breadboard-studio/issues/new?template=hardware_measurement.md)，无需写代码。先确认定义 id@version 与手中型号/PCB 版本。
2. 维护者把资料或实测记录放进 evidence，先保持 approximate。不同板型应另建定义，不把一个样品的结果推广到所有同名商品。
3. 复核者检查来源可访问、方法可重现、数值与 JSON 字段吻合，范围完整后填写 reviewer/reviewed_at，再将相应状态改为 verified。校验器拒绝缺少复核记录的 verified；几何还必须有实测记录。
4. 若出现矛盾、证据失效或模型更改，先退回 approximate/unknown，在 status_notes 写明原因，保留旧报告供追溯。影响几何/针序/电气事实的后续更改应使用新定义版本，并重新复核受影响范围；改绘图配色不意味着重新实测。
5. PR 运行 `pnpm typecheck && pnpm test && pnpm build`。通过后人工审查，提交报告本身不会自动升级状态。

完整设计导入、单个定义导入与目录加载使用同样的证据门槛。旧文件若包含无证据的 verified 内嵌定义，会明确校验失败；应补真实证据或显式降级，工具不自动虚构记录。证据参与设计文件序列化与内容哈希。

## 量什么、怎么量

先断开 USB、电池与外部电源，再做尺寸、阻值与通断测量；不要在通电板上使用电阻/蜂鸣挡。无需为报告冒险上电，无法测量的项目填“未测”。

| 范围 | 方法 | 报告内容 |
| --- | --- | --- |
| 实物身份 | 记录 PCB 丝印/版本、模组后缀、连接器方向 | 定义 id@version、样品描述、正反面照片；隐藏序列号等私人信息。 |
| 几何 | 卡尺量外形、排针中心距、两排中心距、离板高度；长跨度测量多个间隔再除以间隔数 | mm 原始读数、测量位置、工具分辨率/误差、至少重复读数；勿只量针脚边缘当中心距。 |
| 针序 | 固定观察面和方向，按官方针脚图/原理图逐针核对 | 逐针名称、序号、资料章节及链接；特别注明镜像、底视图。 |
| 面包板导通 | 断电后用万用表查同列、沟槽两侧、每条轨端点及疑似断点两侧 | 孔地址对、导通/断开、实际阻值（如有），不要只按印刷红蓝线推断。 |
| I²C 上拉 | 查具体转接板原理图；断电后测 SDA→供电、SCL→供电阻值，注意其它并联路径 | 两根线分别的阻值、目标电源轨、是否拆除外部连线、模块跳线状态；不确定就 unknown。 |
| GPIO 复用 | 对照板型原理图与芯片手册，确认引出脚对应 GPIO | strapping/USB/JTAG、板载连接、已知固件配置；不要求修改 eFuse。 |

电源容量、峰值电流、上升时间等需要额外设备与条件，不能由蜂鸣挡或仿真推断。可提供已有示波器记录，但请写明供电、总线频率、探头与测量条件。维护者不得把“未测”填成通过。

## 静态规则的边界

`electrical.i2c.pullups` 记录定义原始 SDA/SCL 针上的物理上拉：`state: present|absent|unknown`；present 需要 `supply_pin`，可填正数 `resistance_ohms`（每根线相同阻值）。省略等于 unknown。不等值、可切换或复杂模块先保持 unknown 并说明；外置电阻可逐根建模。实例的软件 I²C 引脚重映射不会移动物理上拉。

检查使用直接节点与单个电阻连接，识别内置上拉及外置 `resistor_axial` 到 power_out 节点的路径。缺上拉报 `i2c_pullup_missing`（warning），资料/供电路径不足报 `i2c_pullup_unknown`（needs_review），多组报 `i2c_pullup_parallel`（warning，同一电源节点且阻值完整时给出并联估算）。power_out 仅是目录声明，不能证明实物已供电。未连接的空闲总线不提示。不计算总线电容、上升时间或完整模拟电路；存在上拉不表示阻值、电压或时序合格。

`pin_meta.multiplex` 可列出 strapping/usb/jtag。外接导线或器件后报 `gpio_strapping_used` / `gpio_usb_used` / `gpio_jtag_used`（warning）；strapping 提醒复位采样，USB/JTAG 提醒条件性冲突，不推断运行固件/eFuse。自动排线将它们作为避让池，普通 GPIO 用尽才回退，显式 signal_pins 也会提示。`reserved: flash|psram` 仍是不可分配的板型事实，并补齐手工接线时的 `reserved_pin_used`。

参考：[Espressif ESP32-S3 GPIO 文档](https://docs.espressif.com/projects/esp-idf/en/v5.1/esp32s3/api-reference/peripherals/gpio.html)、[ESP32-S3 数据手册](https://documentation.espressif.com/esp32_s3_datasheet_en.pdf)、[NXP I²C 规范 UM10204](https://community.nxp.com/pwmxy87654/attachments/pwmxy87654/nxp-designs/931/1/UM10204.pdf)。来源说明芯片/协议事实，具体商品仍需板级核对。
