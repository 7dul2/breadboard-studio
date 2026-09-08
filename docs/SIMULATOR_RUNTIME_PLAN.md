# Breadboard Studio 第三期：可执行仿真（规格书阶段 1–3）

> 状态：实施计划，2026-09-08 起草，尚未开工
> 依据：`docs/SIMULATOR_DESIGN.md`（下称「规格书」）
> 前置：阶段 0 已完成（schema 1.1、程序事务、`packages/sim` 骨架、右侧「仿真」标签、`examples/touch_display.breadboard.json`）
> 终点：夹具里的程序真的在浏览器里跑起来——点触摸键，OLED 显示 `Touched`，板载 RGB 由程序驱动

**关于「第三期」这个叫法**：v0.1 编辑器是第一期，阶段 0 的仿真外壳是第二期，本期是第三期。它对应规格书自己的编号是**阶段 1 + 2 + 3**，也就是规格书 §18「完成定义」与「首个完整演示：ESP32-S3 N16R8 + TTP223 + SSD1315 OLED + 板载 RGB」的全部内容。阶段 4（传感器滑杆、录制回放、时间线调试）与阶段 5（真实固件后端）不在本期。

本计划的每一条技术结论都来自实测：起草期间在 Node 与真实 Chromium Worker 里跑过沙箱挂起、中断、懒加载、编译、确定性、渲染基准与子路径部署等实验。标「待验证」的地方就是真的没验证过，不要当成已知。

---

## 0. 本期做什么、不做什么

一句话目标：把「程序只能写和保存」变成「程序真的在跑，而且接错线会以正确的方式失败」。

**做**：确定性事件内核与虚拟时钟（调度器、倍速、暂停/单步/复位）；数字网络（0/1/Z/X）与离散电源域；Studio TS 编译 + QuickJS 沙箱 + Worker；器件驱动 ESP32-S3（GPIO / BOOT / RST / 板载 RGB）、TTP223、SSD1315 OLED；控制器级 I²C 事务；画布叠加层（LED 着色、OLED 像素、按下状态）与 feature 命中；串口控制台、网络监视器、诊断定位到源码行。

**明确不做**：分立 LED 驱动 `output.led@1`（理由见 §7.6，移入阶段 4）；SHT41 滑杆、录制回放、时间线调试（阶段 4）；真实固件后端（阶段 5）；WS2812 单总线时序解码；I²C 逐位波形、上拉电阻、时钟拉伸、总线仲裁；电流、发热、器件损坏；类型检查（Studio TS 只做语法转译，见 §6.2）。

**一条硬纪律贯穿全篇**（规格书 §1 目标 6）：错接、未供电、输出冲突、无应答都必须产生可见且可区分的结果，不允许静默「模拟成功」。凡是本计划里写「返回 0」「返回空数组」的地方，旁边一定同时有一条诊断。

---

## 1. 文件与归属表（唯一真相）

各节不再各自列文件清单，一律引用本表。**跨节接缝的归属在这里钉死**：

### 1.1 `packages/sim`（纯 TS，可被 Node 单测直接跑）

| 路径 | 内容 | 归属节 |
| --- | --- | --- |
| `src/types.ts` | 协议类型（改：追加可选字段与 3 个诊断码） | §3 §10 |
| `src/snapshot.ts` | `buildSnapshot`（改：产出新增字段） | §3 |
| `src/controller.ts` | 会话控制器（改：preflight、`run` 增参、running→paused） | §9.6 |
| `src/scheduler.ts` | `SimEvent` / `TimerHandle` / `Scheduler` / `SchedulerOverflow` | §4 |
| `src/digital-net.ts` | `DigitalNetKernel` / `resolveNet` | §5 |
| `src/power.ts` | `PowerDomain` / `powerInputFromSnapshot` / `powerPreflight` | §5 |
| `src/bus/i2c.ts` | `I2cController` / `I2cBusRegistry` / `I2cPhy` / `TransactionPhy` | §8 |
| `src/devices/{types,registry,paint,esp32s3,ttp223,ssd1315}.ts` | 驱动契约与三个驱动 | §7 |
| `src/runtime/{compile,prelude,guest-modules,studio-ts,diagnostics}.ts` | 编译与沙箱 | §6 |
| `src/worker/{pacer,outbox,loop,session}.ts` | `SpeedPacer` / `Outbox` / `SimLoop` / Worker 会话 | §4 §6.9 |
| `src/kernel.ts` | 桶文件：`export *` 调度器 / 数字网络 / 电源域 / I²C / 驱动 | — |
| `src/worker/index.ts` | 桶文件：`export *` runtime 与 worker 目录 | — |
| `package.json` | 改：`exports` 增加 `./kernel` 与 `./worker` | §1.3 |

### 1.2 `apps/web`

| 路径 | 内容 |
| --- | --- |
| `src/simulator/runtime/sim.worker.ts` | Worker 入口。**全仓库唯一** `await import()` 三个重依赖的地方 |
| `src/simulator/runtime/WorkerBackend.ts` | 主线程 `SimulationBackend` 实现 |
| `src/simulator/runtime/visualBus.ts` | 显示像素的 React 旁路总线 |
| `src/simulator/ui/{SimulatorOverlay,OledScreen,SimClock}.tsx` | 新增，见 §9 |
| `src/simulator/{simulatorStore.ts,ui/*,code/CodeEditor.tsx}` | 改，见 §9 |
| `src/components/Canvas.tsx` | 改：插叠加层、拖动前置门控 |

文件名大小写以本表为准（`WorkerBackend.ts` 大写、`sim.worker.ts` 小写）。

### 1.3 依赖与导入边界

新增依赖，**锁定精确版本，不用 `^`**：

| 包 | 版本 | 装在哪 |
| --- | --- | --- |
| `quickjs-emscripten-core` | `0.32.0` | `apps/web` dependencies + `packages/sim` devDependencies |
| `@jitl/quickjs-wasmfile-release-sync` | `0.32.0` | 同上 |
| `sucrase` | `3.35.1` | 同上 |

`packages/sim` 把三者列为 **devDependencies**：单测需要真实 QuickJS，而运行期实例一律由参数注入，所以 `packages/sim` 的产品代码不含任何 wasm 依赖。这条安排是 `packages/sim/test/integration-touch-display.test.ts`（§11.3 的集成测试、规格书 §18「确定性重放」与「四反例」的落点）能成立的前提——沙箱代码若落在 `apps/web`，那个测试写不出来。

**禁止**依赖根包 `quickjs-emscripten`（实测产出 4 个变体共 4,258 kB wasm）；**禁止** `esbuild-wasm`（实测额外 13,978,850 B wasm，gzip 3,726,193 B）。

`packages/sim/package.json` 的 `exports` 从今天的 `{".": "./src/index.ts"}` 扩成：

```json
{ ".": "./src/index.ts", "./kernel": "./src/kernel.ts", "./worker": "./src/worker/index.ts" }
```

**导入闸门**：`src/{kernel,worker,devices,bus,runtime}.ts` 及其目录下的任何文件都不得 `import` `@breadboard-studio/core`、`@breadboard-studio/catalog` 或 `./snapshot.js` / `./controller.js`——`src/index.ts:4-5` 会把 core 与 ajv 一起拖进 worker chunk（实测根入口 135,978 B、types-only 81 B）。这条不是口头约定：`packages/sim/test/imports.test.ts` 用源码扫描断言整个目录树，违反即测试失败。Worker 只允许从 `./kernel` 与 `./worker` 导入。

### 1.4 泵的归属（最容易做重的地方）

**`SimLoop`（`src/worker/loop.ts`）是唯一的泵**，它持有事件预算、时间片与 pacer。`StudioTsSandbox`（`src/runtime/studio-ts.ts`）**只实现 `GuestBridge` 接口**，不持有预算、不调用 `scheduler.advance()`、不判定死锁。`Scheduler.advance()` 负责「弹出堆顶 → 把 `nowUs` 推到它的 `atUs` → 触发事件回调」，客体 deferred 的 resolve 发生在**事件回调内部**，`SimLoop` 不再单独调用 `resolveNext`。

---

## 2. 技术选型（全部已实测）

规格书 §8.1 原定的两项方案在实测后都被换掉了，理由如下。这三条是本期的技术基石。

### 2.1 QuickJS 用 sync 变体，不用 asyncify

`quickjs-emscripten-core@0.32.0` + `@jitl/quickjs-wasmfile-release-sync@0.32.0`。客体的 `await sleep(500)` / `await oled.show()` 靠 `ctx.newPromise()` 返回的 deferred handle 实现挂起，客体自己 `await`，宿主在虚拟时间到点时 resolve——**不需要 asyncify**。

实测：sync 变体完整跑通夹具程序，虚拟时间从 0 推进到 1,578,000 µs，宿主全程没用真实定时器。体积 release-sync wasm 503,134 B vs release-asyncify 1,027,523 B，省一半。asyncify 的用途是让**同步**客体代码等宿主异步，而规格书 §8.1 明确「所有可能等待虚拟时间或总线的操作均为异步」，用不上。

残余风险：将来若要提供 Arduino 风格不带 `await` 的同步 `delay()`，必须换 asyncify（多 524 KB wasm）。v0.2 范围内不存在。

### 2.2 TypeScript → JavaScript 用 sucrase，不用 esbuild-wasm

| 方案 | 浏览器内 gzip 体积 | 单次编译 |
| --- | --- | --- |
| `sucrase@3.35.1` | 47,306 B（无 wasm） | 3 ms |
| `typescript@5.9.3` `transpileModule` | 1,023,316 B | 18 ms |
| `esbuild-wasm` | 19,832 B JS + **3,726,193 B wasm** | 153 ms |

决定性优势是**逐行保真**：实测夹具 `program_main` 25 行进、25 行出，出错函数的输入行号等于输出行号，QuickJS 直接报 `at loop (program_main.ts:14:3)`，不需要 sourcemap 就能映回编辑器。`ts-blank-space` 依赖 TypeScript 本体、体积等同且不支持 `enum`，排除。

代价：sucrase 不做类型检查，也不是严格的语法校验器（实测漏过 `const c = @@;`）。兜底是 QuickJS 的 `evalCode`——它的 `SyntaxError` 带结构化的 `fileName`/`lineNumber`/`columnNumber`，同样能给出 `program_compile_error`。**这条要写进用户可见文档**：写 `.ts` 不等于有类型保护，类型错误要到运行期才暴露成 `program_runtime_error`。

### 2.3 懒加载：主包 1,777 B

两条硬规则，违反其一体积就崩：

1. 只从 `quickjs-emscripten-core` + **单一变体包**导入，绝不 import 根包；
2. 三个重依赖只在 `sim.worker.ts` 内部 `await import()`，主线程唯一允许的形式是
   `new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })`。

实测产物：主包 `index-*.js` **1,777 B**（gzip 827）、worker chunk 264,184 B（gzip 62,687）、单个 wasm 503,134 B（gzip 231,526）。三种部署（`base=/`、`base=/breadboard-studio/`、vite dev）在 headless Chromium 全部跑出一致结果。对比当前仓库主包 703,674 B。

**wasm 与 worker 的地址一律用 `new URL(..., import.meta.url)` 交给 Vite 重写，禁止任何以 `/` 开头的硬编码路径。** 实测 Vite 8 会把 base 正确注入（build 产出 `/breadboard-studio/assets/…`，dev 产出 `/breadboard-studio/src/…`），Worker 内部的 `new URL('./x.wasm', import.meta.url)` 与 `import u from './x.wasm?url'` 都拿到带前缀的正确 URL。子路径部署的守门见 §11.5。

### 2.4 隔离与确定性的落法

- **不能用 `Eval: false`**：实测关掉 Eval intrinsic 后连 `ctx.evalCode('1 + 1')` 都返回 `TypeError: eval is not supported`，一行代码都跑不了。正确做法是保持 `Eval: true`，用宿主 prelude 删掉 `globalThis.eval` / `globalThis.Function` 并把四种函数原型的 `constructor` 置为 `undefined`。实测 prelude 版本让 `Function` / `AsyncFunction` / `GeneratorFunction` / `AsyncGenerator` / `Reflect.construct` 五条路径全部 `TypeError`，而正常代码不受影响。prelude 的语句顺序敏感（必须先取到四个原型再 delete `Function`），必须有单测钉死这五条路径。
- **`Date` 用 intrinsic 关掉**（`{ ...DefaultIntrinsics, Date: false }`），时间只来自宿主注入的 `micros()` / `millis()`。因此 `@bbs/runtime` 必须提供基于虚拟时钟的替代，并在默认示例与文档里说明客体没有 `Date`。
- **`Math.random`** 由 prelude 的 mulberry32 覆盖并 `Object.defineProperty(..., {writable:false, configurable:false})` 锁死，种子取 `SimulationConfig.random_seed`。实测同种子的两个独立沙箱给出完全相同的序列。
- **`rt.setMaxStackSize(64 * 1024)` 是强制项**。浏览器 Worker 逐档实测：8192–131072 B 时深递归表现为客体内可捕获的 `InternalError: stack overflow`；262144 B 与默认值会让 wasm 实例直接死亡（`RangeError: Maximum call stack size exceeded`）。Firefox / Safari 的上限**未验证**，统一取 64 KB 最稳。

---

## 3. 仿真快照字段扩展

这是整期的地基：数字网络、电源域、I²C、驱动全部从快照取数据。**字段名在本节一次性钉死，其它节只引用不重命名。**

主线程 `buildSnapshot`（`packages/sim/src/snapshot.ts`）负责全部推导，复用 core 的既有计算（规格书 §3.2「复用现有导通图」），Worker 侧只做相等比较。协议按**可选字段追加**处理，`SIM_PROTOCOL_VERSION` 保持 `1`。

