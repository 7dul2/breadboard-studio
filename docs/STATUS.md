# 进度与验证状态

最后更新：2026-09-05。环境：macOS 26.6 (arm64)、Node 26.0.0、pnpm 11.25.0、Chromium 153（Playwright 1.63）。

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

## 测试结果（本机）

| 套件 | 结果 |
| --- | --- |
| `pnpm typecheck` | 6 个包全部通过 |
| `pnpm test`（Vitest） | 55 通过：目录 3、哈希 2、面包板导通 6、导线 5、放置 9、规则 11、事务/往返 9、内嵌定义 2、CLI 8 |
| `pnpm test:e2e`（Playwright） | 8 通过：放板→放元件→接线→出错→修复→撤销/重做→导出 SVG/JSON→新建→导入→刷新恢复；非法导入拒绝；DSL 非法/合法；旋转四次与拖动；搭建模式；Agent 批量修改与 UI 一致；自定义定义导入；PNG 导出为真实 PNG |
| `pnpm build` + `pnpm check:dist` | 在 `/breadboard-studio/` 子路径下加载示例、24 根线、5 个网络、0 控制台错误 |

计划第 10 节的十类关键测试与用例对应：1 `board-connectivity`；2 `two boards`；3 `wires`；4 `placement`（旋转/脱格/同孔）；5 `rules`（短路、未知→needs_review）；6 `I2C rules`；7 `file round trip`；8 `transactions`+`cli`（原子、冲突、撤销、UI/CLI 一致）；9 `e2e`；10 `cli export`（viewBox 内无裁切、徽标与标签存在）。

## 性能（`pnpm perf` / `pnpm perf:browser`）

4 块 400 孔板、20 个模块、100 根线、1600 孔、约 3000 个场景节点：

| 指标 | 数值 |
| --- | --- |
| 核心分析（模型 + 导通 + 规则），Node 26 | ≈ 3.6 ms |
| 场景构建 / SVG 导出 | 0.6 ms / 5.5 ms |
| 单次 `move_component` 事务 | ≈ 3.6 ms |
| 浏览器内分析（HeadlessChrome 153） | ≈ 8.7 ms |
| 拖动 2 s（120 次指针移动）帧时间 | 平均 16.6 ms，p95 16.8 ms，最大 19.3 ms（≈ 60 fps） |

没有为指标提前重构；SVG 在目标规模下未见卡顿。

## 已知限制

- 内置定义几何均为 `approximate` 或 `unknown`，未经实测；DevKit 排距、转接板针序、SEN66 峰值电流、电源模块能力都需要用户填写。
- 供电只做资料数值比较；不检查 I²C 上拉、GPIO 复用、总线电容；不做三维碰撞分析。
- 830 孔板轨道断点按 MB-102 常见做法建模，实物可能连续。
- 自动走线只是正交 Z 形/绕行，密集布线需要手动拐点。
- 只支持 2.54 mm 栅格与 90° 倍数旋转。
- 数据仅存于浏览器 localStorage；无云端同步。

## 下一步

实测校验并把核实过的定义改为 `verified`；终端条无轨面包板型号；I²C 上拉与 GPIO 复用规则；导线避让走线；可选 MCP 封装。

## 发布记录

- 仓库：https://github.com/7dul2/breadboard-studio （公开，MIT）
- 演示：https://7dul2.github.io/breadboard-studio/ ，由 `Deploy GitHub Pages` 工作流自动部署；`scripts/check-live.mjs` 对线上站点做过冒烟检查（载入示例、通过引擎制造并检出电源对地短路、撤销、导出 SVG，0 控制台错误）。
- 首次推送后 CI 因 `pnpm/action-setup` 与 `packageManager` 重复指定版本失败，已在 `eb6e758` 修复。
- 版本标签与 Release 见仓库 Releases 页面（v0.1.0）。
