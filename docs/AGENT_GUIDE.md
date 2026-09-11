# Agent 使用指南（不依赖浏览器）

CLI 入口：`pnpm bb <命令>`（等价于 `node packages/cli/bin/bb.mjs`）。所有命令支持 `--json` 输出稳定 JSON；错误时退出码非零。**由程序解析 JSON 时请直接调用 `node packages/cli/bin/bb.mjs …`**：`pnpm` 在子命令非零退出时会往 stdout 追加一行 `[ELIFECYCLE] Command failed…`，会破坏 JSON。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（`validate` 时表示没有 error） |
| 1 | 设计存在 error / 文件无效 / 补丁被拒绝 |
| 2 | 用法或 IO 错误 |
| 3 | revision / hash 冲突（并发修改保护） |

## MCP server（工具通道）

`bb mcp` 在 stdio 上启动一个 MCP server。它不重新实现任何东西：每个工具都是上面 CLI 命令的数据层，返回体就是同一个 `--json` 载荷，所以 shell 与 MCP 两条路不会出现两套语义。stdout 只有协议流量（没有横幅、没有日志），日志一律走 stderr。

```bash
# Claude Code
claude mcp add breadboard -- node packages/cli/bin/bb.mjs mcp
```

```json
{
  "mcpServers": {
    "breadboard": { "command": "node", "args": ["/path/to/breadboard-studio/packages/cli/bin/bb.mjs", "mcp"] }
  }
}
```

| 工具 | 写文件 | 对应命令 / 说明 |
| --- | --- | --- |
| `catalog_list` / `catalog_inspect` | 否 | `catalog list` / `catalog inspect`：引脚角色、`reserved` 保留标记、参数 schema、证据状态 |
| `design_inspect` | 否 | `inspect`：元数据、revision/hash、板、引脚落孔、导线、网络、程序 |
| `design_validate` | 否 | `validate`：全部规则与逐条建议 |
| `connectivity` | 否 | `connectivity`：导通组、网络、导通集合 |
| `build_steps` | 否 | `steps`：逐线搭建步骤 |
| `list_programs` | 否 | `programs`：程序列表与仿真配置（不含源码） |
| `list_ops` | 否 | `ops`：补丁操作类型与字段 |
| `export_design` | 否 | `export`：SVG / 规范化 JSON，内容直接返回（不落盘） |
| `autowire` | 默认 dry-run | `autowire`：按引脚角色规划布线；`write: true` 才写 |
| `apply_patch` | 默认 dry-run | `apply`：原子补丁；`write: true` 才写 |

三条约定：

- **默认只读**：`autowire` 与 `apply_patch` 不带 `write: true` 时只报告，文件一个字节都不动；写入时同样接受 `expected_revision` / `expected_hash`，冲突返回错误码 3（与 CLI 一致）。
- **两种失败要分清**：设计里存在 error 是**调用成功**、结果 `ok: false`——那些 results 正是要拿走的东西；只有用法/事务错误才是 `isError`，正文为 `{ ok: false, error: { code, message } }`，`code` 与上表退出码同义。
- 补丁在 MCP 里**内联传对象**（`patch` 参数），不必先写临时文件；CLI 的 `--patch` 仍然只接受文件路径。

## 命令

```bash
pnpm bb catalog list --json                       # 可用面包板与元件（含证据状态）
pnpm bb catalog inspect xiao_esp32s3_sense@1 --json
pnpm bb new design.breadboard.json --name "我的节点"
pnpm bb inspect examples/environment_node.breadboard.json --json     # 引脚落孔、导线、网络、hash
pnpm bb validate examples/environment_node.breadboard.json --json    # 全部规则
pnpm bb connectivity examples/environment_node.breadboard.json --from bb_a.a7 --json
pnpm bb autowire design.breadboard.json --host mcu --components sht41,bmp390 --dry-run --json
pnpm bb apply design.breadboard.json --patch edits.json --dry-run --json
pnpm bb apply design.breadboard.json --patch edits.json --out revised.breadboard.json --expect-revision 2
pnpm bb export revised.breadboard.json --format svg --out layout.svg
pnpm bb steps revised.breadboard.json --json
pnpm bb programs design.breadboard.json --json                                   # 程序列表与仿真配置
pnpm bb program export design.breadboard.json program_main --out main.ts         # 源码原样写出
pnpm bb program import design.breadboard.json program_main --source main.ts --target mcu --activate --json
pnpm bb schema          # 设计 JSON Schema
pnpm bb ops             # apply 支持的操作
```

## 补丁格式