```ts
// packages/sim/src/types.ts 追加

/** 引脚电气元数据的精简投影。不要把整包 PinMeta 塞进快照。 */
export interface SimPinMeta {
  role: PinRole;
  direction?: PinDirection;
  drive?: 'push_pull' | 'open_drain' | 'unknown';
  voltageV?: number | null;      // pin_meta.voltage_v
  ioVoltageV?: number | null;
  maxSourceMa?: number | null;
}

export interface SimI2cBusBinding {
  index: number;                 // 0 = 默认总线，≥1 = config.i2c_buses[index-1]
  sdaPin: string; sclPin: string;
  sdaNet: string; sclNet: string;  // 未接线时为 `unconnected:<componentId>.<pin>` 字面量
}
export interface SimI2cSpec {
  role: 'controller' | 'device';
  buses: SimI2cBusBinding[];     // device 只有一条
  address: number | null;        // core 的 i2cAddress()，显式 null = 未知
}

export interface SimPowerSource {
  address: string; componentId: string; pin: string;
  voltageV: number; netId: string | null;
  maxSourceMa: number | null; enabled: boolean;
}

// SimDeviceSpec 追加（全部可选）
export interface SimDeviceSpec {
  // …既有 componentId / model / driver / pinNets / pinChannels / properties
  pinMeta?: Record<string, SimPinMeta>;
  supply?: { min: number; max: number } | null;   // core 的 supplyRange(pc)，含 config 覆盖
  i2c?: SimI2cSpec;
}

// SimNet 追加
export interface SimNet { /* …既有 id / members / name */ pins?: string[] }

// SimulationSnapshot 追加
export interface SimulationSnapshot {
  // …既有字段
  power?: { sources: SimPowerSource[]; groundNets: string[] };
}
```

推导规则（全部在主线程，用 `analyzeDesign` 的同一份 `Analysis`，不重复分析）：

| 字段 | 来源 |
| --- | --- |
| `pinMeta` | `PlacedComponent.pins[].meta` 的六个键投影 |
| `supply` | `core.supplyRange(pc)`（`packages/core/src/rules.ts:40`） |
| `i2c` | `core.i2cBuses(pc)` / `i2cPins(pc)` / `i2cAddress(pc)`；`role` 按 `def.category === 'mcu'` |
| `SimNet.pins` | 直接搬 `conn.nets[].pins` |
| `power.sources` | `pin.meta.role === 'power_out' && typeof voltage_v === 'number'` |
| `power.groundNets` | `pin.meta.role === 'ground'` 的引脚所在 netId，去重 |

实测体积影响：夹具快照 6,116 → 9,805 字节，可忽略。

**未接线引脚**：`pinToNet` 的语义不变（只收录构成 `Net` 的引脚）。数字网络内核在 `prepare` 时为每个驱动设备的每个未列入 `pinNets` 的引脚合成一个私有单点网络，id 形如 `unconnected:<componentId>.<pin>`，值恒为 `Z`，不进 `SimNet` 列表、不进 `view()`。这个形态正是阶段 2「拆线后代码不再收到输入」所依赖的：实测删掉 `w11` 后 `mcu.GPIO4` 与 `touch.IO` 的 `pinToNet` 键双双消失。I²C 的 `sdaNet`/`sclNet` 用同一套字面量，Worker 因此不需要区分「没有键」和「接错了」。

**core 的 `Net.id` 绝不能进协议**：它是遍历序号（`connectivity.ts:189`），必须继续用 `snapshot.ts` 的 `netIdFor` 稳定哈希。

---

## 4. 事件内核与虚拟时钟

### 4.1 调度器

```ts
export interface SimEvent<P = unknown> {
  atUs: number;   // 整数微秒；只由 Scheduler.advance() 写入 nowUs
  seq: number;    // 全局单调递增，永不复用；同一 atUs 的稳定排序键
  source: string; // 'device:oled' / 'guest:sleep' / 'control' …
  type: string;
  payload: P;
}
export interface TimerHandle { cancel(): void; readonly cancelled: boolean }
export class SchedulerOverflow extends Error { readonly queueDepth: number }

export class Scheduler {
  constructor(options?: { maxQueue?: number });   // 默认 100_000（规格书 §14）
  get nowUs(): number;                            // 只读
  get queueDepth(): number;                       // 未取消条目数
  at(atUs: number, source: string, type: string, payload: unknown, run: (ev: SimEvent) => void): TimerHandle;
  after(delayUs: number, /* … */): TimerHandle;
  every(periodUs: number, /* … */): TimerHandle;
  nextAtUs(): number | null;                      // 跳过并回收堆顶的已取消条目
  advance(): SimEvent | null;                     // 弹出堆顶、推进 nowUs、触发回调
}
```

二叉最小堆，比较器先比 `atUs` 再比 `seq`；取消用墓碑而非堆内删除；**周期任务的句柄跨重排复用同一对象**，否则在回调里 `cancel()` 自己会失效（原型踩过）。`at()` 拒绝非整数与早于 `nowUs` 的时间戳。

原型实测输出：乱序插入 (1000,500,1000,1000) 触发序列为 `t500#1, t1000#0, t1000#2, t1000#3`；同刻 200 个事件的触发顺序等于插入顺序；周期任务在自己的回调里取消后恰好触发 3 次且队列归零；同种子确定、异种子不同。

### 4.2 与沙箱的接缝

**「客体挂起」的唯一判据**：`executePendingJobs()` 之后 `hasPendingJob() === false` 且被驱动的 promise 仍 `pending`。只有在这个点才允许推进 `nowUs`。把它收进一个接口，`SimLoop` 就不接触 QuickJS：

```ts
export interface GuestBridge {
  armDeadline(untilMs: number): void;   // 每次进入 VM 前必须重新武装（含 evalCode / callFunction）
  drainJobs(): { hasPending: boolean; error?: unknown };
  drivenState(): 'pending' | 'fulfilled' | { error: unknown };
  takeTripped(): 'time_slice' | null;   // 宿主自己的标志：客体能 catch 掉 InternalError
}

export type PumpOutcome =
  | { kind: 'finished' }
  | { kind: 'yield' }                                   // 本片用完或倍速节流
  | { kind: 'idle' }                                    // 挂起且队列为空，但存在外部输入源
  | { kind: 'deadlock' }                                // 挂起、队列为空、且没有任何输入源
  | { kind: 'budget'; reason: 'time_slice' | 'event_budget' | 'queue_overflow' }
  | { kind: 'fault'; error: unknown };

export class SimLoop {
  constructor(o: { scheduler: Scheduler; guest: GuestBridge; clock: { nowMs(): number };
                   hasInputSources: boolean;
                   sliceMs?: number /*5*/; eventBudget?: number /*10_000*/; speed?: SimulationSpeed });
  runSlice(): PumpOutcome;
  stepOnce(): PumpOutcome;
  setSpeed(speed: SimulationSpeed): void;               // 内部重锚
}
```

`runSlice()` 的循环形状：`armDeadline` → `drainJobs` → 有 job 就 continue（**不许推进虚拟时间**）→ 查 promise 状态 → 查 `takeTripped()` → 查倍速节流 → `advance()`。每次挂起后都要重新 `armDeadline`——实测截止时间过期后再调 `evalCode` 会直接得到 `InternalError: interrupted`。

### 4.3 三层预算、队列上限与两种「无事可做」

| 机制 | 值 | 挡什么 | 触发后 |
| --- | --- | --- | --- |
| 墙钟时间片 | 5 ms，每次进 VM 前重新武装 | 纯死循环、微任务饥饿 | `execution_budget_exceeded`(error) → `faulted` |
| 事件推进上限 | 每片 10,000 次 `advance()` | `await sleep(0)` 洪水（`nowUs` 原地不动） | 同上 |
| 事件队列上限 | 100,000 个未取消条目 | 事件工厂爆炸 | `event_queue_overflow`(error) → `faulted` |
| 挂起 + 队列空 + **有**输入源 | — | 等按键/等触摸的事件驱动程序 | `paused` + `waiting_for_input`(info)，收到 `control` 自动恢复 |
| 挂起 + 队列空 + **无**输入源 | — | `await new Promise(()=>{})` | `simulation_deadlock`(error) → `faulted` |

实测四种「不让出」形态各自被不同机制挡住：纯死循环 → `time_slice`（5.0 ms 跳出）；`while(true) await Promise.resolve()` → `time_slice`（6.1 ms）；`while(true) await sleep(0)` → `event_budget`（10,000 次推进、`nowUs` 仍为 0）；`await new Promise(()=>{})` → 队列空。

**「队列为空」不等于「不会再有事件」**：`control` 事件是宿主异步注入的，不在堆里，而 `controller.sendControl` 在 running / paused / stepping 三种状态都放行。若不分两级，任何「等触摸再继续」的程序——正是阶段 2 想鼓励的写法——会在用户还没点之前就被判死锁，而且触发与否取决于真实时序，直接破坏 §18 的确定性重放。`hasInputSources` 由 `prepare` 时扫快照决定。

**M-S2 实施裁决**：判据不是「声明了 `simulation.controls`」，而是「存在能 **resolve 一个挂起的客体 promise** 的输入源」。v0.2 的客体 API（`gpio.digitalRead` 同步、`sleep`、`Wire.*`）没有任何等待引脚的原语，控件改变网络值唤不醒 `await new Promise(()=>{})`，所以按控件取真会把死锁误报成「等待输入」。落地为 `packages/sim/src/worker/session.ts` 的具名谓词 `hasWakeableInputSources(snapshot)`，v0.2 恒为 false；阶段 4 引入真正的等待原语时只改这一处。

`execution_budget_exceeded` **不可恢复**：实测 QuickJS 中断后当前调用以 `InternalError: interrupted` 结束且不会续跑（第二次 `executePendingJobs()` 返回 0 个 job，客体的状态停在原地）。会话进入 `faulted`，用户只能复位。另外**客体可以用 `.catch()` 吞掉中断异常**，所以判定必须以宿主自己的 `tripped` 标志为准，不能只看返回值。

队列上限取 `faulted` 而非规格书 §14 的「超过即暂停」：队列满之后没有任何操作能让它缩小，恢复运行会立刻再次溢出。这条列入 §13 的规格书修订清单。

### 4.4 step / pause / reset 的精确语义

- **`step`** = 「排干 jobs → 恰好一次 `scheduler.advance()` → 再排干 jobs 直到重新挂起或结束」。第一版不区分「可见/不可见」事件：堆里每个事件要么改变网络值/设备状态，要么 resolve 一个客体 promise，两者都会在 outbox 留痕，所以「下一个可见事件」等价于「下一次 `advance()`」（规格书 §7.1 允许这个简化）。边界：第一次排干后客体已 `fulfilled` → 不推进时间，`nowUs` 不变；队列为空 → 保持 `paused`，不推进 `nowUs`，不判死锁。step 期间时间片仍武装（挡 `advance()` 之后同步段的死循环），事件预算固定为 1。**step 返回前必须强制 flush outbox**，否则单步后 UI 不动会被误判为卡死。
- **`pause`** = 不再调度下一个 tick；VM 不在栈上，零成本。因此 pause 只能落在片与片之间，最坏响应延迟 = 片长（5 ms）+ tick 间隔（16 ms）。暂停期间 `nowUs` 冻结，pacer 锚点在恢复时重锚，否则暂停时长会被算成欠账、恢复瞬间快进。
- **`reset`** = dispose ctx/rt 并重建 + 丢弃整个堆、`nowUs`/`seq` 归零。
- 后端**自发**进入暂停只有一条路径：`{kind:'idle'}` 时发 `{type:'status', status:'paused'}`。预算耗尽与队列溢出走 `faulted`，不走这条。`controller.ts:291-292` 目前只更新 `nowUs` 不改状态机，需要补一处 running→paused 的 dispatch（§9.6）。

### 4.5 倍速

`speed` = 虚拟时间 / 真实时间，取值来自 `SIMULATION_SPEEDS`。**唯一实现在 `SpeedPacer`**（`src/worker/pacer.ts`）：

```
waitMsFor(atUs) = max(0, anchorWallMs + (atUs - anchorUs) / (1000 * speed) - clock.nowMs())
```

主循环 tick 间隔取 `min(16, waitMsFor(nextAtUs))`，用 `setTimeout` 让出——**绝不忙等、绝不阻塞 Worker**（阻塞会让 `control`/`pause` 消息排不进来）。片内每次 `advance()` 前也查一次，>0 就结束本片。`set-speed`、从 `paused` 恢复、`step` 之后都要重锚。Worker 收到 `set-speed` 只调 `SimLoop.setSpeed()`。

**关键不变量：倍速与暂停只影响真实墙钟，绝不影响事件顺序与 `nowUs` 序列。** 用假时钟实测：同一程序在 1× / 10× / 0.1× 下 `(atUs, type)` 轨迹逐条相同，墙钟分别 2400.1 / 240.1 / 24000.0 ms，比率 1.00 / 10.00 / 0.100。

倍速是规格书 §2 列进 v0.2 的必做项，**不接受「本期只支持 1×」的降级**。残余风险只剩真实 Worker 里 `setTimeout` 的最小粒度与后台标签页节流（**未验证**），缓解是 e2e 只断言比例区间而非精确比率。

### 4.6 16 ms 泵-刷新循环

同一个 16 ms tick 同时驱动「跑一片」和「刷新 outbox」。逐通道最小间隔：`visual-diff` 33 ms、`serial` 50 ms、`status` 100 ms、`io-snapshot` 200 ms、`profile` 500 ms。原型在 1000 ms 的 tick 序列上实测发出 21 / 16 / 9 / 5 / 2 条，全部落在规格书 §14 的 30 FPS 与 20 FPS 之下。

注意量化效应：16 ms tick + 33 ms 阈值 → 实际间隔 48 ms（21 FPS），不是 30 FPS。要真到 30 FPS 得把 tick 降到 8 ms。本期取 21 FPS，把差额记在账上。

