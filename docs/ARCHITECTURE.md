# 架构与建模约定

本文档是实现的权威约定；代码与文档不一致时以本文档为准并修正代码。

## 1. 工作区

pnpm workspace：

| 目录 | 内容 | 依赖限制 |
| --- | --- | --- |
| `packages/schema` | 设计文件类型、JSON Schema 2020-12、迁移 | 仅 ajv |
| `packages/catalog` | 面包板/元件定义（JSON）与目录加载 | schema |
| `packages/core` | 几何、孔阵、放置、导通图、规则、事务 | 不依赖 DOM/React |
| `packages/render` | 共享场景（primitive 列表）与 SVG 导出 | core |
| `packages/cli` | `bb` 命令行 | core/render |
| `apps/web` | 浏览器编辑器（React + Vite，SVG 画布） | 全部 |

所有入口（画布动作、属性面板、DSL 面板、CLI `apply`）都调用 `core.applyOps`：

```text
动作 → applyOps（克隆 → 逐个 op → schema 校验 → 模型/规则）→ 新设计 + 结果
```

失败时原设计对象不变。编辑器把每次成功事务的前一个版本压入撤销栈。

## 2. 单位与坐标

- 持久坐标全部为整数微米（µm）。孔距 2.54 mm = `2540`。显示层按 mm 展示（`render` 包把 µm 换成 mm）。
- 屏幕坐标系：+x 向右，+y 向下（与 SVG 一致）。
- 旋转只允许 0/90/180/270，**顺时针为正**（屏幕上看）。局部向量 `(x, y)` 旋转 90° 后为 `(-y, x)`。
- 面包板局部原点 = 板体左上角。元件局部原点 = 外形左上角（`origin: "top_left"`）。
- 全局坐标 = `position_um + R(rotation) · local`。

## 3. 面包板孔位命名

- 接线区孔：`<行字母><列号>`，如 `a1`、`j30`。行字母 a–e 在上半区、f–j 在下半区；同一列的五个孔（a–e 或 f–j）内部导通；中央沟槽隔离两半。
- 电源轨孔：`<轨道 id>_<序号>`，轨道 id 为 `top_outer`、`top_inner`、`bottom_inner`、`bottom_outer`（相对未旋转的板），序号从 1 开始。轨道的导通分段（`segments`）来自型号定义，例如 830 孔板每条轨在 25/26 之间断开。印刷的红/蓝线和 +/− 只是 `marking` 显示数据，不是电气证据。
- 孔地址：`<board_id>.<孔名>`，如 `bb_a.a7`、`bb_b.top_inner_12`。
- 端子地址：`<component_id>.<引脚名>`，如 `sen66.SDA`。ID 在整个设计内全局唯一，所以地址无歧义。

## 4. 元件放置

- 板上放置：`{kind: "board", board_id, anchor_hole, anchor_pin, rotation_deg}`。元件绕 **锚点引脚** 旋转，锚点引脚始终落在 `anchor_hole`；其余引脚的落孔由几何派生（跨板搜索），不能自报。任何 `header` 引脚没有落在 ±0.3 mm 内的孔上即为 `pin_not_on_hole`（阻断）。
- 板外放置：`{kind: "off_board", position_um, rotation_deg}`。板外元件的引脚是端子，只能用导线连接。
- 孔状态：`free` / `occupied`（被引脚占用）/ `blocked`（被板体遮挡，且距板面 ≤ 6 mm）。导线端点不能落在 occupied/blocked 孔；底部引脚通过同组外露孔引出。
- 立式模块（`mount_orientation: "upright"`，单排针转接板默认）只占用针排所在的窄条；平躺（`flat`）时整块板体遮挡孔位。
- 碰撞：板体投影重叠且高度区间 `[standoff, standoff+height]` 重叠即 `body_collision`（阻断）。
- 同一元件两个引脚落入同一导通组（同列五孔或同一轨段）且未在 `internal_nets` 声明为内部相连 → `pins_shorted_by_board`（错误，不阻断）。

## 5. 导线

- 端点：`{hole: "bb_a.a7"}` 或 `{terminal: "sen66.SDA"}`。`apply` 额外接受 `{pin: "mcu.D4"}` 语法糖：引脚已插入时解析为同组最近的空闲孔，否则解析为端子；写入文件时总是显式孔/端子。
- 只有 `to` 缺失的线是悬空草稿，会报 `wire_dangling`，不导通。
- `path_mode: "auto"` 时拐点由引擎生成（正交 Z 形；线缆端子先向外引出并绕开自身模块）并写回文件；`"manual"` 时保留用户拐点，端点跟随对象移动。
- `route: "flat"` 表示贴板硬跳线，穿过元件板体时警告；`"elevated"` 表示抬高软线，只给提示。不做三维碰撞分析。
- 两条线在图上交叉不导通；一个孔只能插一根线（`wire_hole_conflict`）。
- 长度 = 折线长度，不含插入深度、弯折与连接器余量。

## 6. 导通图与网络

- 节点：所有孔地址 + 所有引脚地址。边：板内组、引脚插入孔、`internal_nets`、导通的导线。用并查集求网络。
- `boardOnly` 图只包含板内组与引脚插孔，用于检查“被面包板短接”。
- 网络命名：完整落在一个网络内的 `net_intents` 名称优先；否则按引脚角色（GND / 3V3 / SDA / SCL）；再否则用第一个引脚地址。
- `net_intents` 只是期望，不产生导线；未连通报 `net_intent_open`，两个意图被连成一个网络报 `net_intent_merged`。

## 7. 规则严重度

| severity | 含义 |
| --- | --- |
| `error` + `blocking` | 结构/物理不可能（坏引用、孔不存在、引脚脱格、同孔两针、板体碰撞、导线端点被占用）。`apply` 拒绝提交，除非 `--force`。 |
| `error` | 电气问题（电源对地短路、不同电压并联、I²C 地址冲突、推挽输出并联、供电不足）。留在草稿中，显著报告。 |
| `warning` | 需要注意（网络未连通、缺公共地、电平不一致、硬跳线穿越板体、峰值超限）。 |
| `needs_review` | 证据不足（模型未实测、供电能力/峰值未知、地址未知、电平未知、供电范围未知）。**没有 error 不等于可以安全上电。** |
| `info` | 说明性信息。 |

规则不依赖导线颜色；内部电路不做无条件合并（电阻、LED、芯片引脚之间没有隐含导通）。

## 8. 版本、修订与哈希

- `schema_version` 当前为 `"1.0"`；未列入支持列表的版本一律拒绝。
- `metadata.revision` 每次成功事务 +1；`hash` = 排除 `revision`/`updated_at`/`view` 后的规范 JSON 的 SHA-256。`apply` 可用 `expected_revision`/`expected_hash` 防止覆盖并发修改（冲突退出码 3）。
- `catalog_versions` 记录保存时的目录版本；`embedded_catalog` 可把用到的定义固定在文件内。

## 9. 目录定义状态

`geometry_status` 与 `electrical_status` 分别取 `verified` / `approximate` / `unknown`。`verified` 只表示与注明资料或实测吻合，不表示硬件认证。v0.1 内置定义没有任何一项是 `verified` 几何。
