# 贡献指南

感谢你的兴趣。请先阅读 `docs/ARCHITECTURE.md`（约定）与 `docs/CATALOG.md`（建模）。

## 开发环境

```bash
pnpm install
pnpm dev             # 编辑器
pnpm test            # 单元 + CLI 测试
pnpm test:e2e        # 浏览器流程（需 pnpm exec playwright install chromium）
pnpm typecheck
```

## 提交前

- `pnpm typecheck && pnpm test && pnpm build` 必须通过；改动了画布交互请同时跑 `pnpm test:e2e`。
- 改动示例生成逻辑后运行 `pnpm tsx scripts/build-examples.ts` 并提交生成的文件。
- 规则改动要附正反例测试（`packages/core/test`）。
- 不要提交任何账号、凭据、私人截图或第三方未授权的图片/SVG。

## 添加元件定义

1. 复制 `examples/custom_definition_example.json` 或 `pnpm bb catalog inspect <ref> --json` 的输出。
2. 如实填写 `geometry_status` / `electrical_status`（默认 `approximate` 或 `unknown`），在 `sources` 写明来源链接，在 `license` 写明绘图/数据许可。
3. 放到 `packages/catalog/src/definitions/`，在 `packages/catalog/src/index.ts` 注册，运行 `pnpm test`。
4. PR 描述里说明你核对过哪些尺寸/引脚（实测或资料），哪些没有。

## 提交信息

简短的祈使句主题 + 说明改了什么、为什么。涉及规则时写明新增/修改的 `code`。