合并规则：`visual-diff` 在 outbox 里按 componentId 覆盖合并，发送时必须携带该设备的**全部** visual（原因见 §7.1）。**`serial` 不拼接**：同一 tick 内的多条 `serial` 消息一次 `postMessage` 批量送出，text 保持逐行。这样 `SerialLine` 的粒度与 `controller.ts:94` 的 5000 行上限含义不变，§9.4 的 DOM 预算算法与按行断言的 e2e 也继续成立。强制 flush 的时机：`step` 结束、`pause`、`fault`、程序结束。

### 4.7 测试

所有与真实时间有关的构件都注入 `{ nowMs(): number }` 与 `schedule(delayMs, fn)`，测试传可手动推进的假实现，**不用 `vi.useFakeTimers()`**。`loop.test.ts` 用假 `GuestBridge`（不加载 QuickJS）。

必测：① 乱序插入的触发序列；② 同刻 200 事件保持插入顺序；③ `cancel()` 后深度立减、`advance()` 不触发；④ 周期任务回调内自取消恰好 3 次；⑤ `maxQueue=8` 时第 9 次入队抛 `SchedulerOverflow`；⑥ `at()` 早于 `nowUs` 抛错；⑦ 事件预算触发且 `nowUs` 不变；⑧ 时间片触发，且断言宿主 `takeTripped()` 优先于客体返回值；⑨ 挂起+队列空+无输入源 → `deadlock`，有输入源 → `idle`；⑩ `step` 的三种边界 + 强制 flush 被调用一次；⑪ pacer 三档 `waitMsFor` 与重锚；⑫ outbox 各通道消息数 ≤ §14 上限；⑬ 倍速不改轨迹（`sliceMs` 设 `Infinity`——时间片本身是墙钟相关的，这是该不变量成立的前提，必须写在测试注释里）。

---

## 5. 数字网络与电源域

两个模块**不重算导通**：网络划分完全来自快照（§3），本节只在给定的 `netId` 上求值。

### 5.1 数字网络

每个驱动端是 `(componentId, pin)`，带一个 `DigitalValue` 与 `DriveStrength`。强度序 `strong > pull > weak`，求解只看**最高出现档位**：

| 最高档位上的驱动值 | 结果 | 诊断 |
| --- | --- | --- |
| 无驱动端，或全为 `Z` | `Z` | 读时才报 `floating_input` |
| 全为 `0` 或全为 `1` | 该值 | 无 |
| 同时出现 `0` 与 `1` | `X` | `digital_contention`(warning) |

推论与规格书 §7.2 逐条对应：`strong 0` + `pull 1` → `0`；`strong 0` + `strong 1` → `X`。**本计划的一处扩展**：`pull 0` + `pull 1` 同样判 `X`——规格书没写，v0.2 不建模电阻值、给不出分压结果，判 `X` 比默认某一边诚实。`weak` 档位实现但阶段 1–3 无人使用。

`open_drain` 在写入端夹紧：注册时带 `openDrain: true`（取自 `pinMeta.drive`）的驱动端，`drive(…, 1)` 一律记为 `Z`。I²C 的空闲高电平由 MCU 侧 `Wire.begin()` 注册一个 `pull`/`1` 提供。

```ts
export function resolveNet(drivers: readonly { value: DigitalValue; strength: DriveStrength }[]):
  { value: DigitalValue; contention: boolean };          // 纯函数，单测直接打这个

export class DigitalNetKernel {
  constructor(options: { nets; pinToNet; onDiagnostic; now: () => number; maxSettleRounds?: number });
  attach(key: DriverKey, options?: { openDrain?: boolean }): string;   // 返回 netId
  subscribe(netId: string, componentId: string, listener: (c: NetChange) => void): () => void;
  drive(key: DriverKey, value: DigitalValue, strength?: DriveStrength): void;  // 传 'X' 抛错
  setDevicePowered(componentId: string, powered: boolean): void;
  valueOf(netId: string): DigitalValue;
  readPin(key: DriverKey, opts?: { diagnose?: boolean }): DigitalValue;
  view(opts?: { includeUnconnected?: boolean }): NetRuntimeView[];
}
```

**传播与确定性**：`drive()` 把网络标脏后**同步**求解并回调订阅者，全程在宿主侧完成，既不进 VM 也不推进 `nowUs`；设备要延时反应就自己往调度器排事件。重入由「正在 settle」标志兜住。超过 `maxSettleRounds`（64）判为振荡 → `execution_budget_exceeded`。订阅者按注册顺序回调，注册顺序 = `snapshot.devices` 顺序再按驱动内部 `attach` 顺序。`view()` 按 `netId` 排序、`drivers` 按 `componentId`+`pin` 排序，默认过滤 `unconnected:` 私有网络。

**`digitalRead` 遇到 Z/X（全篇唯一裁决）**：`gpio.digitalRead(pin)` 返回 `0`，**并且必须同步发出** `floating_input` / `digital_contention`（warning）；四值原值只经 `gpio.digitalReadRaw(pin): DigitalValue` 暴露。不提供 `readLevel`、`digitalRead(pin, fallback)`、`UnknownLevelError` 这些多余入口。

为什么这不算规格书 §7.2「不能偷偷当成 0」：它禁止的是**静默**当成 0。这里每一次都留下诊断，而且提供了四值原值 API，用户在面板上能看到根因、在代码里能拿到真值。反过来，抛异常的方案会让未捕获的读取直接把会话打成 `faulted`（`controller.ts:301` 对 error 级诊断即 fault），与阶段 2 验收「拆线后代码不再收到输入**但仿真继续**」直接冲突——夹具程序写的正是 `gpio.digitalRead(TOUCH) ? 'Touched' : 'Ready'`。这条列入 §13 的规格书修订清单。

**诊断去重**：键为 `${code}|${netId}|${componentId}|${pin}`，同一键一次会话只发一条，条件消失时重新武装（边沿触发）。「冲突 → 恢复 → 再冲突」产生两条，可直接写成单测。

### 5.2 电源域

```ts
export type PowerReason = 'ok' | 'usb_off' | 'no_source' | 'voltage_out_of_range'
  | 'no_ground' | 'no_common_ground' | 'unknown_range' | 'passive';

export function powerInputFromSnapshot(snapshot: SimulationSnapshot): PowerDomainInput;
export function powerPreflight(input: PowerDomainInput): SimDiagnostic[];

export class PowerDomain {
  constructor(input: PowerDomainInput);
  evaluate(): DevicePowerState[];
  isPowered(componentId: string): boolean;
  supplyVoltage(componentId: string): number | null;
  railVoltage(netId: string): number | null;
  diagnostics(): SimDiagnostic[];
}
```

**电源轨** = `enabled && netId !== null` 的电源按 `netId` 聚合。**系统地** = 所有已使能电源所属元件的 `groundNets` 之并集。「共地」在这个模型里就是 `netId` 相等——union-find 已经在 core 里合并过 `internal_nets`，不需要再算。

判定条件相互独立，`powered` 要求全部通过：

| 条件 | `reason` | 诊断 |
| --- | --- | --- |
| `usbPowered` 但不在 `usb_powered_components` | `usb_off` | `device_unpowered`，文案指向面板勾选框 |
| 没有 `power_in` 也不是 MCU（电阻等） | `passive` | 无 |
| 所有 `power_in` 都没落在已使能电源轨上 | `no_source` | `device_unpowered` |
| `supply` 为 `null` | `unknown_range` | **`supply_range_unknown`(info)**，见下 |
| 电压不在 `supply` 内 | `voltage_out_of_range` | `device_unpowered`，message 写出实测电压与允许范围 |
| 没有任何 `ground` 引脚接入网络 | `no_ground` | `missing_common_ground` |
| `ground` 的 netId ∉ 系统地 | `no_common_ground` | `missing_common_ground` |

`unknown_range` 判 `powered = true` 但**必须发一条运行期 info 诊断**（新码 `supply_range_unknown`，§10），message 写明「该元件供电范围未知，仿真按已上电处理，供电电压不匹配不会被发现（实测轨压 X V）」。若什么都不发，把 `sht41_breakout` 接到 5 V 轨上运行期完全没有痕迹，用户只会看到「读数正常」——那正是 §1 目标 6 禁止的静默成功。设计期的 `supply_range_unknown` 是另一个面板、另一个时机，替代不了运行期证据。

**未供电的后果**统一由内核落实：`setDevicePowered(id, false)` 把该设备所有驱动端压成 `Z`（规格书 §7.3）；I²C 引擎查 `isPowered` 决定应答；显示驱动发 `enabled: false`。未供电设备的输出是 `Z` 属预期，**不再**为它触发 `floating_input`。

**一次会话内供电恒定**：改 `usb_powered_components` 会改内容哈希，而 `staleKeyOf` 只剥离 `speed`，所以运行中切换会让会话以 `stale_simulation_snapshot` 结束。`evaluate()` 只在 `prepare` 与 `reset` 时各调一次。另有一条产品限制要写进文档：`ops.ts` 会删掉空数组，`undefined` 与 `[]` 不可区分，所以「未设置 = 不供电」是唯一可行语义。

夹具实测输入：sources = `mcu.5V@5V`（无 net）、`mcu.3V3_1`/`3V3_2@3.3V → net_dcbc2bbd3485`；系统地 = `net_f0c7541ccde0`；`touch.supply={2,5.5}`、`oled.supply={3.3,5}`、`mcu` 没有任何 `power_in`（靠 `usb_powered_components` 上电）。

### 5.3 测试

`digital-net.test.ts` 正例：① 无驱动 → `Z`；② 单 `strong`；③ 两个同值 `strong` 不报冲突；④ `pull 1` 单独 → `1`；⑤ `strong 0`+`pull 1` → `0`；⑥ `open_drain` 写 1 被夹为 `Z`，与 `pull 1` 共网时释放读 `1`；⑦ 未接线引脚得到 `unconnected:c.p`、值 `Z`、不出现在 `view()`；⑧ 订阅隔离；⑨ `view()` 两次调用逐字段相等。反例：⑩ 强 0+强 1 → `X` + 一条 `digital_contention`；⑪ 冲突恢复后再冲突 → 恰好两条；⑫ `pull 0`+`pull 1` → `X`；⑬ 浮空网络上 `digitalRead` **返回 0 且恰好一条 `floating_input`，会话仍为 running**，`digitalReadRaw` 返回 `'Z'`；⑭ `drive(key,'X')` 抛错；⑮ 互相取反的两个 listener → `execution_budget_exceeded`；⑯ `setDevicePowered(false)` 后全 `Z`，`true` 后还原。

`power.test.ts` 全部基于夹具，正例：⑰ 基线三元件 `powered`、`supplyV === 3.3`、无诊断；⑱ `supply` 为 null → `powered`、`reason==='unknown_range'`、**恰好一条 `supply_range_unknown`(info) 且 `componentIds` 只含该元件**；⑲ 快照缺 `power` 字段时退回 `pinMeta` 推导，结果与 ⑰ 逐字段相等；⑳ 两次 `evaluate()` 结果与诊断顺序完全一致。反例（形态均已在导通图层面验证）：㉑ `usb_powered_components` 为空 → `mcu` `usb_off`、外设 `no_source`；㉒ `remove_wire w5` → `oled` `no_source`，其余不受影响；㉓ `remove_wire w1,w2` → 实测产生三条互不相同的 GND 网络，`oled`/`touch` 均 `no_common_ground`，`mcu` 仍 `powered`；㉔ 合成快照 `supply={3.15,3.45}` 接 5 V → `voltage_out_of_range`，message 含两个数值；㉕ 联合内核：断电后 `SDA` 驱动端为 `Z` 且不再产生 `floating_input`；㉖ preflight：电源–地同网的设计返回一条阻断项（今天 `analysis.hasBlocking` 为 false，会话仍能启动）。

### 5.4 已知简化

- 逻辑电平不匹配（5 V 模块驱动 3.3 V GPIO）v0.2 不做运行期诊断；设计期已有 `io_level_unknown`。
- 超压与欠压不区分，都判「不上电 + `device_unpowered`」，不模拟烧毁（规格书 §7.3 明确不模拟）。
- 多个 `power_in` 接不同电压轨时取最高电压，不额外诊断。阶段 1–3 的元件没有这种情形（`bmp390`/`ltr390` 的 `VCC/VIN/3V3` 是否同一路**待验证**）。
- 非 MCU 的 `power_out`（`power_module_3v3`，无 driver）恒使能——没人给它的 `VIN` 建模，否则它永远供不上电。
- `max_source_ma` 在三块 ESP32 板上全为 `null`（实测），v0.2 不建模驱动电流与电源余量。

---

## 6. Studio TS 运行时、沙箱与 Worker

### 6.1 沙箱构建（顺序不能改）

```ts
const rt = quickjs.newRuntime();
rt.setMaxStackSize(64 * 1024);              // 强制；>128 KB 会打死整个 wasm 实例
rt.setMemoryLimit(32 * 1024 * 1024);
rt.setInterruptHandler(() => this.checkBudget());
rt.setModuleLoader((name) => GUEST_MODULES[name] ?? { error: new Error(`模块不可用: ${name}`) });
const ctx = rt.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false } });  // Eval 必须保持 true
ctx.evalCode(PRELUDE.replace('__SEED__', String(seed >>> 0)), '<bbs:prelude>');    // 'global'，不是 module
bridge(ctx);                                                                       // 注入 __bbs* 宿主函数
ctx.evalCode(compiled.code, compiled.filename, { type: 'module' });
```

实测客体全局里 `fetch/XMLHttpRequest/WebSocket/setTimeout/setInterval/queueMicrotask/performance/Date/console/postMessage/crypto/WebAssembly/importScripts/require/process/eval/Function` 17 项全部不存在；模块白名单拒绝 `node:fs`、`./x.js`、`https://…`、`data:text/javascript,…`、`@bbs/devices/nope`，只放行 `@bbs/runtime` 与 `@bbs/devices/ssd1306`。

