# Agent 使用指南（不依赖浏览器）

CLI 入口：`pnpm bb <命令>`（等价于 `node packages/cli/bin/bb.mjs`）。所有命令支持 `--json` 输出稳定 JSON；错误时退出码非零。**由程序解析 JSON 时请直接调用 `node packages/cli/bin/bb.mjs …`**：`pnpm` 在子命令非零退出时会往 stdout 追加一行 `[ELIFECYCLE] Command failed…`，会破坏 JSON。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（`validate` 时表示没有 error） |
| 1 | 设计存在 error / 文件无效 / 补丁被拒绝 |
| 2 | 用法或 IO 错误 |
| 3 | revision / hash 冲突（并发修改保护） |

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
    { "op": "update_property", "id": "sht41", "path": "config.i2c_address", "value": 69 }
  ]
}
```

- 一个补丁原子执行：任一操作失败或结果存在阻断错误（坏引用、引脚脱格、同孔两针、板体碰撞、端点被占用）→ 全部不应用，文件不变。
- 电气问题（短路、地址冲突、供电不足）不阻断，写入后在结果里显著报告。
- `{ "pin": "mcu.D4" }` 语法糖：引脚已插入面包板时自动解析为同组最近的空闲孔，否则解析为端子；文件里保存的总是显式孔/端子。
- `expected_revision` / `expected_hash`（或命令行 `--expect-revision` / `--expect-hash`）用于防止覆盖并发修改。
- `--force` 允许在阻断错误存在时仍写入（用于修复损坏文件）。

操作清单：`add_board`、`remove_board`、`move_board`、`rotate_board`、`add_component`、`remove_component`、`move_component`、`rotate_component`、`add_wire`、`remove_wire`、`update_wire`、`update_property`、`add_net_intent`、`remove_net_intent`、`update_net_intent`、`add_constraint`、`remove_constraint`、`set_metadata`、`replace_design`、`add_definition`、`remove_definition`、`auto_wire`。字段见 `pnpm bb ops`。

`autowire` / `auto_wire` 按目录中的引脚角色连接一个主控或电源主板与多个外设：

- **选点**：每个外设引脚所在孔组的空闲孔 × 目标网络最近的若干可用孔/端子，全部用画布同一套避障路由器（元件实体 + 先前硬质跳线都是障碍）试算，取实际路径最短的一对；因此串接的 I²C 会自动走空闲的一排而不是绕路。
- **电源/GND**：默认走电源轨。到某段电源轨的代价按“配电跳数”最短路计算（主板最近引脚组 → 最近同极性轨为馈线，轨 → 轨跨断点或跨板为桥线），再加该外设到轨的抽头长度，取总和最小者；被其他网络占用的轨段不会被复用。`--power direct` 只在孔组之间串接。
- **线材**：`--route auto`（默认）短的同板走线用硬质跳线，线缆端子、跨板、超过 50 mm 或明显绕路（> 1.3 × 直线 + 8 mm）的走线用杜邦线；`--route flat` 全部硬质跳线（不共用线段、绕开元件，不会被改成杜邦线）；`--route elevated` 全部两点直连杜邦线。
- **信号**：`signal_out/in`、`gpio`、`analog` 引脚分配主板空闲 GPIO（先普通引脚，目录标 `auto_wire: avoid` 的 strapping/USB/UART 引脚最后才用并给出 `needs_review`）；`--signal comp.pin=hostPin` 指定；`auto_wire: to_ground/to_power/skip` 提示分别把配置脚接地/接电源/跳过。另一块主控作为外设时只共地。
- **全局优化**（`--optimize global`，默认）：先做逐引脚贪心得到基线，再按同一目标函数（Σ 实际走线长度 + 每个拐弯 2 mm + 每根杜邦线 6 mm + 每根线 3 mm）整体搜索：每个信号/I²C 网络在“主板抽头 + 各成员引脚”上穷举全部生成树（≤ 7 个节点，Prüfer 序列，孔位容量约束），更大的网络退化为最小生成树；电源/GND 网络把电源轨段当作设施，枚举所有轨段子集（激活代价 = 馈线/桥线最小生成树，加各成员最近抽头），多个电源网络联合选段保证不共用轨段；然后按“先电源后信号、短线优先”顺序真实走线，对绕路的硬跳线做拆线重排与孔位重选，直到收敛或超过 `--time-budget`（默认 1500 ms）。只有目标值不高于贪心时才采用全局方案，因此**结果永远不劣于贪心**。`plan.optimization` 报告采用的策略、两种目标值、是否穷举（`exhaustive`）、耗时与每个网络的搜索规模；超过穷举上限或超时的部分会明确标为启发式。这是给定目标函数下的最优搜索，不是“物理上唯一正确”的布线。
- **I²C 地址冲突**（`--i2c-conflicts`，默认 `bus_first`）：接线前先按有效地址（`config.i2c_address` 或目录默认）给每个 I²C 器件分配总线，同地址器件不会落在同一条总线上。主板有空闲控制器（`electrical.i2c.controllers`）且可映射 GPIO 时启用第 2 条总线（写入主板 `config.i2c_buses`，网络名 `SDA1`/`SCL1`），否则改用器件 `address_options` 里空闲的地址（写入 `config.i2c_address`）；`address_first` 顺序相反，`report` 只把冲突器件列为未连接。每次自动改动都会给出 `needs_review`（`auto_wire_i2c_bus_added` / `auto_wire_i2c_address_changed`），因为固件的 `Wire1.begin(sda, scl)`、地址常量和模块跳线要跟着改；两条总线都占满且地址不可改时报告 `i2c_address_conflict` 并建议多路复用器。
- **报告**：`plan.connections`（每根线的网络、主板引脚、两端、线材、经轨/经孔组、估算长度）、`plan.bridges`（馈线/桥线）、`plan.i2c_buses`、`plan.config_changes`、`plan.skipped`、`plan.unresolved`（含原因与建议）、`plan.optimization`。`--require-all` 时任何未连接引脚都让整个操作失败、不写文件。所有结果都按引脚角色生成，不是电气仿真；`needs_review` 项仍需人工核对。

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
