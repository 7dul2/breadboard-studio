# Agent 使用指南（不依赖浏览器）

CLI 入口：`pnpm bb <命令>`（等价于 `node packages/cli/bin/bb.mjs`）。所有命令支持 `--json` 输出稳定 JSON；错误时退出码非零。

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

操作清单：`add_board`、`remove_board`、`move_board`、`rotate_board`、`add_component`、`remove_component`、`move_component`、`rotate_component`、`add_wire`、`remove_wire`、`update_wire`、`update_property`、`add_net_intent`、`remove_net_intent`、`update_net_intent`、`add_constraint`、`remove_constraint`、`set_metadata`、`replace_design`、`add_definition`、`remove_definition`。字段见 `pnpm bb ops`。

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