```json
{
  "expected_revision": 2,
  "ops": [
    { "op": "add_board", "board": { "id": "bb_b", "model": "breadboard_400@1", "attach_to": { "board_id": "bb_a", "side": "right", "grid_align": true } } },
    { "op": "add_component", "component": { "id": "sht41", "model": "sht41_breakout@1", "placement": { "kind": "board", "board_id": "bb_a", "anchor_hole": "j12", "anchor_pin": "VCC", "rotation_deg": 0 }, "config": { "i2c_address": 68 } } },
    { "op": "add_wire", "wire": { "from": { "pin": "mcu.D4" }, "to": { "pin": "sht41.SDA" }, "color": "blue", "route": "elevated" } },
    { "op": "add_net_intent", "net_intent": { "id": "n_sda", "name": "SDA", "endpoints": ["mcu.D4", "sht41.SDA"] } },
    { "op": "update_property", "id": "sht41", "path": "config.i2c_address", "value": 69 },
    { "op": "add_program", "program": { "id": "program_main", "name": "读取温湿度", "target_component_id": "mcu", "source": "import { Serial, sleep } from '@bbs/runtime';\nexport async function loop() { Serial.println('tick'); await sleep(1000); }\n" } },
    { "op": "set_simulation_config", "patch": { "active_program_id": "program_main", "speed": 1 } }
  ]
}
```

- 一个补丁原子执行：任一操作失败或结果存在阻断错误（坏引用、引脚脱格、同孔两针、板体碰撞、端点被占用）→ 全部不应用，文件不变。
- 电气问题（短路、地址冲突、供电不足）不阻断，写入后在结果里显著报告。
- `{ "pin": "mcu.D4" }` 语法糖：引脚已插入面包板时自动解析为同组最近的空闲孔，否则解析为端子；文件里保存的总是显式孔/端子。
- `expected_revision` / `expected_hash`（或命令行 `--expect-revision` / `--expect-hash`）用于防止覆盖并发修改。`schema_version` 参与内容哈希，因此对 `1.0` 文件记录的 hash 在迁移到 `1.1` 后不再匹配（退出码 3）：先 `bb inspect` 重新取一次 hash。
- `--force` 允许在阻断错误存在时仍写入（用于修复损坏文件）。

操作清单：`add_board`、`remove_board`、`move_board`、`rotate_board`、`add_component`、`remove_component`、`move_component`、`rotate_component`、`add_wire`、`remove_wire`、`update_wire`、`update_property`、`add_net_intent`、`remove_net_intent`、`update_net_intent`、`add_constraint`、`remove_constraint`、`set_metadata`、`replace_design`、`add_definition`、`remove_definition`、`auto_wire`、`add_program`、`update_program`、`remove_program`、`set_simulation_config`。字段见 `pnpm bb ops`。

`autowire` / `auto_wire` 按目录中的引脚角色连接一个主控或电源主板与多个外设：