三条容易踩的实测事实：

1. **中断截止时间必须在每次进入 VM 前重新武装**（过期后再调 `evalCode` 直接得到 `interrupted`）。
2. **teardown 前必须回收所有挂起的 deferred**。留 1 个未 resolve 的 deferred 就让 `rt.dispose()` 抛 `Aborted(Assertion failed: list_empty(&rt->gc_obj_list) …)`，wasm 实例死亡。沙箱必须持有 `live: Set<QuickJSDeferredPromise>`，dispose 前逐个 `reject()+dispose()`。
3. **模块求值结果不是 Promise**：`getPromiseState(moduleHandle)` 返回 `notAPromise: true`，其 `value` 与入参是同一个句柄，只能 dispose 一次。同一 runtime 内用同一文件名重复 `evalCode(..., {type:'module'})` 不会缓存。

宿主桥函数以 `__bbs` 前缀挂在 `globalThis`。它们对客体可见，但暴露的能力与 `@bbs/runtime` 等价——直接调用最多把自己的程序弄崩，不构成沙箱逃逸。跨界数据一律 `JSON.stringify` 字符串。

### 6.2 编译

```ts
export function compileStudioTs(program: ProgramAsset, transform: typeof import('sucrase').transform):
  { ok: true; code: string; filename: string } | { ok: false; diagnostic: SimDiagnostic };
```

`filename === program.id`，会出现在 QuickJS 的 stack 里。

**未使用的导入会被 sucrase 删除**（实测）：`import fs from 'node:fs'` 若绑定未被使用，整行被删成空行，`setModuleLoader` 根本不会被调用，非法导入就静默通过了。所以 `compileStudioTs` 必须在 transform **之前**对原始源码扫一遍 `import … from '<spec>'` / `import '<spec>'` / `import('<spec>')`，把不在白名单里的 specifier 报成 `program_compile_error`。这只是提前报错的 UX，真正的闸门仍是 `setModuleLoader`。

**`e.loc` 不可靠**（实测）：`const a = @;` 抛出的异常没有 `loc`/`pos`；`@\n` 给出的 `{line:2,column:1}` 指向 EOF 而不是出错 token。映射规则写死：有 `loc` 用 `loc`，无则退回 `{line:1,column:1}`，UI 用整行高亮而不是列光标。

### 6.3 `@bbs/runtime` 的完整 API 面

以下 `.d.ts` 是客体可见的全部内容。规格书 §8.1 的三段示例源码、仓库夹具与 `DEFAULT_PROGRAM_SOURCE` 都已原样跑通。

```ts
export const LOW: 0, HIGH: 1;
export const INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2;
export const I2C_OK: 0, I2C_NACK_ADDRESS: 2, I2C_NACK_DATA: 3, I2C_ERR_BUS: 4, I2C_COLLISION: 5;
export type I2cStatus = 0 | 2 | 3 | 4 | 5;

export function sleep(ms: number): Promise<void>;
export function sleepUs(us: number): Promise<void>;
export function micros(): number;            // 虚拟时钟，唯一时间源（客体没有 Date）
export function millis(): number;

export const gpio: {
  pinMode(pin: number, mode: 0 | 1 | 2): void;
  digitalWrite(pin: number, value: 0 | 1 | boolean): void;
  digitalRead(pin: number): 0 | 1;              // Z/X 返回 0 并发诊断，见 §5.1
  digitalReadRaw(pin: number): 0 | 1 | 'Z' | 'X';
};

export const Serial: {
  begin(baud: number): void;
  print(value: unknown): void;                  // 不补换行；行装配在宿主完成
  println(value?: unknown): void;
  write(value: unknown): void;
};

export const Wire: {
  begin(o?: { sda?: number; scl?: number; frequency?: number; bus?: number }): I2cStatus;  // 同步
  end(): void;
  setClock(hz: number): void;
  write(address: number, bytes: ArrayLike<number>): Promise<I2cStatus>;
  read(address: number, length: number): Promise<Uint8Array>;          // 失败时 length === 0
  writeRead(address: number, write: ArrayLike<number>, readLength: number): Promise<Uint8Array>;
  probe(address: number): Promise<boolean>;
  scan(): Promise<number[]>;                                            // 0x08–0x77
  readonly lastStatus: I2cStatus;
};

export const board: { model: string; rgb(r: number, g: number, b: number): void };
```

`Wire.begin()` 是**同步**的（只做静态解析，不花虚拟时间），夹具里的 `await Wire.begin(...)` 保留无害。注意 `I2C_OK === 0` 是假值，所以判定必须写 `st === I2C_OK` 而不是 `if (st)`。

`Serial.print` 不在客体拼行：宿主 `__bbsSerialWrite(text)` 累加缓冲，遇 `\n` 才切出一条 `SerialLine`。实测 `print('a=') + print(2) + println(' done')` 合成一行 `a=2 done`，未终止的残余在会话结束时 flush。

**对规格书 §7.4 的刻意偏离**：`I2cController` 由 `Promise<void>` 改为返回状态码。理由：`i2c_nack` 是 warning，会话必须继续，而抛异常会被 `program_runtime_error` 打成 `faulted`。实测地址不匹配时 `setup`/`loop` 都正常返回、事务 NACK、GDDRAM 写入 0 字节——正好对应阶段 3 验收的「NACK 且屏幕保持黑色」。列入 §13 修订清单。

### 6.4 `@bbs/devices/ssd1306` 客户端库

```ts
export class SSD1306 {
  constructor(wire: typeof Wire, address?: number, width?: number, height?: number);  // 默认 0x3c/128/64
  begin(): Promise<boolean>;        // === (首个事务 status === I2C_OK)
  clear(): void;
  setColor(pen: 'white' | 'black' | 0 | 1): void;   // 笔色 = 位值；面板固有色来自目录
  pixel(x: number, y: number, on?: boolean): void;
  text(x: number, y: number, s: string): void;      // 5×7 字体，ASCII 0x20–0x7E = 475 B 常量
  show(): Promise<boolean>;
  displayOn(on: boolean): Promise<boolean>;
  invert(on: boolean): Promise<boolean>;
  setContrast(v: number): Promise<boolean>;
}
```

所有返回 `boolean` 的方法都定义为 `status === I2C_OK`。

**硬规则：framebuffer 在客体，字节必须真的经 `Wire.write` 出去**，不许给它开一条直连驱动的后门——否则「断 SDA / 错地址 / 未供电」三条反例全部失效。`begin()` 的返回值必须传播首个事务的 status：失败时客户端把自己标成未初始化，后续 `show()` 直接跳过（省掉每帧 23 ms 的无效虚拟时间，也让「屏幕保持黑色」成为默认结果）。

实测跑夹具程序 40 帧：361 次 I²C 事务、40,960 B 进 GDDRAM、on-pixels 89、虚拟时间 1,179,084 µs、真实墙钟 18.5 ms（0.46 ms/帧），`ready` 出现在虚拟 1,444 µs。

### 6.5 执行模型

`StudioTsSandbox` 实现 `GuestBridge`（§4.2），泵在 `SimLoop`。`setup()` 在 `prepare` 之后、第一次 `run` 之前驱动一次；`loop()` 每轮驱动一次，`finished` 才进入下一轮。

**RST 的归属**：`reset` 通道**不下发给驱动**，由 Worker 会话（`src/worker/session.ts`）直接消费。按下沿 → 暂停泵、广播 `onReset('host')` 给 MCU 驱动（它负责取消自己的定时器、GPIO 回 `INPUT`、UART 重置）；松开沿 → dispose 并重建沙箱、重新 `evalCode` 模块、跑 `setup()`。按住期间 MCU 不执行 `loop()`，但调度器仍推进虚拟时间、外部器件继续跑。内核的网络/器件状态不复位——符合规格书 §9.1「外部器件不一定复位」。这条分发规则必须同时写进 §7.1 的驱动契约，否则 `DeviceContext` 上没有任何能停止宿主程序的出口，接缝会是空的。

### 6.6 宿主桥的参数上限

规格书 §14 的预算只覆盖 VM 内部，宿主侧同样要设上限，否则客体一行 `await Wire.read(0x3c, 2**30)` 就会让**宿主**按客体给的长度分配内存，32 MB 的 `setMemoryLimit` 管不到 Worker 堆。

| 参数 | 上限 | 越界后 |
| --- | --- | --- |
| I²C `address` | 0x00–0x7F 的整数 | `I2C_NACK_ADDRESS` |
| I²C `readLength` | ≤ 4096 | `I2C_ERR_BUS` + `i2c_bus_unavailable` |
| I²C write 的 hex 长度 | ≤ 131072 字符 | 同上 |
| `sleep`/`sleepUs` 的 delayUs | `Number.isSafeInteger` 且 ≥ 0 | 抛给客体（`program_runtime_error`） |
| `pin` | 必须存在于 `pinChannels` | 抛给客体 |

越界一律**不分配内存**再判定。`studio-ts.test.ts` 逐条断言。

### 6.7 错误 → `{programId, line, column}`

| 来源 | 取法 | 实测样本 |
| --- | --- | --- |
| sucrase 抛出 | `e.loc.line/column`，缺失则 `(1,1)` | `const a: number = ;` → `{line:1,column:19}` |
| QuickJS `SyntaxError` | 句柄属性 `fileName`/`lineNumber`/`columnNumber`（1-based 列） | 第 2 行 0-based 第 10 列 → `lineNumber 2, columnNumber 11` |
| 运行时错误 | 解析 `stack` 首帧 | `"    at loop (program_main.ts:5:19)\n"` |
| 中断 | 见下 | `name='InternalError'`, `message='interrupted'` |

正则用：

```ts
const FRAME = /at\s+(?:[^\s(]+\s+)?\(?([^\s():]+):(\d+):(\d+)\)?/;
```

（侦察阶段给的版本有 bug，会把文件名解析成 `loop (program_main.ts`；上面这条对 `at loop (file:5:19)` 与 `at file:9:1` 两种帧都正确。）

**中断的 source（探针已完成，2026-09-08）**。结论落在计划原先设想的 (b)，而且比 (a) 更准：

| 取法 | 死循环在第 4 行时得到 | 结论 |
| --- | --- | --- |
| `InternalError: interrupted` 自带的 `stack` | `at loop (program_main.ts:2:8)` | 指向**函数声明行**，不是正在执行的行 |
| 在 `setInterruptHandler` 里 `evalCode('new Error().stack')` | `at loop (program_main.ts:4:24)` | 正是热点行 |

所以实现取两者的组合：中断处理器在预算耗尽的那一刻先取样，拿不到时回退到错误自带的 stack，再拿不到才填 `{line:1,column:1}`。取样必须有可重入保护，否则取样自身会被同一个处理器打断：

```ts
rt.setInterruptHandler(() => {
  if (this.capturing) return false;        // 绝不打断自己的取样
  if (this.clock.nowMs() <= this.deadlineMs) return false;
  if (!this.tripped) { this.tripped = true; this.captureStack(); }
  return true;
});
```

已在加固后的真实配置下验证（`eval`/`Function`/`Date` 均为 `undefined`、构造函数路径被 `TypeError` 拦下、正常代码不受影响）。

### 6.8 确定性的证明方式

不是文档，是单测。`packages/sim/test/studio-ts.test.ts` 断言：(a) §6.1 那 17 个全局名 `typeof === 'undefined'`；(b) `Function`/`AsyncFunction`/`GeneratorFunction`/`AsyncGenerator`/`Reflect.construct` 五条构造路径全部抛 `TypeError`；(c) 五个非法 specifier 都被 `setModuleLoader` 拒绝；(d) 同种子两个独立沙箱的 `Math.random` 序列逐字节相同；(e) `Math.random` 无法被重新赋值。

### 6.9 Worker 协议映射

`HostCommand`/`RuntimeMessage` **一个字段都不改**，`SIM_PROTOCOL_VERSION` 保持 1。

| `HostCommand` | Worker 侧动作 |
| --- | --- |
| `prepare` | 建内核 → `compileStudioTs` → 建沙箱 → `evalCode` → 驱动 `setup()` → 发 `status:'prepared'` |
| `run` | 启动 tick 循环（Worker 没有 rAF，用 `setTimeout` 让出，保证 `pause`/`control` 能被处理） |
| `pause` | 循环停在片与片之间；发 `status:'paused'` |
| `step` | §4.4 的语义；结束时强制 flush 后发 `status:'paused'` |
| `reset` | 重建沙箱与内核，`nowUs = 0` |
| `set-speed` | 转给 `SpeedPacer` 并重锚 |
| `control` | 转成内核事件；`reset` 通道由会话直接消费（§6.5） |
| `dispose` | 回收挂起 deferred → dispose ctx/rt → `self.close()` |

---

## 7. 器件驱动与驱动注册表

### 7.1 驱动契约

```ts
export interface DeviceContext {
  readonly componentId: string;
  readonly spec: SimDeviceSpec;                       // 只有自己的，深冻结
  nowUs(): number;
  random(): number;                                   // 由 random_seed 派生
  drive(pin: string, value: DigitalValue, strength?: DriveStrength): void;
  release(pin: string): void;
  read(pin: string): DigitalValue;
  watch(pin: string): void;
  netIdOf(pin: string): string;
  power(): { railV: number | null; groundOk: boolean; powered: boolean };
  after(delayUs: number, token: number): number;
  cancel(handle: number): void;
  visual(states: DeviceVisualState[]): void;          // 必须是本设备的全量列表
  serial(stream: 'stdout' | 'stderr', text: string): void;
  diagnose(d: Omit<SimDiagnostic, 'atUs' | 'componentIds'>): void;
  diagnoseOnce(key: string, d: Omit<SimDiagnostic, 'atUs' | 'componentIds'>): void;
  attachI2c(sdaPin: string, sclPin: string, addresses: number[]): void;
}

export interface DeviceDriver {
  readonly driverId: string;
  onNetChange?(pin: string, value: DigitalValue): void;
  onPowerChange?(power: DevicePower): void;
  onControl?(channel: string, action: SimulationControlAction, value: boolean | number): void;
  onTimer?(token: number): void;
  onI2cWrite?(address: number, bytes: Uint8Array, stop: boolean): I2cStatus;
  onI2cRead?(address: number, length: number): Uint8Array | null;
  onReset?(scope: 'session' | 'host'): void;
  dispose?(): void;
}
```

