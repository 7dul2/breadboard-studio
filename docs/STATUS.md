# 进度与验证状态

最后更新：2026-09-07。环境：macOS 26.6 (arm64)、Node 26.0.0、pnpm 11.25.0、Chromium 153（Playwright 1.63）。

## 里程碑

| 阶段 | 状态 | 验证 |
| --- | --- | --- |
| M0 独立项目与最小运行环境 | 完成 | `pnpm install && pnpm dev` 启动空工作台；README 命令与脚本一致；`docs/ARCHITECTURE.md` 定义孔名/单位/原点/旋转/轨道。 |
| M1 Agent 可生成有效设计 | 完成 | Schema、目录、孔位生成、放置变换、导通图、事务、CLI；两个示例 + 9 个反例由 `scripts/build-examples.ts` 通过同一事务引擎生成；CLI 测试验证失败不落盘。 |
| M2 面包板画布 | 完成 | 渲染、缩放平移、落孔吸附、放置/旋转/复制/删除、多选、锁定、孔占用/遮挡区分；两板拼接（栅格对齐）；四次旋转回到原映射（单元 + e2e）。 |
| M3 手工连线与校验闭环 | 完成 | 接线、拐点编辑、颜色/线号、导通图、规则面板点击定位、网络高亮；e2e 制造电源对地短路 → 修复 → 警告消失；撤销/重做。 |
| M4 保存、导出、DSL、搭建模式 | 完成 | localStorage 自动保存 + 上一项目恢复 + 保存失败提示；JSON 导入/导出往返哈希一致；SVG/PNG 导出含图例与徽标、无裁切（CLI 测试检查 viewBox）；DSL 面板非法草稿不污染画布；搭建模式勾选状态刷新后保留。 |
| M5 示例、性能、体验 | 完成 | 两个可编辑示例 + 压力样本；元件 JSON 导入（内嵌到设计）；性能数据见下。 |
| M6 开源准备与发布 | 进行中 | README/CONTRIBUTING/SECURITY/LICENSE/THIRD_PARTY_NOTICES/issue 模板/CI/Pages 工作流已写；发布结果见文末。 |
| M7 多选自动排线 | 完成 | UI 多选主板 + 外设；电源/GND/I²C/GPIO 角色规划；杜邦线允许重叠/跨越；硬质跳线正交且不共用线段；CLI `autowire`；整批事务撤销；单元 + e2e。 |
| M8 外观编辑器 | 完成 | 属性面板“编辑外观绘图…”：`render` 图元自动分部件（重叠合并、大面积独立、`g` 标签持久化），点选/框选、拖动、方向键微调、复制、删除、旋转、坐标输入、撤销重做；实物照片底图（缩放/旋转/透明度/拖动对位）；保存即 `add_definition` 内嵌到项目（可撤销），或导出定义 JSON 写回元件库。N16R8 板按用户照片二次校准（状态灯间距、稳压器朝向、Type-C 位置，补 16 颗小电容电阻）。 |
| M7.3 自动排线 I²C 地址冲突处理 | 完成 | 目录新增 `electrical.i2c.controllers/mappable`、主控 `config.i2c_buses`；规则引擎按每条总线检查地址；规划器接线前分配总线，冲突时开第 2 条总线（自动选最近空闲 GPIO）或改用 `address_options` 中的地址，均列为待审核；三块同地址 SSD1315 场景从 1 个 error 变为 0 error + 2 待审核。 |
| M7.2 自动排线全局优化 | 完成 | 目标函数明确（走线长度 + 拐弯 2 mm + 杜邦线 6 mm + 每线 3 mm）；信号/I²C 网络 ≤ 7 节点穷举生成树（Prüfer + 孔位容量），电源/GND 枚举电源轨段子集并跨网络联合选段，走线顺序拆线重排 + 孔位重选；只在不劣于贪心时采用并报告 `plan.optimization`。环境节点示例目标值 845.7 → 818.8 mm（−3.2%，穷举），压力样本 1722.7 → 1682.2 mm（−2.4%，启发式），桌面示例贪心已最优；耗时 15–400 ms。 |
| M7.1 自动排线选点与配电改进 | 完成 | 端点对用画布同一避障路由器试算取最短实际路径（串接 I²C 自动走空闲排）；电源/GND 按“馈线 + 跨段/跨板桥线”最短路配电，馈线从最近的等效主板引脚组出发（830 板馈线 < 15 mm，此前跨整板 109 mm）；`auto` 线材按长度/绕路选择硬质跳线或杜邦线；其他主控只共地；`signal_pins` 提前校验。桌面示例：11 根线（8 硬质 + 3 杜邦），0 error；4 板/20 模块压力样本规划 < 0.6 s。 |
| S0 仿真阶段 0：schema 1.1 与最小外壳 | 完成 | schema 1.1（`programs`/`simulation`）与 `1.0 → 1.1` 无损迁移（单元测试：迁移后哈希不变、旧示例照常载入）；`add_program`/`update_program`/`remove_program`/`set_simulation_config` 事务与删除级联；`program_target_*`/`simulation_program_missing` 规则；`packages/sim` 状态机与控制器（无后端时 `run` → `faulted` + `runtime_unavailable`）；目录 `simulation` 绑定通过 schema 校验；CLI `programs`/`program import`/`program export`（新建 + 激活 → validate 0 error、导出字节一致、更新 revision +1、错误目标退出 1、缺 `--target` 退出 2、revision 冲突退出 3、1.0 文件导入后写出 1.1 且哈希与 1.1 导入一致）；Web“仿真”标签保存代码可撤销、随项目导入导出。**不执行代码。** |