- **选点**：每个外设引脚所在孔组的空闲孔 × 目标网络最近的若干可用孔/端子，全部用画布同一套避障路由器（元件实体 + 先前硬质跳线都是障碍）试算，取实际路径最短的一对；因此串接的 I²C 会自动走空闲的一排而不是绕路。
- **电源/GND**：默认走电源轨。到某段电源轨的代价按“配电跳数”最短路计算（主板最近引脚组 → 最近同极性轨为馈线，轨 → 轨跨断点或跨板为桥线），再加该外设到轨的抽头长度，取总和最小者；被其他网络占用的轨段不会被复用。`--power direct` 只在孔组之间串接。
- **线材与走廊**：`--route auto`（默认）先用实际避障路径比较硬质跳线与杜邦线；硬质路径超过 120 mm 保护上限，或绕路超过 `1.3 × 直线 + 8 mm`，才强制杜邦。目标函数还会计入拐弯 2 mm、杜邦飞线 16 mm、每根线 1.5 mm，以及杜邦直线飞越元件的 4 mm/个罚分。既有硬质线是车道障碍：垂直穿越允许，共线重叠禁止；相邻且不重叠的面包板之间允许共面硬质桥线，堆叠板和线缆端子仍用杜邦。`--route flat` 全部硬质跳线（不共用线段、绕开元件，不会被改成杜邦线）；`--route elevated` 全部两点直连杜邦线。
- **信号**：`signal_out/in`、`gpio`、`analog` 引脚分配主板空闲 GPIO（先普通引脚，目录标 `auto_wire: avoid` 的 strapping/USB/UART 引脚最后才用并给出 `needs_review`）；`--signal comp.pin=hostPin` 指定；`auto_wire: to_ground/to_power/skip` 提示分别把配置脚接地/接电源/跳过。另一块主控作为外设时只共地。
- **全局优化**（`--optimize global`，默认）：先做逐引脚贪心得到基线，再按同一目标函数（Σ 实际走线长度 + 上述拐弯/杜邦/飞越/每线罚分）整体搜索：每个信号/I²C 网络在“主板抽头 + 各成员引脚”上穷举全部生成树（≤ 7 个节点，Prüfer 序列，孔位容量约束），更大的网络退化为最小生成树；电源/GND 网络把电源轨段当作设施，枚举所有轨段子集（激活代价 = 馈线/桥线最小生成树，加各成员最近抽头），多个电源网络联合选段保证不共用轨段；然后按“先电源后信号、短线优先”顺序真实走线，对绕路的硬跳线做拆线重排与孔位重选，直到收敛或超过 `--time-budget`（默认 1500 ms）。`place_suggestions`/`--suggest-placement`/MCP 同名参数是显式 opt-in：对最长信号杜邦飞线最多尝试 6 个元件位置，完整重跑规划，只返回实际改善的建议，不修改设计。`plan.optimization` 报告采用的策略、两种目标值、是否穷举（`exhaustive`）、耗时与每个网络的搜索规模；超过穷举上限或超时的部分会明确标为启发式。这是给定目标函数下的最优搜索，不是“物理上唯一正确”的布线。
- **I²C 地址冲突**（`--i2c-conflicts`，默认 `bus_first`）：接线前先按有效地址（`config.i2c_address` 或目录默认）给每个 I²C 器件分配总线，同地址器件不会落在同一条总线上。主板有空闲控制器（`electrical.i2c.controllers`）且可映射 GPIO 时启用第 2 条总线（写入主板 `config.i2c_buses`，网络名 `SDA1`/`SCL1`），否则改用器件 `address_options` 里空闲的地址（写入 `config.i2c_address`）；`address_first` 顺序相反，`report` 只把冲突器件列为未连接。每次自动改动都会给出 `needs_review`（`auto_wire_i2c_bus_added` / `auto_wire_i2c_address_changed`），因为固件的 `Wire1.begin(sda, scl)`、地址常量和模块跳线要跟着改；两条总线都占满且地址不可改时报告 `i2c_address_conflict` 并建议多路复用器。
- **报告**：`plan.connections`（每根线的网络、主板引脚、两端、线材、经轨/经孔组、估算长度）、`plan.bridges`（馈线/桥线）、`plan.i2c_buses`、`plan.config_changes`、`plan.skipped`、`plan.unresolved`（含原因与建议）、`plan.optimization`。`--require-all` 时任何未连接引脚都让整个操作失败、不写文件。所有结果都按引脚角色生成，不是电气仿真；`needs_review` 项仍需人工核对。

## 程序与仿真

schema 1.1 起，设计文件可以带 `programs[]`（主控实例的 Studio TS 源码）和 `simulation`（启动程序、倍速、随机种子、USB 供电主板），格式见 [设计文件格式](DESIGN_FORMAT.md)。源码是设计内容：修改走 `add_program` / `update_program` / `remove_program` / `set_simulation_config`，每次都是一次事务（`revision` +1、参与 hash、可撤销），目标元件必须存在，删除主控需要 `cascade` 才会连程序一起删。`bb programs` 列出程序与配置（`inspect` 也包含 `programs`/`simulation`），`bb program export` 把源码原样写出，`bb program import` 从源码文件新建（需要 `--target`）或更新程序，`--activate` 同时设为启动程序；它与 `apply` 一样支持 `--dry-run`、`--out`、`--expect-revision`/`--expect-hash`（冲突退出码 3），失败时不写文件。**阶段 0 只保存与校验，不执行**：没有任何命令会运行代码，`program_target_unsupported` 等警告只说明目标型号还没有仿真驱动。

## 结果格式

每条规则结果：

```json
{ "severity": "error", "code": "power_ground_short", "category": "net", "blocking": false, "message": "…", "objects": ["mcu"], "endpoints": ["mcu.3V3_1", "mcu.GND_1"], "suggestion": "…" }
```

`severity` ∈ `error | warning | needs_review | info`；`category` ∈ `schema | placement | board | wire | net | interface | evidence`。`needs_review` 表示证据不足（模型未实测、供电能力未知、地址未知、电平未知），**没有 error 不等于可以安全上电**。

## 推荐工作流

1. `catalog list` 选择型号，`catalog inspect` 查看引脚名、参数与状态。
2. `new` 创建文件；用 `apply` 逐步添加板、元件、导线与网络意图（用 `--dry-run` 先看结果）。
3. `validate` 直到没有 error；逐条处理 `needs_review`：在 `config` 中填写实测/资料数据后重新校验。
4. `connectivity` 检查关键网络；`export --format svg` 出图；`steps` 生成接线步骤。
5. 交给人在浏览器里打开同一文件继续编辑（“项目 → 导入”），双方共用同一套规则与事务引擎。

浏览器编辑器同样暴露 `window.__bbs.apply(ops)` 供自动化测试使用。