**能看到**：自己的 `pinNets` / `pinChannels` / `properties` / `pinMeta` / `supply` / `i2c` / `controls` / `visuals`、自己引脚上的网络解析值、电源域结论、控件事件、虚拟时间。
**不能做**（规格书 §3.4 的硬要求）：`ctx` 上**没有** `getDevice(id)` / `membersOf(netId)` / `devicesOn(netId)`；`netId` 是不透明字符串，只能做相等比较。操作不属于本设备的引脚直接 `throw`（这是内核 bug，不是用户错误）。

**控件分发规则**：`reset` 通道不下发给驱动，由 Worker 会话消费（§6.5）；其余通道按 `spec.controls` 翻译成 channel 后送到 `onControl`。

**视觉发布纪律**：`controller.ts:304-305` 是 `{ ...this.state.visuals, ...message.states }`，即**按 componentId 整体替换数组**。因此 `ctx.visual()` 必须每次带上该设备的全部视觉通道（N16R8 同时有 RGB 的 `led` 与 BOOT/RST 的 `pressed`，分开发送会互相覆盖）。内核缓存上一次数组，只在内容变化时上线。

**pressed 视觉的来源规则**：实测 N16R8 的 `simulation.visuals` 只有 `rgb` 一项，BOOT/RST 只在 `controls` 里。故约定：任何 `action` 为 `press`/`touch` 的 control，驱动都可以在它的 `feature_label` 上发 `{kind:'pressed'}`，不要求存在 `visuals[]` 绑定；若同一 feature 又声明了 `kind:'state'` 的 visual（TTP223 的 `touched`），按 `feature_label` 去重。这样不用改目录即可点亮 BOOT/RST。

驱动 id 按含 `@1` 的完整字符串精确匹配。未知 driver 或 `driver === null` 的元件（实测 `bmp390_breakout`、`resistor_axial`、`power_module_3v3` 等）不创建驱动，退化为不驱动任何引脚的电气端点并发一次 `unsupported_device`(**info**)——规格书 §6「报告一次，不让整个项目失败」。

**阶段 1–3 不需要修改任何目录 JSON。**

### 7.2 `mcu.esp32s3.behavioral@1`

- **引脚寄存器**：每个 GPIO 保存 `mode` 与 `out`。解析为 `drive()`：`OUTPUT` → `strong` 0/1；`INPUT` → `Z`；`INPUT_PULLUP` → `pull` 1。运行时 API 传的是**号**，驱动用 `pinChannels` 反查表转引脚名（N16R8 实测 36 项：`GPIO0..21→0..21`、`35..42`、`45..48`、`TX→43`、`RX→44`），号不存在则抛给客体。
- **digitalRead**：按 §5.1 的唯一裁决——`Z`/`X` 返回 0 并发 warning 诊断，`digitalReadRaw` 给四值原值。
- **BOOT**：`channel 'boot'`，按下时对 `boot_gpio`（0）追加一路 `strong` 0（真板是上拉 + 按键到地），松开撤销。若程序同时把 GPIO0 设为 `OUTPUT` 高，则 strong1 vs strong0 → `X` + `digital_contention`——这是真实短路，保留并写测试。
- **RST**：`channel 'reset'`，由会话消费（§6.5）。驱动侧的 `onReset('host')` 只负责取消自己的定时器、GPIO 回 `INPUT`、UART 重置。外部器件不复位（OLED 的 GDDRAM 与 TTP223 的自锁状态保留）。`RST` 引脚被外部导线拉低触发复位**不在 v0.2 范围**，该引脚仅作电气端点。
- **板载 RGB**：GPIO48 在夹具中**无网络**（实测 `pinNets` 无该键），灯是板内连接，因此驱动读自己的输出寄存器而不是网络。**v0.2 不解码 WS2812 单总线时序**（需亚微秒建模）：`digitalWrite(48,1)` → `{kind:'led',feature:'RGB',rgb:[255,255,255],intensity:1}`，`0` → 熄灭；真彩色走 `board.rgb(r,g,b)`。停止后驱动不再发视觉，画布回落到 `config.rgb_led_color` 的静态画法，满足规格书 §9.1。
- **电源域**：`usb_powered_components` 含本元件时，按 `pinMeta` 向 `3V3_1/3V3_2`(3.3 V)、`5V`(5 V) 声明电压源（夹具中两个 3V3 已由 `internal_nets` 合并为同一网络）。不供电 → 全部引脚 `Z`、程序不执行、一次 `device_unpowered`。
- **不模拟**：双核、Flash/PSRAM 容量、Wi-Fi。目录里 GPIO35–37 的 PSRAM 占用只是注释，驱动不为它写硬逻辑。

### 7.3 `input.ttp223@1`

未供电 → `IO` 输出 `Z` + 一次 `device_unpowered`。供电后：`channel 'touch'` 的布尔值进内部 `touched`；`toggle_mode:false` 为瞬时，`true` 为按下上升沿翻转自锁位。输出 = `output_mode === 'active_high' ? active : !active`，以 `strong` 驱动。同时发 `{kind:'pressed',feature:'触摸区',active}`。`config.supply_v`（夹具为 3.3）与电源域算出的轨压重复，v0.2 **忽略** `supply_v`。

### 7.4 `display.ssd1315@1`

- `init` 时 `attachI2c(sda, scl, [properties.i2c_address])`。未供电 → 所有事务 NACK。
- **帧格式**：`<control byte> <payload…>`，`0x00` = 命令流、`0x40` = 数据流，bit7 (Co) = 单字节续传。内置客户端库只发 Co=0；Co=1 也要实现并单测。
- **GDDRAM**：1024 B = 128 列 × 8 页，一字节 = 页内 8 个纵向像素（LSB 在上）。指针推进按寻址模式：页寻址列自增、页不进位；水平寻址列自增到窗口末尾后页自增；垂直寻址页优先。
- **必须实现的命令**（编码取自数据手册通用集，**待验证**，实现时须对照手册核对）：`0x20`、`0x21/0x22`、`0xB0–0xB7`、`0x00–0x0F`/`0x10–0x1F`、`0x40–0x7F`、`0x81`、`0xA0/0xA1`、`0xA4/0xA5`、`0xA6/0xA7`、`0xA8`、`0xAE/0xAF`、`0xC0/0xC8`、`0xD3`、`0xD5/0xD9/0xDB/0x8D`（仅存不生效）。未知命令 → `diagnoseOnce('cmd:<opcode>')` 发 `i2c_unknown_command`(warning)，状态保留。
- **像素输出**：每像素 1 字节强度，行优先，长度 `width*height`（8192 B），以 transferable ArrayBuffer 传。`level = contrast`（默认 255）；反显翻位后再乘；`0xA5` 全屏为 `level`；`0xAE` 或未供电 → 全 0 且 `enabled:false`。`color` 由驱动直接给 CSS 串（`white → '#f8fafc'`、`blue → '#38bdf8'`，与 `packages/core/src/component.ts` 一致）——Worker 不能 import core，所以 `devices/paint.ts` 复制这张两项表并用单测钉死字面量。缺 `display_color` 的另外两个 OLED 兜底 `'white'`。
- OLED 模块无复位脚，MCU RST **不**复位它。
- 客户端库与本驱动必须成对开发：单测把客户端库真实发出的字节流喂给驱动，断言 framebuffer 结果。

### 7.5 单元测试

`registry.test.ts`：3 个内置 id 可创建；`@2` 不匹配 `@1`；`driver === null` 返回 null；`ctx` 键集合等于文档列表（无 `getDevice`/`membersOf`）；操作非本设备引脚抛错。导入闸门的源码扫描在 `imports.test.ts`（§1.3）。

`esp32s3.test.ts`：GPIO 号→引脚名反查与重复号防御；三种 mode 落到网络；`digitalRead` 在 Z/X 上返回 0 且各发一条对应 warning，`digitalReadRaw` 返回四值；BOOT 按下拉低 GPIO0、松开恢复；BOOT + `OUTPUT` 高 → `X` + `digital_contention`；RST 按下清定时器与引脚、松开重跑 `setup`，且 OLED 驱动状态不变；`digitalWrite(48,·)` 产出 RGB 视觉且**同一数组**含 BOOT/RST 的 pressed；未 USB 供电时全 `Z` + `device_unpowered`；`devkit_generic`（无 feature/controls）不崩溃且只发一次 info。

`ttp223.test.ts`：瞬时按下/松开；`toggle_mode` 上升沿翻转、按住不重复翻转；`active_low` 反相；断电 → `Z` + `device_unpowered`；恢复供电后输出复原；相同事件序列产生相同输出。

`ssd1315.test.ts`：典型初始化序列全部被识别；`0x40` 数据在两种寻址模式下的指针推进；`0x21/0x22` 窗口裁剪；`0xA6/0xA7` 反显；`0x81` 改变输出强度；`0xAE` → `enabled:false` 且像素全 0；未供电 → NACK 且屏幕黑；未知命令只 warning 一次且不丢状态；客户端库 `text()` 往返后位模式与预期一致；缺 `display_color` 兜底 `'white'`。

所有测试用内存 harness 驱动虚拟时间，不使用真实定时器。

### 7.6 为什么 `output.led@1` 移出本期

规格书 §2「v0.2 要做」里只有板载 RGB，没有分立 LED；§16 的阶段 1/2/3 清单里也没有。更实际的原因是它做不出有意义的效果：实测 `resistor_axial` 没有 `internal_nets` 字段，`connectivity.full.connected('r1.P1','r1.P2') === false`——**串联限流电阻在 v0.2 的导通图里是断路**，`GPIO → 电阻 → LED → GND` 这种标准接法 LED 永远不亮。真正的修复（电阻作为二端导通元件 + 电流估算）属于阶段 4，LED 驱动跟它一起走。附带好处是快照不需要新增 `SimDeviceSpec.params` 字段（LED 的颜色在 `params` 而非 `config`，是唯一逼迫加这个字段的需求）。

---

## 8. I²C 控制器级总线

### 8.1 匹配条件

Worker 侧的匹配条件只有一条：`target.sdaNet === bus.sdaNet && target.sclNet === bus.sclNet`。所有与设计文件相关的解析都在主线程 `buildSnapshot` 完成（§3），运行期只比字符串。

夹具实测：

| 场景 | `mcu.GPIO8/GPIO9` 的 net | `oled.SDA/SCL` 的 net | 结果 |
| --- | --- | --- | --- |
| 基线 | `net_cdaf224f2998` / `net_be9ee4e90a68` | 相同 | ACK |
| `remove_wire w7`（断 SDA） | `GPIO8` 键消失 | `SDA` 键消失 | NACK |
| w6/w7 主控端对调 | `net_9d3cb234ab8f` / `net_076cfe9161d5` | 交叉 | NACK |
| 再挂一个 0x3C 器件 | 同一对 net | 同上 | collision |

三种反例的 `hasBlocking` 均为 `false`，即控制器会放行，符合规格书 §6「允许启动但产生结构化诊断」。

### 8.2 与 core 规则的关系

内核**不读** `analysis.results`。两套判断共享 `i2cBuses/i2cPins/i2cAddress` 这一层数据，但分工不同：core 规则在检查面板、每次分析设计时给 `i2c_address_conflict`(error, 不阻断) 与 `i2c_bus_mismatch`(warning)；运行期总线在程序真的寻址时给 `i2c_address_collision`(warning, 带 `atUs`) 与 NACK。

由此产生一个必须写进文档的**已知不一致**：程序把 I²C 重映射到非默认针脚（`Wire.begin({sda:4, scl:5})`）时运行期正常工作，而 core 仍按 `i2cBuses(mcu)` 判断，会误报 `i2c_device_without_controller`。本期不改 core，只在诊断文案里说明。

### 8.3 事务流程与时序

宿主侧步骤：① 取出 `key = sdaNet + ' ' + sclNet` 上注册的所有 target；② 过滤未供电的；③ 按地址匹配（0 个 → `I2C_NACK_ADDRESS`，≥2 个 → `I2C_COLLISION`）；④ 算出 `durationUs`，把 commit 事件排到 `nowUs + durationUs`，返回 deferred 让客体挂起；⑤ 事件到期后**原子地**调用 `onWrite`/`onRead` 再 resolve。器件与客体看到的都是事务**结束**时刻，中途不可观测。

```
bits(write)     = 1(START) + 9×(1 + N) + 1(STOP)      // N = 地址字节之后的全部 payload 字节数，含控制字节
bits(read)      = 1 + 9 + 9×N + 1
bits(writeRead) = 1 + 9×(1 + W) + 1 + 9×(1 + R) + 1
bits(地址 NACK) = 1 + 9 + 1 = 11
durationUs      = Math.ceil(bits × 1_000_000 / frequencyHz)
```

默认 `frequencyHz = 400_000`（ESP32 Arduino core 的实际默认值**未验证**，这是 Studio 自选值）：

| 事务 | bits | 400 kHz | 100 kHz |
| --- | --- | --- | --- |
| 地址 NACK | 11 | 28 µs | 110 µs |
| `write(0x3c,[0x00,0xAF])` | 29 | 73 µs | 290 µs |
| `read(0x44, 6)` | 65 | 163 µs | 650 µs |
| 整屏 1024 B（8 块 × `0x40`+128 B） | 9376 | 23,440 µs | 93,760 µs |
| `scan()` 112 个地址 | — | 3,136 µs | 12,320 µs |