## 测试结果（本机）

| 套件 | 结果 |
| --- | --- |
| `pnpm typecheck` | 7 个包全部通过（新增 `packages/sim`） |
| `pnpm test`（Vitest） | 122 通过：自动排线 16（含 I²C 冲突三例）、CLI 13（含 autowire dry-run/写入/require-all/optimize 与 program import/export）、放置 12、程序与仿真配置 12（事务、级联、规则、迁移往返）、规则 11、事务/往返 11、仿真控制器 10（状态机 4 + 会话/快照/诊断）、面包板导通 7、导线/避障 6、schema 迁移 5、目录 4（含仿真绑定一致性）、内嵌定义 4、触摸显示示例 3、外观分组/变换 2、哈希 2 |
| `pnpm test:e2e`（Playwright） | 21 通过：外观编辑器（选中部件、微调、复制、删除、保存内嵌、撤销）、关键流程、拼板、库与详细开发板、自动排线（默认自动线材：硬质 + 杜邦混合、馈线/桥线、意图闭合、整批撤销；再强制全杜邦线）、仿真外壳 5（程序列表与保存/撤销、无后端时如实报 `runtime_unavailable`、拓扑改动使快照过期、导出导入与 1.0 迁移后不自动运行、无程序时 `program_missing`、倍速不打断会话且草稿不跨项目） |
| `pnpm build` + `pnpm check:dist` | 在 `/breadboard-studio/` 子路径下加载示例、24 根线、5 个网络、0 控制台错误 |
| 浏览器实测（1400×800 / 1200×560） | 代码抽屉拖到极限时画布仍保留 ≥120 px、中间栏不溢出；运行→故障后改倍速仍是“故障”且写入文件，不产生过期诊断 |

计划第 10 节的十类关键测试与用例对应：1 `board-connectivity`；2 `two boards`；3 `wires`；4 `placement`（旋转/脱格/同孔）；5 `rules`（短路、未知→needs_review）；6 `I2C rules`；7 `file round trip`；8 `transactions`+`cli`（原子、冲突、撤销、UI/CLI 一致）；9 `e2e`；10 `cli export`（viewBox 内无裁切、徽标与标签存在）。

## 性能（`pnpm perf` / `pnpm perf:browser`）

4 块 400 孔板、20 个模块、100 根线、1600 孔、约 3000 个场景节点：

| 指标 | 数值 |
| --- | --- |
| 核心分析（模型 + 导通 + 规则），Node 26 | ≈ 9.6 ms |
| 场景构建 / SVG 导出 | 0.6 ms / 6.6 ms |
| 单次 `move_component` 事务 | ≈ 20.4 ms |
| 浏览器内分析（HeadlessChrome 153） | ≈ 8.7 ms |
| 拖动 2 s（120 次指针移动）帧时间 | 平均 16.6 ms，p95 16.8 ms，最大 19.3 ms（≈ 60 fps） |

没有为指标提前重构；SVG 在目标规模下未见卡顿。

## 已知限制

- 内置定义几何均为 `approximate` 或 `unknown`，未经实测；DevKit 排距、转接板针序、SEN66 峰值电流、电源模块能力都需要用户填写。
- 供电只做资料数值比较；不检查 I²C 上拉、GPIO 复用、总线电容；不做三维碰撞分析。
- 830 孔板轨道断点按 MB-102 常见做法建模，实物可能连续。
- 自动排线依赖目录的引脚角色，不会猜测无源/未知引脚；“全局优化”是在给定目标函数下的搜索：网络超过 7 个节点或电源轨超过 10 段时改用启发式，走线顺序是局部搜索，报告中的 `exhaustive` 会如实标注；密集线束仍可能需要手动整理拐点。
- 只支持 2.54 mm 栅格与 90° 倍数旋转。
- 数据仅存于浏览器 localStorage；无云端同步。
- 程序只能保存不能执行：仿真阶段 0 没有代码运行时、Worker 或器件驱动，“运行”只会报告运行时不可用；目录里的 `simulation` 绑定目前只用于校验。

## 下一步

第三期「可执行仿真」（规格书阶段 1–3）已排出实施计划，见 [`SIMULATOR_RUNTIME_PLAN.md`](SIMULATOR_RUNTIME_PLAN.md)：沙箱、编译、懒加载、渲染与子路径部署六项已在 Node 与真实 Chromium Worker 里跑通原型，分 M0.5 + 三个里程碑推进。其它方向：实测校验并把核实过的定义改为 `verified`；终端条无轨面包板型号；I²C 上拉与 GPIO 复用规则；密集线束整理；可选 MCP 封装。

## 发布记录

- 仓库：https://github.com/7dul2/breadboard-studio （公开，MIT）
- 演示：https://7dul2.github.io/breadboard-studio/ ，由 `Deploy GitHub Pages` 工作流自动部署；`scripts/check-live.mjs` 对线上站点做过冒烟检查（载入示例、通过引擎制造并检出电源对地短路、撤销、导出 SVG，0 控制台错误）。
- 首次推送后 CI 因 `pnpm/action-setup` 与 `packageManager` 重复指定版本失败，已在 `eb6e758` 修复。
- 版本标签与 Release 见仓库 Releases 页面（v0.1.0）。
