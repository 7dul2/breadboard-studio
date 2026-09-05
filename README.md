# Breadboard Studio

面向人和 Agent 的面包板布局平台：在浏览器里拖放元件、接线并实时校验；Agent 通过同一套结构化 DSL 与 CLI 完成同样的操作，不需要截图定位或模拟鼠标。设计文件是唯一事实来源，UI 与 CLI 共用几何、导通图、规则和事务引擎。

**在线演示**：https://7dul2.github.io/breadboard-studio/ （静态站点，数据只保存在你的浏览器本地）

![编辑器：双面包板环境节点示例](docs/screenshots/editor-environment-node.png)

> English summary at the end of this file.

## 能做什么（v0.1）

- **真实孔阵的面包板**：400 孔（轨道连续）与 830 孔（轨道在 25/26 断开）型号，a–j 行、列号、中央沟槽、独立电源轨与断点都按型号数据绘制；两块 400 孔板可沿长边/短边栅格对齐拼接，几何拼接不会导通任何电源轨。
- **元件放置**：按锚点引脚落孔，引脚→孔位由几何派生；显示被引脚占用和被板体遮挡的孔；立式模块只占针排；板外器件只能用线缆连接端子；碰撞、脱格、同孔两针会被拒绝。
- **接线**：从明确的孔/端子到孔/端子，默认正交折线，可拖拐点、改颜色/线号，硬跳线与软线分开；交叉不导通；估算长度并声明不含插入余量。
- **校验**：格式/放置/面包板/导线/网络/接口/证据七类规则，`error`、`warning`、`needs_review`、`info` 四档；点击结果定位；I²C 地址只在同一实际总线上判冲突；未知数据保留待审核，不给假绿灯。
- **文件**：`.breadboard.json`（JSON Schema 2020-12）导入/导出、浏览器本地自动保存与旧项目恢复、SVG/PNG 导出（含图例与未验证徽标）、逐线搭建模式。
- **Agent/CLI**：`bb catalog | new | inspect | validate | connectivity | apply | export | steps`，补丁原子应用、revision/hash 防并发覆盖。
- **可扩展目录**：JSON 定义 + 参数化模板，导入自定义元件不需要改应用代码；每个定义分别记录几何与电气证据状态。

**第一版不做**：电流/电压模拟、单片机程序执行、自动布线、PCB/3D、云端账号与多人协作。所有“建议”都不宣称是已验证的电气结果。

## 快速开始

需要 Node.js ≥ 20.19 与 pnpm 11（`npm i -g pnpm@11`）。

```bash
git clone https://github.com/7dul2/breadboard-studio.git
cd breadboard-studio
pnpm install
pnpm dev            # 打开 http://localhost:5173
```

其他命令：

```bash
pnpm test           # Vitest：核心/目录/CLI 测试
pnpm test:e2e       # Playwright：浏览器关键流程（首次需 pnpm exec playwright install chromium）
pnpm typecheck
pnpm build          # 生成 apps/web/dist（静态站点）
pnpm perf           # 4 板 / 20 模块 / 100 线性能检查
```

## 编辑器速览

| 操作 | 方式 |
| --- | --- |
| 添加面包板 / 元件 | 左侧元件库点击；元件进入放置模式后在孔上点击落点，`R` 旋转，`Esc` 取消 |
| 选择 / 多选 / 移动 | 选择工具点击、`Shift` 加选、框选；拖动时预览落孔与冲突（红色） |
| 接线 | 接线工具（`W`）依次点击两个孔或端子；点击已插引脚会自动改用同组空孔 |
| 调整走线 | 选中导线后双击线段加拐点、拖动拐点、双击拐点删除，属性面板可重置为自动 |
| 旋转 / 锁定 / 删除 / 复制 | `R` / `L` / `Delete` / `⌘D`，或属性面板按钮 |
| 撤销 / 重做 | `⌘Z` / `⇧⌘Z`（含 Agent 批量修改） |
| 缩放 / 平移 | 触控板双指、`⌘`+滚轮缩放、空格拖动或平移工具、`F` 适应全部 |
| 导通高亮 | 点击任意孔显示同组五孔与整个导通网络 |
| DSL | 右侧“DSL”标签编辑 JSON 草稿，校验后显式应用；非法草稿不影响画布 |
| 搭建模式 | 右侧“搭建”标签按线号逐根显示两端与颜色，可勾选完成 |

![搭建模式](docs/screenshots/build-mode.png)

## Agent 与 CLI

```bash
pnpm bb catalog list --json
pnpm bb catalog inspect xiao_esp32s3_sense@1 --json
pnpm bb validate examples/environment_node.breadboard.json --json
pnpm bb connectivity examples/environment_node.breadboard.json --from bb_a.a7 --json
pnpm bb apply design.breadboard.json --patch edits.json --dry-run --json
pnpm bb apply design.breadboard.json --patch edits.json --out revised.breadboard.json --expect-revision 2
pnpm bb export revised.breadboard.json --format svg --out layout.svg
pnpm bb steps revised.breadboard.json --json
```