分块 `I2C_MAX_CHUNK = 128` 让 `step` 有合理粒度。夹具 loop（两条寻址命令 190 µs + 整屏 23,440 µs + `sleep(20)`）= 43,630 µs → 虚拟帧率 22.9 FPS。

**明确不建模**：上拉电阻、时钟拉伸、总线仲裁、逐位波形；SDA/SCL 网络上的数字值不参与事务判定。同一控制器的并发调用（用户没 `await`）按 FIFO 串行化。

### 8.4 `begin()` 的解析与失败

两跳：GPIO 号 →（`pinChannels` 反查）→ 引脚名 →（`pinNets`）→ net id。以下情况返回 `I2C_ERR_BUS` 并发 `i2c_bus_unavailable`(warning)：GPIO 号不存在、`sdaNet === sclNet`、控制器自身未供电、超出 §6.6 的参数上限。未 `begin()` 就发事务同样返回 `I2C_ERR_BUS`。

### 8.5 诊断去重

`i2c_nack` / `i2c_address_collision` / `i2c_bus_unavailable` 一律 warning。**必须去重**：`diagnosticLimit` 默认 500，而 20 ms 一轮的 loop 会每秒产生 50 条 NACK，5 秒就冲掉全部历史。去重键 `${code}|${componentId}|${address}|${sdaNet}|${sclNet}`，每会话每键一次，`reset` 时清空。交叉接线时 message 要给出可操作提示（例：`oled 的 SDA 接到了 mcu 的 SCL 网络（net_9d3cb234ab8f），请对调两根线`）——这条信息可以从 `target.sdaNet === bus.sclNet` 直接判定。

### 8.6 为未来 bit-bang 预留

`I2cController` 只通过字节级 PHY 访问总线：

```ts
export interface I2cPhy {
  readonly mode: 'transaction' | 'bitbang';
  start(address: number, dir: 'w' | 'r'): boolean;
  repeatedStart(address: number, dir: 'w' | 'r'): boolean;
  writeByte(b: number): boolean;
  readByte(ack: boolean): number;
  stop(): void;
  readonly bitCount: number;
}
```

v0.2 只实现 `TransactionPhy`。将来的 `BitBangPhy` 实现同一接口、改为在 digital-net 上驱动边沿，`I2cController`、`I2cTarget`、诊断码都不用改。

### 8.7 测试

`i2c.test.ts` 用手写的快照片段构造 registry，不经过面包板几何：① ACK 且 `nowUs` 恰好前进 73 µs；② 地址不匹配 → `I2C_NACK_ADDRESS`、前进 28 µs、`onWrite` 未被调用、一条 `i2c_nack`，重复 100 次仍只有 1 条（去重）；③ 未供电 → 同上且不产生额外错误；④ 地址冲突 → `I2C_COLLISION`，两个 target 都未被调用，`componentIds` 含两个 id；⑤ 写读组合的顺序、同一 `atUs` 与时长公式；⑥ 断 SDA；⑦ 交换 SDA/SCL 且 message 含「对调」；⑧ `begin({sda:8,scl:8})` → `I2C_ERR_BUS`；⑨ 未 begin 直接 write；⑩ 确定性：同一快照同一程序跑两遍事务序列与每次 `atUs` 完全一致；⑪ 全部用例结束后 `rt.dispose()` 不抛。

---

## 9. Web 集成、可视化与交互

本节只写主线程侧。

### 9.1 Worker 生命周期

`SimulationBackend.prepare` 不传 sessionId，而 `controller.handleMessage` 会丢弃 sessionId 不匹配的消息。可用的接法是靠调用顺序：`controller.ts:237` 先 `emit({sessionId})`，`:239` 才调用工厂。所以工厂在闭包里读会话号，协议与控制器都不用改：

```ts
const controller = new SimulatorController({
  backend: () => new WorkerBackend(controller.getState().sessionId!)
});
```

规则：

1. Worker 只用 `new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })` 创建；构造在工厂里完成，`prepare` 只 `postMessage`。
2. 协议没有 prepare 的 ack，用 `{type:'status', status:'prepared'}` 作为 resolve 条件；超时 `reject(new SimBackendError({code:'runtime_unavailable'}))`。dev 模式首次运行要现拉 wasm，超时取 20 s（冷启动实际耗时**待验证**）。
3. `worker.onerror` / `onmessageerror`，以及 wasm 致命错误（`RangeError: Maximum call stack size exceeded`、`Aborted(...)`），一律 `terminate()` 并发一条 error 诊断转入 `faulted`。恢复靠「复位」（走 `faulted → stop → launch`，新建 Worker 与新 sessionId）。
4. `controller.disposeBackend` 是 fire-and-forget，所以 `dispose()` 必须**同步**调用 `terminate()` 再返回已 resolve 的 Promise。
5. 所有出站消息由 backend 统一补 `{protocol, sessionId}`；Worker 侧不需要知道会话号。

### 9.2 visual-diff 落到画布

新增 `<SimulatorOverlay>`，插在 `Canvas.tsx` 的 `{overlays}` 之后、同一个 `translate/scale` 组内（实测后画者赢 `elementFromPoint`）。每个元件一个 `<g transform={transformAttr(pc.transform)}>`，坐标直接用 `def.features[].rect_um` 经 `mm()` 换算——**不要用 `getBoundingClientRect()`**（`scene.ts:68-69` 的 path `d` 未做 µm→mm 换算，组 box 是错的；这是既有 bug，本期不修，只要求叠加层不依赖它）。`transformAttr` 目前是模块私有，需要导出。

| kind | 画法 | 命中 |
| --- | --- | --- |
| `led` | `<circle>`/`<rect>` 覆盖 rect，`fill=rgb(r,g,b)`，`opacity=intensity` | `pointer-events:none` |
| `pressed` | rect 描边 + 半透明填充 | `pointer-events:none` |
| `display` | `<foreignObject>` 内嵌像素级 `<canvas>`，`image-rendering:pixelated` | `pointer-events:none` |

**OLED 用 canvas 不用 rect 阵列。** 实测（Chromium 153 headless，1500 节点背景场景，CDP `Performance.getMetrics`，3 s rAF）：

| 方案 | 主线程任务 |
| --- | --- |
| 8192 个 `<rect>` 逐像素 diff | 3.23 ms/帧 |
| canvas → `toDataURL()` → `<image>` | 1.55 ms/帧 |
| HTML `<canvas>` 绝对定位 + `putImageData` | 0.33 ms/帧 |
| **`<foreignObject>` + `<canvas>` + `putImageData`** | **0.28 ms/帧** |

rect 阵列比 canvas 贵约 12×；30 FPS 下是 99 ms/s vs 8 ms/s 的主线程占用。默认缩放下每个 OLED 像素只有约 0.85 css px，画 8192 个亚像素矩形纯属浪费。6× 缩放后 canvas 仍是 0.27 ms/帧，`image-rendering:pixelated` 在放大与 `rotate(90)` 下都清晰。Worker→主线程传 8 KB transferable 往返 0.025 ms。

等比 letterbox：`s = min(rect.w/W, rect.h/H)`；ssd1315 0.96" 实测 `s=174.219 µm/px`、绘制区 22300×11150、`off=(2350, 6375)`；通用 0.96" `s=198.438`、`off=(800, 6150)`；0.91" `s=234.375`、`off=(6000, 2250)`。**必须先用不透明黑填满整个 rect 再画点阵**，否则 SSD1315 的 render 会把 `White` 字样透出来。overlay 用面板色乘灰度写 `ImageData`，`putImageData` 整块提交。

**像素绝不进 zustand**——这条要有机制，不能只有意图。`DeviceVisualState` 的 display 变体本身带 `pixels: Uint8Array`，而 `controller.ts:304-305` 会把 `message.states` 原样并进会话状态，`simulatorStore.ts:109-111` 再整份镜像进 zustand。所以规则是两步：

1. `WorkerBackend` 收到 `visual-diff` 后，先把 display 项的**真像素**交给 `visualBus`；
2. 再把转交给 controller 的那份 display 项替换成 `{ ...state, pixels: EMPTY_U8, onPixels, sha }`（`EMPTY_U8` 是共享的零长度常量）。

`OledScreen` 通过 ref 订阅 `visualBus`，在 React 之外写 canvas。协议类型不变，`SIM_PROTOCOL_VERSION` 保持 1。M-S3 补一条单测：运行 40 帧后 `useSimulatorStore.getState().visuals.oled[0].pixels.length === 0` 且 `onPixels > 0`。`visual-diff` 的 `revision` 是 Worker 侧每次 flush 递增的帧号，controller 与 UI 都不消费，仅用于诊断。

叠加层只在 `status ∈ {running, paused, stepping}` 挂载，卸载后 `$rgb_led_color` 的静态画法自然回来，不需要恢复逻辑。

### 9.3 feature 命中与 pointer capture

控件命中区是 `<rect fill="transparent" class="sim-control">`（`fill="none"` 不参与命中）。

```ts
onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); send(ctrl, true); }}
onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
onClick={(e) => e.stopPropagation()}   // capture 后浏览器仍会补派发 click（实测）
```

`onClick` 的 `stopPropagation` 是必需的：`Canvas.tsx:525` 的 `onClick` 在接线工具下会直接加线。`onPointerDown` 的 `stopPropagation` 阻止 `Canvas.tsx:359` 的选择与拖动分支（React 19 根委托下成立，实测），因此选择集不变——满足规格书 §11.3「不改变选择」。叠加层**不得**调用 `select()` / `selectHole()`。

两种几何情况（夹具实测）：MCU 是 flat，BOOT/RST 的 rect 落在 `.component-hit` 内部，只能靠 `stopPropagation` 挡住拖动；TTP223 是 upright，触摸区盖的是 `upright-ghost`（已是 `pointer-events:none`，今天完全不可点）。副作用：叠加层若忘记按状态门控，编辑态下 ghost 区会开始拦截框选——所以 M-S2 验收④把「编辑态回归」固化成 e2e。

`slider` 类控件（SHT41）本期不进画布，留到阶段 4。

### 9.4 节流与「不掉帧」

问题在 `simulatorStore.ts:109-111`：controller 每条消息 emit 一次，每次都整体 `setState`；`SimulatorPanel` 订阅 `nowUs`，其子组件 `SerialConsole` 与 `IoInspector` 没有 memo，于是每条 status 都重渲整个面板。三层措施：

1. **Worker 侧限频**（§4.6 的口径）。单步必须在 resolve 前强制 flush 一次。
2. **store 镜像帧合并**：`controller.subscribe` 里把 `status` / `sessionId` / `allowed` / `diagnostics.length` 变化的 emit 立即 flush，其余（`nowUs`/`serial`/`nets`/`visuals`）用 `requestAnimationFrame` 合并成每帧一次 `setState`。控制器与协议不动；`setTopologyGuard` 与命令入口读的是 `controller.getState()`，不受影响。代价：`__bbs` 钩子可能落后一帧，e2e 必须 poll。
3. **组件级**：`nowUs` 抽成 `<SimClock>`；`SerialConsole` / `IoInspector` 加 `React.memo` 并各自订阅所需字段；`SerialConsole` 改为只渲染尾部 500 行 + 「显示全部」按钮（默认上限 5000 行 × 2 span = 10000 节点）。

**串口口径**：`controller.ts:94` 的 5000 **行**保留为 DOM 硬边界；另在 Worker 侧按字节计数，越过规格书 §14 的 1 MB 时发一条 info 诊断（不用 toast，避免运行中弹窗）。

预算：据实测数字，16.7 ms 帧预算里仿真占用 < 3 ms。验证方式新增 `scripts/perf-sim.mjs`（仿 `perf-browser.mjs`）：载入夹具 → 点运行 → 采 3 s rAF 间隔直方图，断言 p95 < 20 ms 且长任务（>50 ms）为 0。该脚本本身**未实测**，M-S1 落地时要先跑一次基线再写死阈值。

### 9.5 启动前检查与强制启动

规格书 §6 要求「电源对地短路、不同电压并联：默认禁止启动，提供『仅调试，强制启动』入口但持续红色警示」。实测今天做不到：`power_ground_short` 与 `voltage_conflict` 的 `severity` 是 error 但 `blocking` 为 false（`results.ts` 明说电气问题永不阻断），所以 `analysis.hasBlocking` 为 false，`controller.launch` 会放行短路设计。

落法三件事：

1. `SimulatorController.run` 增加第二个可选形参 `run(design, opts?: { forceStart?: boolean })`。preflight **直接从 `analysis.results` 挑这两个码**当仿真级阻断项（不重算导通），命中时默认返回 `simulation_blocked_by_design` 并保持 idle；`forceStart` 为 true 时放行，但把该诊断降级为**常驻项**。`supply_out_of_range` 不阻断——它要在运行期表现为 `device_unpowered`，用户才看得到「接错电压 → 屏不亮」。`power_budget_*` / `power_capacity_unknown` 一律不得阻断（`rules.ts:398` 自述是资料数值比较）。
2. UI：`SimulatorToolbar.tsx` 加阻断项列表与「仅调试：强制启动」复选框（只存 `localStorage`，**绝不写进设计文件**），`styles.css` 加 `.sim-force-banner`，横幅在整个会话期间常驻。
3. e2e：构造电源–地同网设计 → 默认点运行被拒且状态仍 idle → 勾选后可运行且横幅一直可见 → 取消勾选后再次拒启。

### 9.6 控制器的其它改动

- 补一处 running→paused 的 dispatch，让后端自发暂停（§4.4 的 `idle` 路径）能改状态机，而不只是更新 `nowUs`。
- `profile` 消息目前被丢弃；要在面板显示 `eventsPerSecond`/`queueDepth` 就得在 `SimulatorState` 加字段。
- `run` 的签名变更见 §9.5。协议与 `RuntimeMessage` 不动。

