# audit-pocs

2026-09-17 安全审计期间用的一次性复现脚本，保留下来作为 [`AUDIT.md`](../../../AUDIT.md) 的证据。**不是测试，也不参与构建。**

这些文件在 `packages/sim/tsconfig.json` 的 `include`（只有 `src`、`test`）和 `vitest.config.ts` 的 `include`（只收 `*.test.ts`）之外，所以 `pnpm typecheck` / `pnpm test` 都不会碰它们。

## ⚠️ 注意：其中几个会挂死

它们是**破坏性**复现脚本，故意构造永不返回的执行路径。运行前自己加超时，否则只能强杀：

```bash
pnpm exec tsx packages/sim/audit-pocs/toplevel-hang.ts
```

| 脚本 | 验证什么 | 会终止吗 |
|---|---|---|
| `toplevel-hang.ts` | SEC-14（**已修复**）：worker 在 guest 模块顶层求值前没 arm deadline，顶层死循环曾永久锁死线程；脚本已更新为验证修复 | **会**（正常退出；若看门狗触发则说明回归） |
| `gate-and-error.ts` | SEC-5：各种引号/转义/模板字面量写法下，扫描器与模块白名单各自的结果表 | **不会**（实测首个模板字面量动态导入用例即卡住） |
| `dispose-hang.ts` | 沙箱 dispose 路径 | 未逐个确认 |
| `dyn-and-serial.ts` | 动态 import 与串口路径 | 未逐个确认 |
| `globals.ts` | 沙箱内全局对象的暴露面 | 未逐个确认 |

`toplevel-hang.ts` 的判据已随修复更新：脚本自己断言 `loadProgram()` 在 3 秒看门狗窗口内有界返回且 `ok=false`（被中断）后正常退出——定时器触发才说明回归了。其余脚本仍是破坏性复现，判据见各自说明。

这些脚本用 `tsx` 直接跑（源码导入用 `.js` 后缀，由 tsx 解析到 `.ts`），依赖 `quickjs-emscripten-core`、`@jitl/quickjs-wasmfile-release-sync`、`sucrase`，都是 `packages/sim` 已有的依赖。