补丁示例（原子执行；结构非法时全部不应用，电气问题留在草稿并报告）：

```json
{ "expected_revision": 2, "ops": [
  { "op": "add_wire", "wire": { "from": { "pin": "mcu.D4" }, "to": { "pin": "sht41.SDA" }, "color": "blue" } },
  { "op": "update_property", "id": "sht41", "path": "config.i2c_address", "value": 68 }
] }
```

详见 [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md)、[docs/DESIGN_FORMAT.md](docs/DESIGN_FORMAT.md)。

## 示例

| 文件 | 内容 |
| --- | --- |
| `examples/desk_device.breadboard.json` | 830 孔板 + 通用 ESP32-S3 DevKit 模板 + 0.96" OLED + TTP223，含跨轨断点跳线 |
| `examples/environment_node.breadboard.json` | 两块 400 孔板拼接：XIAO ESP32-S3 Sense + SHT41/BMP390/LTR390 + 板外 SEN66 + 独立 3.3 V 电源 |
| `examples/stress_test.breadboard.json` | 4 板 / 20 模块 / 100 线性能样本 |
| `examples/invalid/*.breadboard.json` | 短路、断网、无效孔位、重复 ID、I²C 冲突、同孔冲突、未来版本、损坏 JSON 等反例 |
| `examples/custom_definition_example.json` | 自定义元件定义模板 |

![桌面设备示例（830 孔板）](docs/screenshots/desk-device-hole-highlight.png)

## 元件库与真实程度

内置：400/830 孔面包板、XIAO ESP32-S3 Sense、通用 ESP32-S3 DevKit 模板、0.96"/0.91" OLED、TTP223、SHT41/BMP390/LTR390 转接板模板、SEN66（板外线缆）、3.3 V 电源占位、电阻、LED。每个定义分别标注 `geometry_status` 与 `electrical_status`（`verified` / `approximate` / `unknown`）；**v0.1 没有任何定义的几何是 verified**，画布、导出图和校验结果都会提示。建模方法与添加新定义见 [docs/CATALOG.md](docs/CATALOG.md)。

## 已知限制

- 所有内置尺寸来自公开资料或常见值，未经卡尺实测；DevKit 排距、转接板针序必须按实物修改参数。
- 供电评估只做资料数值比较：能力未知或峰值未知一律保留待审核，不判定“足够”。
- 不检查 I²C 上拉、总线电容、GPIO 复用冲突；不做三维碰撞分析；走线长度是折线估算。
- 只支持 0/90/180/270° 旋转与 2.54 mm 栅格；不支持非栅格排针（如 2.0 mm）。
- 桌面优先；未针对手机布局；数据只存在浏览器本地（localStorage），请及时导出 JSON。

## 路线图

模型实测校验与 `verified` 标记、更多面包板型号（终端条无轨版、自定义轨道）、I²C 上拉与 GPIO 复用检查、更好的自动走线、贡献者模板校验工具、可选的 MCP 服务封装。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 单位、坐标、孔名、旋转、规则严重度等约定
- [docs/DESIGN_FORMAT.md](docs/DESIGN_FORMAT.md) 设计文件字段
- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) CLI 与补丁
- [docs/CATALOG.md](docs/CATALOG.md) 元件建模与来源
- [docs/STATUS.md](docs/STATUS.md) 里程碑进度、验证结果与限制
- [docs/PLAN.md](docs/PLAN.md) 原始执行计划

许可证：MIT（见 [LICENSE](LICENSE)）。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English summary

Breadboard Studio is a browser-based breadboard layout tool for people **and** agents. Humans drag parts and draw wires on an SVG canvas with real hole grids (400/830-point boards, rails with declared breaks, ravine isolation); agents do the same through a declarative JSON DSL (`.breadboard.json`, JSON Schema 2020-12) and a CLI (`bb catalog | inspect | validate | connectivity | apply | export | steps`) that share the same geometry, net graph, rule engine and atomic transaction layer. Rules cover format, placement (pin-to-hole mapping, occupied vs. body-blocked holes, collisions, board-induced shorts), wiring, nets (power/ground shorts, voltage conflicts, missing common ground, open net intents), interfaces (push-pull conflicts, level mismatch, I²C address conflicts on the same physical bus) and evidence (unverified models, unknown supply capacity) with `error / warning / needs_review / info` severities — an absence of errors is never presented as a verified circuit. Exports: SVG/PNG with legend and unverified badges, wire-by-wire build steps. No simulation, auto-routing, PCB or cloud features in v0.1. MIT licensed.