### 9.7 诊断点击定位

- `componentIds` → `setHighlight([], ids)`（现状）。
- `pinAddresses` → `setHighlight(addrs, [])`。
- `netIds` → 用 `IoInspector.tsx:24` 的同一算法反查（对 `analysisOf(design).connectivity.nets` 逐条算 `netIdFor`），命中后 `setHighlight([...holes, ...pins], net.wires)`。
- `source` → `openEditor(programId)` + 跳转。行高确定为 18 px（`font-size:12px` × `line-height:1.5`），两栏 `padding-top` 都是 6 px，所以 `textarea.scrollTop = (line-1)*18`，`setSelectionRange(offset, offset)`。
- `CodeEditor.tsx` 的行号 `<pre>` 由整串 join 改为逐行 `<span>`，出错行加 `.code-line-error`；抽屉底部加一条诊断栏。**本期不引入 Monaco**（§14 要求动态导入，且主包已 703,674 B）。抽屉里另加一处一次性提示：Studio TS 只做语法转译，不做类型检查。

### 9.8 运行中禁用拓扑编辑

`store.ts:195-199` 已经拦截，但那是**事后**报错。要补事前表现：`canEditTopology === false` 时元件库条目与接线/放置工具按钮 `disabled`；`Canvas.tsx:359` 的 `onPointerDown` 在进入拖动分支前读 `canEditTopology`，为 false 就只做选择、不 `setPointerCapture`；`.canvas` 加 `sim-locked` class 淡化拖手柄；工具栏「停止」按钮补 §11.1 的「停止并编辑」文案。

**实施裁决（2026-09-08）：改成模式切换，禁用降级为「不存在」。** 本节原设想是把编辑控件 `disabled`。落地时改成顶栏一个 `搭建 / 仿真` 开关（`AppMode`，`store.ts`）：搭建挂元件库、工具、撤销/重做、DSL 与接线向导；仿真挂运行控件与观察面板，会改电路的入口一个都不渲染。理由有三：

1. 灰掉的按钮仍要解释「为什么灰」，撤走的按钮不用；
2. `undo()` 直接 `set({design})`，**绕过** `topologyGuard`——只要它在仿真里可见就是一个真实的缺口，隐藏它才真正堵上；
3. 会话只可能存在于仿真侧，于是「搭建 = 可编辑」成为一句无例外的承诺：切回搭建时由仿真侧（`simulatorStore` 订阅 `mode`）调用 `stop()`，依赖方向不变。

画布因此有**两个**独立的门控：`mode === 'build'` 与 `canEditTopology`，两者都为真才允许拖动——否则仿真里停掉会话后又能拖动元件了。仿真里仍可写的，恰好是引擎允许在会话中写的那些（`NON_TOPOLOGY_OPS`：程序源码与仿真配置）；改源码照旧让会话因快照过期停止。原「搭建模式」（逐根接线清单）与新模式名冲突，改名为右栏「接线向导」标签，画布高亮随标签开合，`setBuildMode` 随之删除。

### 9.9 e2e 钩子

```ts
// window.__bbs.simulator() 追加
{ nowUs; speed; droppedMessages; canEditTopology;
  serial: { componentId; stream; text; atUs }[];
  nets: { netId; name?; value; drivers: { componentId; pin; value; strength }[] }[];
  visuals: Record<string, (
      { kind:'led'; feature; rgb:[number,number,number]; intensity }
    | { kind:'display'; feature; width; height; enabled; onPixels; sha }
    | { kind:'pressed'; feature; active })[]>;
  diagnostics: { code; severity; message; atUs?; componentIds?; netIds?; pinAddresses?; source? }[] }

// 两个新方法
simulatorPixels(componentId: string): { width; height; onPixels; base64 } | null;   // 读 visualBus，不读 store
simulatorControl(componentId: string, controlId: string, value: boolean | number): boolean;
```

`Uint8Array` 不能直接跨 `page.evaluate` 边界，所以像素只暴露 `onPixels` / `sha` / base64。`NetRuntimeView.drivers` 字段协议里**已经有了**，要补的是产出它，不是加字段。

---

## 10. 诊断码总表（唯一真相）

`SIM_DIAGNOSTIC_CODES` 从 16 项增到 **22 项**。前 5 项在 M0.5 一次性登记，第 6 项 `simulation_forced_start` 在 M-S1 实施时补登（理由见下）。任何新码必须回到这里集中登记。

**severity 的硬约束**：`controller.ts:300-302` 会让任何 `severity === 'error'` 的运行期诊断立刻 `faulted` 并 dispose 后端。因此凡是「会话必须继续」的问题一律 warning。

| code | severity | 由谁发出 | 携带字段 | 新增 |
| --- | --- | --- | --- | --- |
| `simulation_blocked_by_design` | error | 控制器 preflight | `componentIds`、`pinAddresses` | |
| `simulation_forced_start` | warning | 控制器（强制启动） | `componentIds`、`pinAddresses` | ✅ M-S1 |
| `program_missing` / `program_target_missing` | error | 控制器 | `componentIds` | |
| `runtime_unavailable` | error | 后端工厂 / prepare 超时 | `componentIds`、`source` | |
| `program_compile_error` | error | `compile.ts` | `source` | |
| `program_runtime_error` | error | 沙箱 | `source` | |
| `execution_budget_exceeded` | error | `SimLoop` / 网络振荡 | `source`（见 §6.7）、`netIds`、`atUs` | |
| `event_queue_overflow` | error | `Scheduler` | `atUs` | ✅ |
| `simulation_deadlock` | error | `SimLoop` | `atUs` | ✅ |
| `stale_simulation_snapshot` | info | 控制器 | — | |
| `waiting_for_input` | info | `SimLoop` | `atUs` | ✅ |
| `unsupported_device` | **info** | 驱动注册表 | `componentIds` | |
| `supply_range_unknown` | **info** | 电源域 | `componentIds` | ✅ |
| `device_unpowered` | warning | 电源域 | `componentIds`、`pinAddresses`、`netIds` | |
| `missing_common_ground` | warning | 电源域 | `componentIds`、`pinAddresses`、`netIds` | |
| `digital_contention` | warning | 数字网络 | `netIds`、`pinAddresses`、`componentIds`、`atUs` | |
| `floating_input` | warning | 数字网络（读时） | 同上 | |
| `i2c_nack` | warning | I²C 总线 | `atUs`、`componentIds`、`netIds` | |
| `i2c_address_collision` | warning | I²C 总线 | 同上 | |
| `i2c_bus_unavailable` | warning | I²C `begin`/参数校验 | 同上 | ✅ |
| `i2c_unknown_command` | warning | SSD1315 驱动 | `componentIds`、`atUs` | |

补一条单测：遍历所有驱动与内核发出的诊断，断言 `code` 全部落在 `SIM_DIAGNOSTIC_CODES` 里、severity 与本表一致。已实现为 `packages/sim/test/diagnostics.test.ts` 的源码扫描。

**为什么强制启动要用独立的码**（M-S1 实施裁决）：原计划让 `simulation_blocked_by_design` 在强制启动时「降级为 warning 常驻项」，实现后被上面那条单测拦下。同一个码带两种 severity 会让本表失去意义——severity 在这里是**控制流**（控制器对任何 error 级运行期诊断立刻 faulted），不是显示样式。所以强制启动发的是另一件事实「你在明知有电气错误的情况下开了会话」，用 `simulation_forced_start`(warning)，原码保持 error 不变。

---

## 11. 里程碑、验收与测试

### 11.0 M0.5 开工前置（半天，先于任何里程碑合并）

「每个里程碑独立合并」有五个前提，全部实测确认：

1. **阶段 0 先成为基线提交。** 当前 `git status --short | wc -l` → 59，其中 8 条未跟踪。在此之前谈不上「独立合并」。
2. **`scripts/check-dist.mjs` 的 MIME 表补 `'.wasm': 'application/wasm'`。** 实测缺这一项会让 `WebAssembly.instantiateStreaming` 失败并产生两条 `console.error`（脚本把它们收进 `errors` 后 `exit(1)`），且 wasm 被下载两次。
3. **CI 的 build 步骤补 `VITE_BASE`，然后才加 `pnpm check:dist`。** 实测 `.github/workflows/ci.yml:21` 是裸 `pnpm build`，产物引用 `/assets/…`；而 `check-dist.mjs:8` 只服务 `/breadboard-studio/` 前缀，一律 404 → 页面加载失败 → `exit(1)`。所以要么给 build 步骤加 `env: VITE_BASE: /breadboard-studio/`（与 `pages.yml` 对齐），要么另加一步 `VITE_BASE=/breadboard-studio/ pnpm build && pnpm check:dist`，插在 `playwright install` 之后。另注意 `check-dist.mjs:15` 的 index.html 兜底会把任何 404 变成 200 + HTML，调试 Worker 路径问题时要记住。
4. **`apps/web/tsconfig.json` 显式覆盖 `"lib": ["ES2022","DOM","DOM.Iterable","WebWorker"]`。** `tsconfig.base.json` 没有 WebWorker，Worker 里写 `self.postMessage(msg, [buf])` 会报 TS2769（`self` 被当成 `Window`）。实测加上后该文件通过，且用同一 lib 集合对现有整个 `apps/web/src` 跑 `tsc --noEmit` 仍是零错误。
5. **`SIM_DIAGNOSTIC_CODES` 追加 5 个码**（§10），并按 §13 改写规格书。（M-S1 实施时又补了第 6 个 `simulation_forced_start`，理由见 §10。）

这些是一个 PR，不含任何执行逻辑。**注意**体积守门的三条断言不在 M0.5（此时 `dist` 里还没有 wasm，`wasm.length !== 1` 会失败），它们与后端一起在 M-S1 合入。

### 11.1 M-S1 竖切：板载 RGB 闪烁（规格书阶段 1）

| 项 | 内容 |
| --- | --- |
| 范围 | 快照增补字段（§3）；`packages/sim` 的调度器 / 数字网络 / 电源域 / 沙箱 / 编译 / Worker 会话；`apps/web` 的 `sim.worker.ts` + `WorkerBackend`；ESP32 GPIO/RGB 驱动；`led` 通道 overlay；倍速 pacer；启动前 preflight 与强制启动开关（§9.5）；体积守门（§11.5） |
| 验收 | ① 载入夹具，把 `program_main` 改成 500 ms 翻转 RGB，运行后 `nowUs` 单调增长且 `visuals.mcu` 的 `rgb` 在两值间交替；② 暂停后 `nowUs` 在 3 s 真实时间内不变、`rgb` 冻结，复位后 `nowUs === 0`；③ 纯死循环程序在一个 5 ms 时间片内被中断 → `execution_budget_exceeded` + `faulted`，且主线程仍响应点击；④ `await new Promise(()=>{})` → `simulation_deadlock`；⑤ 体积守门通过；⑥ 倍速：10× 下 3 s 墙钟内 `nowUs` 增量 ≥ 1× 增量的 5 倍（断区间不断精确比率）；⑦ 把夹具某根线改成电源与地同网 → 点运行保持 idle 且出现含 `power_ground_short` 的 `simulation_blocked_by_design`；勾选「仅调试：强制启动」后可运行且横幅常驻 |
| 新增测试 | `packages/sim/test/` 下 `scheduler`、`pacer`、`outbox`、`loop`、`digital-net`、`power`、`snapshot`、`compile`、`studio-ts`、`imports`、`controller`(补 preflight 与「warning 诊断不改变 status」) ；`e2e/sim-run.spec.ts` |
| 必改的既有断言 | `e2e/simulator.spec.ts` 的**三个** test 会因为接上真后端而失败：`:6` 的 `:76-77`、`:81` 的 `:112-114`、`:215`（`playback speed is a live control`）的 `:222`/`:226`——第三个最危险，它先点运行期待立刻「故障」，接真后端后会话会真的 running，三段语义全变。文案两处：`simulatorStore.ts:5` 的模块注释、`SimulatorPanel.tsx:221` 的阶段 0 说明。`packages/sim/test/controller.test.ts:115` **保留不动**（它测的是 backend 工厂返回 null 的路径）。「21 个 e2e 全绿」的门槛指的是**改写后**的 21 个 |
| 回退 | `WorkerBackend` 挂在开关后（默认开，`localStorage` 可关），回退 = 关开关而不是 revert |

### 11.2 M-S2 物理输入：BOOT/RST 与 TTP223（阶段 2）

| 项 | 内容 |
| --- | --- |
| 范围 | `SimulatorOverlay` 的 feature 命中层与 pointer capture；`ControlEvent` 通路；BOOT/RST（含 §6.5 的会话侧 reset）与 TTP223 驱动；网络监视器**产出** `drivers`；`floating_input` / `digital_contention` 诊断 |
| 验收 | ① 用真实 `mouse.down/move/up` 点 TTP223 触摸区，`nets` 中 TOUCH_IO 由 0 变 1，程序读到并打印；② `remove_wire w11` 使会话过期 → 重新运行后该引脚浮空、出现 `floating_input`，程序再也收不到输入，**会话保持 running**；③ 按 RST 后 `setup` 再执行一次；④ 编辑态回归：status 为 idle 时触摸区 `elementFromPoint` 仍返回面包板本体，框选/拖动不受影响；⑤ 深递归程序不打死 Worker，页面仍可交互 |
| 新增测试 | `packages/sim/test/devices/{esp32s3,ttp223,registry}.test.ts`；`digital-net.test.ts` 扩冲突/上拉/开漏；`e2e/sim-input.spec.ts` |
| 回退 | 只在 `status ∈ {running,paused,stepping}` 挂载 overlay，并把④固化成 e2e。回退 = 不挂载 overlay，控件仍可由 `__bbs.simulatorControl()` 注入，M-S3 不被阻塞 |

