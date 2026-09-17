# Breadboard Studio — 安全与性能审计报告

**仓库**: `/Users/dul27/Desktop/Breadboard Studio`
**规模**: ~38k 行 TypeScript，monorepo（React Web 应用 + CLI/MCP 服务器 + QuickJS 电路模拟器 + SVG 渲染器 + JSON Schema 校验器）
**方法**: 逐子系统独立审计 + 破坏性复核验证 + 关键路径复现
**日期**: 2026-09-17
**归档状态**: 原报告结论已开成 issue #54–#77（[SEC / PERF / SUP](https://github.com/7dul2/breadboard-studio/issues?q=is%3Aissue+SEC-OR-PERF-OR-SUP)）；复核新增的 SEC-14 见 [#79](https://github.com/7dul2/breadboard-studio/issues/79)。

> **整理与复核说明。** 原稿由多个子代理并行产出后直接拼接，SEC-10/SEC-11 两节与「已验证安全」表格各重复了一次。本版已去重重排，并对高危结论做了源码级二次复核：
>
> - **3 条危害描述需要下调**：SEC-1、SEC-5、SEC-13；
> - **1 条的推理有误**：SEC-2 的「跨设备 rename」子项（物理上不可能发生）；
> - **新增 1 条已实测复现的缺陷**：SEC-14（沙箱顶层死循环挂死 worker），原稿只在「误报表」里留了一句附注，未定性 —— 已开成 [#79](https://github.com/7dul2/breadboard-studio/issues/79)。
>
> 上面 4 条更正也都以评论形式补到了对应 issue（[#54](https://github.com/7dul2/breadboard-studio/issues/54)、[#55](https://github.com/7dul2/breadboard-studio/issues/55)、[#58](https://github.com/7dul2/breadboard-studio/issues/58)、[#67](https://github.com/7dul2/breadboard-studio/issues/67)），issue 正文保持原始结论未改动。
>
> 复核只动本文档，**不改动已归档的 issue**：issue 仍是原始结论。处理这些问题时以本文档的「复核更正」为准，或先给对应 issue 补一条更正评论。

---

## 审计方法

将仓库拆为 9 个子系统并行扫描（CLI/MCP、模拟沙箱、模拟引擎、Web 安全、Web 性能、核心引擎、Schema 校验、SVG/渲染、供应链），每个子系统由独立 subagent 审计后，再对所有高严重性结论做破坏性复核（读码验证、边界测试、调用链追踪）。

---

## 🔴 安全漏洞

### SEC-1 [中·原定 CRITICAL] CLI/MCP 路径遍历 — 任意文件读写

**位置**: `packages/cli/src/queries.ts:29, 228-229`；`packages/cli/src/mcp.ts:62, 179`

`readDesign(file)` 直接 `resolve(file)` 后 `readFileSync(path, 'utf8')`，没有任何路径约束或符号链接检查。`applyPatchData`/`autowireData` 的 `out` 参数来自调用方，默认 `args.out ?? file`，经 `writeAtomic(target, ...)` 写入磁盘。MCP 层 `file = z.string()` 对路径零校验。`export_design` 也会把任意文件内容内联返回。

**修复**: 用 `fs.realpathSync` 解析符号链接，并校验规范路径前缀落在允许目录下；对 `out` 应用同样校验。

> **复核更正（定级 CRITICAL → MEDIUM）。** 「CLI 接受任意路径」不是越界：`bb apply <file>` 的设计契约就是由调用方指定文件，调用方本来就拥有该权限，`resolve()` 也不会带来它原本没有的能力。真正站得住的是 **MCP 那一侧**——`file` 来自受提示词影响的 agent，是受污染的输入源，等于把任意路径写入能力交给模型。结论：按 MCP 的混淆代理（confused deputy）问题处理，修复重点是把可写范围限制在设计/工作区目录，而不是给 CLI 加沙箱。

### SEC-2 [中] writeAtomic 竞态与不安全的临时文件

**位置**: `packages/cli/src/queries.ts:37-43`

```ts
const tmp = `${path}.tmp-${process.pid}-${Date.now()}`; // 可预测
writeFileSync(tmp, content);                            // 权限由 umask 决定
renameSync(tmp, path);
```

**影响**:
1. **可预测的临时名**: 同机攻击者猜到 PID + 时间点后，可在 `.tmp-` 路径预置符号链接，`writeFileSync` 会顺着它写。
2. **临时文件权限**: 目标文件原本是 0600 时，rename 之后权限变成新文件的（umask 022 下为 0644），写入窗口内设计文件对其他本地用户可读。
3. **失败时残留**: 没有 `finally` 清理，异常退出会留下 `.tmp-*` 文件。
4. `mkdirSync(recursive)` 会跟随路径中的符号链接目录组件。

**修复**: 用 `crypto.randomUUID()` 或 `mkstemp()` 生成不可预测临时名；`writeFileSync(tmp, content, { mode: 0o600 })`；`finally` 清理临时文件。

> **复核更正（删去一个子项）。** 原稿第 3 条「若 tmp 与 target 不同文件系统，`renameSync` 抛 EXDEV」**不成立**：`tmp` 的路径是 `${path}.tmp-…`，即 `dirname(path)`，与 target 同目录，rename 永远在同一文件系统内，EXDEV 不可能发生。原「修复」里对应的「EXDEV 降级为 copyFile+unlink」也就不需要。其余三条保留。

### SEC-3 [高] TOCTOU — readDesign 与 writeAtomic 之间文件被替换

**位置**: `packages/cli/src/queries.ts:215-229`

`applyPatchData` 在 line 215 读文件、line 219 `applyOps` 用内存中的 design 校验 `expected_revision`，line 229 `writeAtomic(target, ...)` 覆写磁盘。文件内容在两次之间可被替换。

**影响**: 若攻击者在 `readDesign` 与 `writeAtomic` 之间替换文件（同 revision），`writeAtomic` 会用基于过期设计的内容覆写合法文件。`expected_hash` 提供部分防护，但仅在调用方提供时生效。

**修复**: `writeAtomic` 前重新读取并再次校验 revision/hash；或使用文件锁 / compare-and-swap。

### SEC-4 [高] MCP `guarded()` 重抛非 CliError → 服务器崩溃 + 栈泄露

**位置**: `packages/cli/src/mcp.ts:53-60`

```ts
async function guarded(fn) {
  try { return json(fn()); }
  catch (e) {
    if (e instanceof CliError) return failure(e);
    throw e; // ← 非 CliError 变成未捕获异常
  }
}
```

**影响**: 任何非 CliError（malformed patch 导致的 TypeError、ReferenceError）会向上抛出。即使 MCP SDK 捕获，栈轨迹（含内部文件路径）会经协议泄露给客户端；若 SDK 不捕获则中断 stdio 服务器，AI 代理的工具通道断掉。

**修复**: catch 块中把非 CliError 转为 `failure` 结果（`-32603 / Internal error`），实际错误只写 stderr。

### SEC-5 [低·原定 HIGH] 沙箱 import 扫描被模板字面量绕过

**位置**: `packages/sim/src/runtime/compile.ts:44-46, 123-139`

```ts
const IMPORT_FROM = /(?:^|[^\w$.])(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])( *)\1/g;
//                ^^^ 只匹配 ' 和 "，不匹配反引号
```

`scanImportSpecifiers` 只接受单/双引号，`maskSource` 也不识别反引号定界符，所以模板字面量导入既不被扫描也不被报告。实测 `import fs from \`node:fs\``、`import \`node:fs\``、`import(\`node:fs\`)` 全部返回空。

**修复**: 用真正的词法分析器（处理模板字面量、正则字面量、unicode 转义）替代正则，或在 sucrase 剥离类型后解析 AST 提取 specifier。

> **复核更正（定级 HIGH → LOW，删去「可执行任意模块代码」）。** 扫描缺口为真，但「恶意程序可导入 `node:fs` 并执行任意模块代码」**不成立**。真正的闸门是 `packages/sim/src/runtime/studio-ts.ts:408` 的 `loadModule`：
>
> ```ts
> const source = Object.prototype.hasOwnProperty.call(this.modules, name) ? this.modules[name] : undefined;
> if (typeof source === 'string') return source;
> return { error: new Error(`模块不可用: ${name}`) };
> ```
>
> `this.modules` 是冻结的 `GUEST_MODULES` 白名单（`guest-modules.ts:314`），查表用 `hasOwnProperty`，**与引号写法无关**——任何非白名单 specifier 都会拿到 `模块不可用: <name>`。原稿自己也承认「QuickJS 的 setModuleLoader 是真正的闸门」，却仍把影响写成沙箱逃逸，并把它列为优先级第 3、称为「唯一能真正突破沙箱的路径」，这是自相矛盾的。实际影响只有一个：用户看到的是运行时「模块不可用」，而不是带行号的编译期报错——属于诊断质量缺口。

### SEC-6 [高] ArtworkEditor 用户上传图片数据 URI 未消毒 → SVG 脚本注入

**位置**: `apps/web/src/components/ArtworkEditor.tsx:487`

```tsx
<image href={photo.src} ... />
```

`photo.src` 来自 `FileReader.readAsDataURL(file)`，`file` 为任意用户上传文件，`href` 直接设为数据 URI。

**影响**: 上传一个 `data:image/svg+xml,…` 伪装的文件，数据 URI 中的 `<script>` 在渲染 `<image>` 时执行。

**修复**: 校验数据 URI 的 MIME 只允许 `image/png`、`image/jpeg`/`image/webp`；或经 canvas 重编码剥离 SVG payload。

### SEC-7 [高] `check-dist.mjs` HTTP 服务器路径遍历 + 绑定 0.0.0.0

**位置**: `scripts/check-dist.mjs:78-87`

```ts
let file = join(dist, path);   // ← join 不阻止 ../
res.end(readFileSync(file));
...
await new Promise((r) => server.listen(4174, r));  // 无 host → 0.0.0.0
```

**影响**: `GET /breadboard-studio/../../../etc/passwd` 可遍历到任意文件；`listen(4174)` 无 host 参数使该服务在**所有网络接口**可达，而不只是本机。

**修复**: `decodeURI` 后做 `realpathSync(file)` 前缀校验；`server.listen(4174, '127.0.0.1')`。

### SEC-8 [中] `bb.mjs` 全局安装 tsx ESM 加载器 → NODE_PATH 劫持

**位置**: `packages/cli/bin/bb.mjs:3-4`

```js
import { register } from 'tsx/esm/api';
register(); // 全局注册，影响整个进程生命周期，且不可逆
```

**影响**: tsx 的 `register()` 全局注册自定义 ESM 加载器并 respect `NODE_PATH`；控制 `NODE_PATH` 或工作目录者可劫持 `@breadboard-studio/core` 等导入加载恶意模块。前提是攻击者已能控制进程环境变量。

**修复**: 不用全局 `register()`，改用 `import { runCli } from '../src/main.ts'`（tsx 原生支持）或 `new URL()` 显式解析。

### SEC-9 [中] `params` / `config` / `embedded_catalog` Schema 开放

**位置**: `packages/schema/src/design.schema.ts:118-119, 205-207`

```ts
params: { type: 'object' },       // 无 additionalProperties
config: { type: 'object' },       // 无 additionalProperties
embedded_catalog: {
  boards: { type: 'array', items: { type: 'object' } },  // 无 additionalProperties
  components: { type: 'array', items: { type: 'object' } }
}
```

**影响**: 设计 schema 层对 `params`/`config` 完全开放，任意 key 可流入。`SECURITY.md` 声称 `additionalProperties: false`，但对这几个字段不成立。当前 `validateBoardDefinition`/`validateComponentDefinition` 会二次校验嵌入目录项，所以**目前不可利用**；但一旦该校验被重构或移除，开放 schema 将直接放行 `__proto__`/`constructor` 等键。属防御纵深。

**修复**: 对 `params`/`config` 加 `additionalProperties: false`；`embedded_catalog` items 改为引用实际 schema 定义。

### SEC-10 [中] 模拟 worker 消息无大小限制与 shape 校验

**位置**: `apps/web/src/simulator/runtime/sim.worker.ts:71-84`

worker `onmessage` 仅校验 `command.type` 是字符串，不校验 shape 或大小，`queued.push(command)` 直接推入无界队列。

**影响**: 畸形/巨型消息（如 gigabyte 级 snapshot）导致 worker 堆耗尽；`load-replay` 的 `[...command.entries].sort()` 在 `entries` 为 null 时抛 TypeError；`prepare` 的畸形 `snapshot` 流向 `buildKernel`。

**修复**: 对每种 `HostCommand` 做严格 shape 校验 + 消息大小上限。

### SEC-11 [高] `window.__bbs` 测试钩子在生产环境无 DEV 守卫

**位置**: `apps/web/src/testHooks.ts:83-142`；`apps/web/src/main.tsx:9`

```ts
// main.tsx
installTestHooks(); // line 9 — 无 import.meta.env.DEV 守卫，生产包中也执行
```

`installTestHooks()` 暴露 `apply(ops)`（对设计执行任意操作）、`importJson(text)`（整体替换设计）、`getDesign()`/`state()`（泄露完整设计与用户状态）、`simulatorControl(...)`（注入控制事件）。

**影响**: 页面上的任何脚本（第三方库、XSS 载荷）都能篡改设计或把完整电路数据外泄，且 `window.__bbs` 在全局长期驻留。

**修复**: 用 `if (import.meta.env.DEV)` 守卫，或在生产构建中整个排除该模块。

> **注意（复核时补充）**: `scripts/check-dist.mjs:111-124` 在**生产构建**上正是通过 `window.__bbs` 读取分析与仿真状态做冒烟校验的。因此「生产环境加守卫」会连带让该 CI 检查失效，修复时需要一个替代通道（例如只在 `check:dist` 的服务里注入、或用独立的构建期标记），否则会把一个安全修复变成一个监控盲区。

### SEC-12 [高] 文件导入无大小限制 → 内存耗尽

**位置**: `apps/web/src/components/Toolbar.tsx:297-301`；`apps/web/src/library/Library.tsx:46-57`；`apps/web/src/simulator/ui/RecordingPanel.tsx:62-75`

- `Toolbar.tsx` 的 `onImportFile`: `await f.text()` 后直接 `importJson(text)`，无大小检查；`<input accept=".json">` 的 accept 只是建议，可绕过。
- `Library.tsx` 的 `importDefinition`: 同理 `JSON.parse(await f.text())`，`raw` 作为 `unknown` 直接传进 `add_definition` op，未经 `ComponentDefinition` schema 预校验。
- `RecordingPanel.tsx` 的 `load`: `parseRecording` 不限条目数，`replay(...)` 把百万级事件喂给 worker。

**影响**: 加载几百 MB 的 JSON 会阻塞主线程、分配巨型对象直至 OOM；replay 可耗尽 worker 内存。

**修复**: 读取前检查 `f.size`（如 50 MB 上限）；`RecordingPanel` 限制条目数；`importDefinition` 先校验结构再 `applyOps`。

### SEC-13 [中] Vite dev-only `POST /__bbs/definition` 无认证/CSRF

**位置**: `apps/web/vite.config.ts:23-56`

`definitionWriteback` 插件在 `apply: 'serve'`（仅开发）下注册 `POST /__bbs/definition`，无认证、无 CSRF token。

**影响**: 开发环境下任意网页可向 `localhost:5173/__bbs/definition` 发 POST，覆盖 `packages/catalog/src/definitions/` 下的定义文件；这些定义在下次页面加载时被读入，形成持久化篡改。

**修复**: 加一次性 token / 校验 `Origin`；生产构建已由 `apply: 'serve'` 排除。

> **复核更正（缩小描述）。** 原稿说该端点「把解析的 JSON 写入目录源文件 / 可写任意 JSON」，与实现不符。`apps/web/devtools/definition-writeback.ts` 实际有三重约束：
>
> 1. `id` 必须匹配 `^[a-z0-9][a-z0-9_]*$`——不含路径分隔符，**无法遍历**；
> 2. `<id>.json` **必须已存在**，不能新建文件；
> 3. 请求的 `kind`/`id`/`version` 必须与磁盘上现有文件一致，否则 409。
>
> 所以攻击面只剩「改写已有定义的内容」这一条，且仅限开发服务器运行期间。维持 MEDIUM，但「任意文件写」的措辞应删去。

### SEC-14 [高] 沙箱 `loadProgram()` 未 arm deadline — 顶层死循环永久挂死 worker

**Issue**: [#79](https://github.com/7dul2/breadboard-studio/issues/79)（复核时新发现，原稿未归档）

**位置**: `packages/sim/src/worker/session.ts:442`；`packages/sim/src/runtime/studio-ts.ts:183, 226, 417`

```ts
// studio-ts.ts:183
private deadlineMs = Number.POSITIVE_INFINITY;

// studio-ts.ts:417  —— 中断检查
if (this.clock.nowMs() <= this.deadlineMs) return false;

// studio-ts.ts:226  —— 这里是 guest 代码（模块顶层求值）
loadProgram(): SandboxResult<void> {
  const result = this.ctx.evalCode(this.program.code, this.program.filename, { type: 'module' });

// session.ts:442  —— 调用前没有 armDeadline
const loaded = sandbox.loadProgram();
```

**影响**: `loadProgram()` 同步执行 guest 模块的顶层代码，而它之前**没有** `armDeadline`，此时 `deadlineMs` 仍是 `+Infinity`，`checkBudget()` 恒返回「不打断」。于是 guest 把死循环放在**函数外**（`let n = 0; while (true) { n = (n + 1) % 1000; }`）就会永久阻塞 worker 线程——中断永不触发，仿真再也停不下来。

对照 `session.ts:972` 的 `callEntry` 是**有** arm 的，注释还专门说明了原因：

> *The deadline is armed here because `callFunction` runs guest code synchronously: without it an infinite loop inside `loop()` would never be interrupted.*

顶层求值同样跑 guest 代码、同样是同步的，却漏掉了这一步。

**复现**（本仓库内，实测）:

```bash
pnpm exec tsx packages/sim/audit-pocs/toplevel-hang.ts
```

脚本打印两行后进入 `loadProgram()`；它预定 3 秒后触发的看门狗定时器**在 20 秒后仍未触发**，进程只能强杀——即主线程确实被锁死。`packages/sim` 现有的 623 个测试没有一个覆盖这条路径。

**修复**: 在 `session.ts:442` 调用 `loadProgram()` 之前 `armDeadline(clock.nowMs() + sliceMs)`，与 `callEntry` 一致；或把 `deadlineMs` 的初值改成一个有限值，避免「未 arm 即永不打断」这一失败模式。

---

## 🟡 性能问题

### PERF-1 [高] `digital-net.ts view()` 每 16ms 全量扫描 + 排序

**位置**: `packages/sim/src/digital-net.ts:273-289`

`postIoSnapshot()` 在 `session.ts` 的 16ms tick（62.5 Hz）中调用 `view()`，遍历所有 net，对每个 net 的 endpoints 做 `.map().sort()`，最后再整体排序。

**成本**: 500 nets × 4 endpoints → ~10,500 ops/call × 62.5 Hz ≈ 656k ops/sec；5,000 nets → ~6.25M ops/sec，吞掉 5ms slice 预算。

**修复**: 缓存 `NetRuntimeView[]`，仅在 net 值变化时失效重算；`io-snapshot`（200ms 节流）应是唯一消费者。

### PERF-2 [高] `ssd1315.ts paint()` 每个脏标记分配 8192 字节 + 8192 次迭代

**位置**: `packages/sim/src/devices/ssd1315.ts:81-104`

**触发**: 每次 I²C 写入字节后调用 `paint()`，每个脏标记都分配新数组 + 8192 次循环。

**修复**: 增量更新 dirty rect 而非全帧重绘；复用已分配的 `pixels` 缓冲区。

### PERF-3 [高] `esp32s3.ts serialWrite()` 用 `+=` 拼接字符串 → O(n²)

**位置**: `packages/sim/src/devices/esp32s3.ts`（serialWrite 相关）

`flushSerial()` 仅在 dispose/reset 时排空；字符串用 `+=` 累积，每追加一次拷贝整个已有字符串。

**修复**: 用 `Uint8Array` 缓冲或数组 `join()`。

### PERF-4 [高] `digital-net.ts record()` 用 `Array.shift()` 丢弃 → O(n)

**位置**: `packages/sim/src/digital-net.ts:230-236`

```ts
if (this.trace.length >= this.traceCapacity) { this.trace.shift(); ... }
```

**成本**: `traceCapacity` 默认 8192，`shift()` 移动所有剩余元素；每条超容 net 转换触发 O(8192)。10k 转换/秒 ≈ 82M 元素移动/秒。

**修复**: 环形缓冲区（头尾索引），push 与 drop 均 O(1)。

### PERF-5 [中] `outbox.ts` 串行/诊断队列无界增长

**位置**: `packages/sim/src/worker/outbox.ts:50, 74, 79, 109, 130`

`serialQueue`、`controlQueue`、`diagnosticQueue` 无最大长度；`diagnostic: 0`（line 50）意味着零背压。`postMessage` 受 16ms tick 限流，若生成速率超过消费速率，队列无限增长至堆耗尽。

**修复**: 每通道设上限；超限时丢弃旧消息（serial/control-log）或拒绝新消息（diagnostics）。

### PERF-6 [中] `autowire.ts` 全局优化预算检查不在内层循环

**位置**: `packages/core/src/autowire.ts:1313, 2142`

`planTreeGlobal` 的 `performance.now() > deadline` 用 `(count & 1023) === 0` 采样（line 1313），即每 1024 次迭代才查一次；`time_budget_ms` 默认 1500ms，单个 phase 可在两次检查之间大幅超时。

**影响**: 大型设计（40+ 组件）下 `optimize:'global'` 可能远超预算，UI 卡顿。

**修复**: 最内层循环每次迭代检查 deadline，或 yield 拆分。

### PERF-7 [中] `i2c.ts` 每次事务全量扫描

**位置**: `packages/sim/src/i2c.ts`

`.filter().includes()` 扫描所有 bus targets，`nackDiagnostic()` 重复扫描。

**修复**: 用 Map 按地址索引。

---

## 🟢 供应链 / CI

### SUP-1 [中] GitHub Actions 使用可变标签而非 SHA

**位置**: `.github/workflows/ci.yml`、`.github/workflows/pages.yml`

`actions/checkout@v4`、`pnpm/action-setup@v4`、`actions/setup-node@v4`、`actions/upload-artifact@v4` 均为可变标签，标签可被重新指向。

**修复**: 固定到 commit SHA。

### SUP-2 [中] `pnpm-workspace.yaml` `minimumReleaseAge: 0`

**位置**: `pnpm-workspace.yaml`

`minimumReleaseAge: 0` 关闭了 pnpm 对「新发布的恶意版本」的等待保护；`allowBuilds: esbuild` 允许 esbuild 运行 install script。

**修复**: 设 `minimumReleaseAge: 3`（天）；复核 `allowBuilds` 之外的包是否带 postinstall。

### SUP-3 [低] `.npmrc` 宽松对等依赖与无认证配置

**位置**: `.npmrc`

```
auto-install-peers=true
strict-peer-dependencies=false
```

---

## ✅ 复核为误报 / 确认安全

| 项目 | 结论 |
|---|---|
| `packages/sim/src/runtime/prelude.ts` 的 `({}).constructor.constructor` 逃逸 | **不成立**（Node/V8 实测：`delete globalThis.Function` 后 `Object.prototype.constructor` 为 `Object`，该表达式抛 `Function is not defined`）。QuickJS 中未验证。 |
| `packages/sim/src/runtime/studio-ts.ts` 缺中断处理 | **不成立**：`setInterruptHandler` 在 line 202 已设置。但 **`deadlineMs` 默认 `+Infinity`，若求值前未 arm 则中断永不触发** —— 该附注已升级为 **SEC-14**（实测复现，[#79](https://github.com/7dul2/breadboard-studio/issues/79)）。 |
| `packages/schema/src/migrate.ts` 接受未来版本 / 原地修改输入 | **不成立**：明确拒绝未来版本，不修改输入对象。 |
| `packages/render/src/svg.ts` 的 `esc()` 转义不足 | **不成立**：`esc()` 处理 `&<>"'`，属性上下文（双引号包裹）与文本上下文均正确。 |
| `packages/schema` 的 `additionalProperties: false` 完全覆盖 | **部分不成立**：`params`/`config`/`embedded_catalog` items 为开放 → 见 SEC-9。 |
| `markdown-it` 的 `html: true` | **安全**：仅为 devDependency，只在构建期由 `apps/web/devtools/docs-content.ts` 使用，运行时代码未导入；输入是本仓库自己的 Markdown。 |
| `dangerouslySetInnerHTML` / `innerHTML` / `document.write` / `eval` / `new Function` | **安全**：`apps/web/src` 中均未使用。 |
| `OledScreen.tsx` 的 `<foreignObject>` | **安全**：仅包含 `<canvas>`，无脚本或 HTML 注入。 |
| `loadDesign` 原型污染 | **安全**：经 `migrateDesign` → `validateDesignSchema`（Ajv2020 + `additionalProperties: false`），schema 层拒绝 `__proto__`/`constructor`/`prototype`。 |
| `serial-link.ts` / `browser-serial.ts` | **安全**：正确调用 `releaseLock()` 与 `port.close()`；`MAX_LINES = 2000` 有界；输出走 React 文本节点。 |
| `window.__bbs` 有 DEV 守卫 | **不成立**（误报的前提）：`main.tsx:9` 无条件调用 `installTestHooks()`，生产包中确实暴露 → 见 SEC-11。 |

---

## 复现脚本

`packages/sim/audit-pocs/` 下是审计期用的独立复现脚本（不在 `tsconfig`/`vitest` 的 include 范围内，不参与构建与测试）：

| 脚本 | 针对 |
|---|---|
| `toplevel-hang.ts` | SEC-14 —— 顶层死循环挂死 worker（**实测复现**） |
| `dispose-hang.ts` | 沙箱 dispose 路径 |
| `dyn-and-serial.ts` | 动态 import 与串口路径 |
| `gate-and-error.ts` | SEC-5 —— 各类引号/转义写法的扫描与加载结果表 |
| `globals.ts` | 沙箱全局对象暴露面 |

> **注意**: 其中若干脚本**故意构造挂死或很长的运行**（`toplevel-hang.ts` 预期永不返回，需自行 Ctrl-C）。`gate-and-error.ts` 在整理时也未自行终止（首个模板字面量动态导入用例即卡住），运行前请自行加超时。

---

## 优先级建议修复顺序（按二次复核后的定级调整）

1. **SEC-14** — 顶层死循环挂死 worker，已实测复现，且无任何测试覆盖。
2. **SEC-11** — 生产环境暴露完整设计操控能力（注意别让 `check:dist` 变成盲区）。
3. **SEC-6** — 上传 SVG 数据 URI 注入，存储型 XSS。
4. **SEC-12** — 文件导入无大小限制，浏览器 OOM。
5. **SEC-4** — MCP 服务器崩溃 / 栈泄露，影响代理工具通道。
6. **SEC-3** — TOCTOU，并发覆写。
7. **SEC-2** — 临时文件可预测名 + 权限放宽 + 失败残留。
8. **SEC-7** — `check-dist.mjs` 路径遍历 + 绑定 0.0.0.0（改成 127.0.0.1 是一行修复）。
9. **SEC-1** — MCP 侧的任意路径写入（按混淆代理处理，不再是 CRITICAL）。
10. **SEC-13** — dev 端点 CSRF（面比原稿描述的小）。
11. **SEC-10** — worker 消息校验。
12. **SEC-9** — 开放 schema，防御纵深。
13. **SEC-8** — `bb.mjs` NODE_PATH。
14. **SEC-5** — 扫描器诊断质量（不构成沙箱逃逸）。
15. **PERF-1/2/3/4** — 模拟器性能，大设计下卡顿。
16. **SUP-1/2/3** — 供应链加固。

---

*原始报告由独立并行审计 + 破坏性复核生成；本版由后续复核整理，去重并更正了 4 条结论、新增 1 条实测复现的缺陷（SEC-14）。所有 file:line 引证均经读取源码验证。*