### 11.3 M-S3 I²C 与 SSD1315 OLED（阶段 3）

| 项 | 内容 |
| --- | --- |
| 范围 | 控制器级 I²C；SSD1315 GDDRAM 与常用命令；display overlay 与 `visualBus`；内置 SSD1306 客户端库；夹具 `program_main` 更新为完整演示（触摸 → OLED 文本 + RGB） |
| 验收 | ① 正确接线时 `simulatorPixels('oled').onPixels > 0`，触摸切换 `Touched` / `Ready`，同时 RGB 亮着（联合断言）；② 像素不进 store：运行 40 帧后 `visuals.oled[0].pixels.length === 0` 且 `onPixels > 0`；③ 规格书 §15 点名的**四个反例**产生四种可区分结果，且会话在四种下均保持 running |
| 四反例的判据 | 断 SDA（`remove_wire w7`）→ `i2c_nack`，`netIds` 含 `unconnected:oled.SDA`；错误地址（`config.i2c_address` 改 0x3D）→ `i2c_nack`，`componentIds` 只含 oled、message 含目标地址、`netIds` 为正常两条；OLED 未供电（断 VCC）→ `device_unpowered` 且屏幕 `enabled:false`；GPIO 输出冲突 → `digital_contention`。断言的是 `(code, componentIds, 屏幕 enabled/onPixels)` 三元组两两不同——**不是**「四个码两两不同」，`i2c_nack` 出现两次是预期的。「拆线 w11」不占四反例名额，归 M-S2 |
| 新增测试 | `packages/sim/test/i2c.test.ts`、`devices/ssd1315.test.ts`、`integration-touch-display.test.ts`（规格书 §15 集成七步 + 上述四反例，纯 Node、虚拟时间）；`e2e/sim-i2c.spec.ts` |
| 回退 | display 通道单独开关，关掉后 M-S1/M-S2 行为不变 |

### 11.4 测试策略

- **单元（vitest, `environment: 'node'`）**：`vitest.config.ts` 的 include 已覆盖 `packages/*/test/**` 与 `apps/web/src/**`，**无需改配置**。QuickJS/sucrase 相关的沙箱单测放在 `packages/sim/test/`（依赖在 `packages/sim` 的 devDependencies），不放 `apps/web`。
- **集成（vitest）**：`packages/sim/test/integration-touch-display.test.ts` 直接喂夹具，走 `SimulatorController` + 真后端（Node 端 QuickJS），断言虚拟时间与串口/网络/像素，不起浏览器。
- **E2E（Playwright）**：三个新 spec，**平铺**在 `e2e/` 下（今天没有 `e2e/sim/` 子目录）：`sim-run.spec.ts`、`sim-input.spec.ts`、`sim-i2c.spec.ts`。**所有时间断言用 `expect.poll` 断 `nowUs`，禁止 `waitForTimeout`**。每个 spec 的首个 run 用 `expect.poll(..., { timeout: 20000 })`（dev 模式下 Worker 与 wasm 是运行时按需拉取）。

规格书 §15 逐条落位：调度器 → `scheduler.test.ts`；数字网络 → `digital-net.test.ts`；电源域 → `power.test.ts`；I²C → `i2c.test.ts`；TTP223 / SSD1315 / ESP32 → `devices/*.test.ts`；快照 → `snapshot.test.ts`（现有 `controller.test.ts` 的 `describe('snapshot')` 迁出并扩写）；集成七步 + 四反例 → `integration-touch-display.test.ts`；E2E 六条 → 三个新 spec。

**已知盲区**：`jsdom` 与 `happy-dom` 都不在依赖里，`environment: 'node'`，因此 **React 组件层无法做单元测试**。overlay 的坐标换算必须抽成纯函数（如 `pixelRect(rect, w, h)`）才可单测，其余只能靠 e2e。本期不建议为此新增两个 devDependency。

### 11.5 性能与体积守门

扩 `scripts/check-dist.mjs`。先给 `node:fs` 的 import 补上 `readdirSync`（今天只有 `readFileSync, existsSync, statSync`），片段插在 `await browser.close();` 之后、`if (errors.length …)` 之前：

```js
const entry = readFileSync(join(dist, 'index.html'), 'utf8')
  .match(/<script type="module"[^>]*src="[^"]*\/assets\/([^"]+)"/)?.[1];
const entryText = readFileSync(join(dist, 'assets', entry), 'utf8');
const entrySize = statSync(join(dist, 'assets', entry)).size;
const wasm = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.wasm'));
const banned = ['quickjs', 'sucrase', 'emscripten'].filter((k) => entryText.includes(k));
if (entrySize > 900_000) errors.push(`entry chunk ${entrySize} B > 900000 B`);
if (banned.length) errors.push(`entry chunk mentions ${banned.join(', ')}`);
if (wasm.length !== 1) errors.push(`${wasm.length} .wasm assets, expected exactly 1`);
```

阈值 900,000 B：现状 703,674 B，留约 28% 余量。`wasm.length !== 1` 是防止误引 `quickjs-emscripten` 根包的核心防线（根包产出 4 个 wasm 共 4,258 kB）。原型已在当前 dist 上跑通。

**子路径 + 生产构建 + Worker + wasm 这条组合今天零覆盖**：`check-dist.mjs` 从不启动仿真，wasm 一次都不会被请求；而 e2e 跑的是 vite dev、base 为 `/`。所以守门片段之后还要**再点一次运行**并 poll `window.__bbs.simulator().nowUs > 0`，让这条路径真的被走一遍。

其余预算（5 ms 时间片、10,000 次事件推进、30/20 FPS 节流、1 MB 串口）不做构建期检查，改为在 `scheduler.test.ts` 里以常量断言 + 在集成测试里断言「10,000 次推进后必定产出预算诊断」。

### 11.6 CI 影响

本机基线：`pnpm test:e2e` 21 passed / 35.3 s；`pnpm exec vitest run` 16 文件 / 122 通过 / 10.3 s。

- 单元层新增十余个文件，其中沙箱相关每个用例都要实例化 QuickJS wasm。风险是 vitest 默认多进程并行导致内存峰值——若 CI 变慢或 OOM，先给这些文件加 `describe.sequential`，不要全局降并发。
- E2E 从 2 个 spec 变 5 个。`playwright.config.ts` 是 `fullyParallel: false` 且**没有设 `workers`**，CI 实际并行度**未验证**；每个 spec 都会拉起 Worker + 503 kB wasm，建议在 M-S1 合并时显式加 `workers: process.env.CI ? 1 : undefined`，并在 PR 里贴出 CI 实测耗时再决定是否保留。
- CI 新增 `pnpm check:dist`（M0.5），增量是一次 headless 加载，秒级。

### 11.7 规格书 §18「完成定义」逐条验证

| §18 条目 | 验证手段 |
| --- | --- |
| 用户确实编写并保存代码 | 已由 `e2e/simulator.spec.ts:6` 覆盖；M-S3 更新夹具源码后重跑 |
| 程序只能通过引脚/网络影响外设 | `sim-input.spec.ts` 的拆线用例；集成测试的断 SDA 反例 |
| TTP223 可触摸 / OLED 显示程序像素 / RGB 由程序驱动 | 三条 e2e 各一条断言。**夹具当前的 `program_main` 不驱动 RGB**，M-S3 必须用 `update_program` 更新 |
| 拆线/错线/断电/输出冲突结果不同且正确 | 集成测试的四反例，按 §11.3 的三元组判据 |
| 不阻塞主线程、不能访问浏览器与网络能力 | `studio-ts.test.ts` 的隔离断言（§6.8）；`sim-run.spec.ts` 的死循环用例断言主线程仍能点击 |
| 相同输入可确定性重放 | 集成测试：同一 `random_seed` 跑两遍，串口全文与最终 framebuffer 哈希逐字节相同 |
| 静态编辑/自动排线/导出/CLI 无回归 | 现有 122 单元 + 21 e2e 全绿即为证据；本期不改 core 的排线与几何代码 |
| 刷新后不自动运行导入的代码 | 已由 `e2e/simulator.spec.ts:154` 覆盖；M-S1 接后端后必须复跑，确认 `status` 仍是 `idle` |

---

## 12. 风险表

| 类别 | 风险 | 概率/影响 | 缓解 |
| --- | --- | --- | --- |
| 技术 | 未 dispose 的 QuickJS 句柄让 `rt.dispose()` 抛 `Aborted(...)`，wasm 实例死亡 | 高 / 高 | 一律用 `Scope`；沙箱单测每个用例结尾断言 `dispose()` 不抛；`WorkerBackend` 捕获 `Aborted`/`RangeError` 后 `terminate()` 并重建 |
| 技术 | `setMaxStackSize` 安全上限只在 Chromium Worker 上测过，Firefox/Safari 未验证 | 中 / 中 | 取 64 KB；M-S2 补「深递归不打死 Worker」e2e；跨浏览器**待验证**，不在本期承诺 |
| 技术 | 倍速在真实 Worker 里受 `setTimeout` 最小粒度与后台标签页节流影响 | 中 / 低 | pacer 已有假时钟原型（1×/10×/0.1× 比率 1.00/10.00/0.100）；M-S1 只需接线 + 一条按区间断言的 e2e |
| 技术 | 同一 componentId 的多个视觉通道若分开发送会互相覆盖（`controller.ts:305` 按 componentId 整替换） | 中 / 中 | 驱动每条 `visual-diff` 携带该元件全部通道（§7.1），由 `esp32s3.test.ts` 的联合断言覆盖 |
| 技术 | 运行期诊断若被定为 error，`controller.ts:300-302` 会立刻 fault，与「会话保持运行」的验收冲突 | 中 / 高 | §10 的总表把它们定死为 warning；`controller.test.ts` 补一条「warning 诊断不改变 status」 |
| 技术 | 中断异常可能拿不到源码位置，`execution_budget_exceeded` 无法定位 | 中 / 低 | M-S1 第一天做探针，三种结局都已定好落法（§6.7） |
| 体积 | 依赖包内部结构变化导致 quickjs 重新泄漏进主包 | 低 / 高 | §11.5 的三条断言 + 锁定精确版本 |
| 体积 | UI 代码增长把主 chunk 顶过 900 kB | 中 / 低 | 阈值失败时先看是不是真回归；确属正常增长则在同一 PR 里显式抬阈值并记录到 `docs/STATUS.md`，**不允许静默删断言** |
| 部署 | 子路径 + 生产构建 + Worker + wasm 组合出错且无人发现 | 中 / 高 | 全部地址走 `new URL(..., import.meta.url)`；§11.5 让 `check:dist` 真的跑一次仿真 |
| 时间 | 三个里程碑串行依赖，任何一环延期整体顺延 | 高 / 中 | M-S1 的内核与沙箱无相互依赖，可并行；M-S2/M-S3 的驱动单测可在 overlay 之前先写完 |
| 时间 | 既有 `e2e/simulator.spec.ts` 的三个 test 必须与 M-S1 同 PR 改写，否则 CI 红 | 确定 / 低 | 写进 M-S1 checklist 第一条（§11.1） |

---

## 13. 对规格书与既有约定的改动清单

本期要改规格书四处、既有代码若干处。全部在 M0.5 一次改完，理由都在正文里。

**`docs/SIMULATOR_DESIGN.md`**：

| 位置 | 原文 | 改成 | 理由 |
| --- | --- | --- | --- |
| §8.1 | 「TypeScript 由浏览器中的 `esbuild-wasm` 懒加载编译」 | sucrase | esbuild-wasm 需额外 13,978,850 B wasm（§2.2） |
| §8.1 | 「在指令预算耗尽时暂停」 | 「终止当前 loop 并进入故障态」 | QuickJS 中断不可恢复（§4.3） |
| §8.1 | — | 新增一句「Studio TS 只做语法转译，不做类型检查；类型错误在运行时才暴露为 `program_runtime_error`」 | §2.2 |
| §7.2 | 「`digitalRead(X)` 抛出或返回带诊断的未知值，不能偷偷当成 0」 | 补一句「返回 0 但必须同时产生诊断，并提供四值原值 API `digitalReadRaw`」 | §5.1 |
| §7.4 | `I2cController` 返回 `Promise<void>` | 返回 `I2cStatus` | §6.3 |
| §14 | 依赖点名 `esbuild-wasm` | sucrase | 同上 |
| §14 | 「事件队列上限 100,000，超过即暂停」 | 「超过即进入故障态」 | §4.3 |

**既有代码**：`packages/sim/src/types.ts`（4 个新诊断码 + §3 的可选字段）；`packages/sim/src/controller.ts`（preflight、`run` 增参、running→paused）；`packages/sim/package.json`（`exports`）；`scripts/check-dist.mjs`（MIME + 三条断言 + 跑一次仿真）；`.github/workflows/ci.yml`（`VITE_BASE` + `check:dist`）；`apps/web/tsconfig.json`（`lib` 加 WebWorker）；`e2e/simulator.spec.ts` 三个 test 与两处文案（§11.1）。

**不改**：`HostCommand` / `RuntimeMessage` 的字段与 `SIM_PROTOCOL_VERSION`；`packages/core` 的排线与几何代码；任何目录 JSON。

---

## 14. 本期之后

阶段 4：传感器行为模型与属性滑杆（SHT41/BMP390/LTR390）、输入事件录制回放、网络值时间线与断点、电阻作为二端导通元件 + 电流估算（连带把 `output.led@1` 做出来，见 §7.6）。

阶段 5：真实固件后端。先写 RFC 与技术验证，调查 ESP-IDF QEMU、Xtensa WASM 模拟器、WebSerial 真板三条路线，只有在 GPIO/I²C/定时器最小示例稳定后才接入现有 `SimulationBackend`。

两者都在 M-S3 合并后另行开卡。
