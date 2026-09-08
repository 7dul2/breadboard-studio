# Breadboard Studio 可编程仿真器设计方案

> 状态：提案，供新会话直接实施
> 目标版本：`v0.2` 行为级仿真，后续可扩展真实固件后端
> 首个完整演示：ESP32-S3 N16R8 + TTP223 + SSD1315 OLED + 板载 RGB

## 实施状态

**阶段 0 完成（2026-09-07）**，已落地：

- schema 1.1：`programs[]`、`simulation`，`1.0 → 1.1` 无损迁移（只改版本号，`loadDesign` 自动迁移，迁移后的哈希与直接按 1.1 写出的一致）；JSON Schema 与类型同步。
- 操作：`add_program`、`update_program`、`remove_program`、`set_simulation_config`；删除元件/面包板时指向它的程序会阻止删除，`cascade` 时一并删除并清理 `simulation` 引用。
- 规则：`program_target_missing`、`simulation_program_missing`、`unknown_reference`（阻断），`program_target_unsupported`、`program_target_not_controller`（警告）；`duplicate_id` 覆盖程序 id；程序与仿真配置参与内容哈希。
- `packages/sim` 骨架：协议类型（`SimStatus`、`SimulationSnapshot`、`HostCommand`/`RuntimeMessage` 等）、状态机（`transition`/`allowedCommands`/`canEditTopology`）、`SimulatorController`（启动前检查、`designChanged` 过期标记）、`buildSnapshot`、`SimulationBackend` 接口；没有后端时 `run` 直接进入 `faulted` 并报告 `runtime_unavailable`。
- 目录绑定：三块 ESP32-S3 板、TTP223、三个 OLED、LED、SHT41 的 `simulation` 字段与 `led` 类型 feature（见 `docs/CATALOG.md`）。
- Web：右侧“仿真”标签与代码编辑器，保存走 `applyOps`（可撤销、随项目导入导出）。
- CLI：`programs`、`program export`、`program import`；`ops`/`inspect` 包含程序与仿真配置。
- 示例：`examples/touch_display.breadboard.json`（N16R8 + TTP223 + SSD1315 + 程序）。

**明确没有做**：不执行任何代码；没有 Worker、沙箱或 Studio TS 编译；没有任何器件驱动行为（GPIO、I²C、OLED、RGB 均未模拟）。

阶段 0 的评审修复：倍速属于运行时控制，改它不再判定快照过期（其余 `simulation` 字段仍然过期）；`stop`/`reset` 在 `await` 前就清掉会话身份，后端 `start`/`pause` 的异常转成 `program_runtime_error` 诊断而不是抛给调用方；切换项目会丢弃未保存的代码草稿并关闭抽屉；代码抽屉高度按中间栏比例夹紧，画布至少保留 120 px；元件定义的 `simulation` 绑定改为 schema 层语义校验（`feature_label`、引脚名、绑定 id 唯一），导入的自定义定义也会被拒绝。

**阶段 1、2 已完成（2026-09-08）**：程序在 QuickJS 沙箱里真实执行，板载 RGB 由用户代码驱动，串口、虚拟时钟、暂停/单步/复位、倍速、死循环与死锁保护、启动前电气检查与强制启动开关均已落地；TTP223 触摸与 BOOT/RST 通过画布叠加层可点，输入经真实导线到达程序，剪线后程序确实收不到。阶段 3（I²C 与 OLED）未开始。

**阶段 1–3 的实施计划**，见 [`SIMULATOR_RUNTIME_PLAN.md`](SIMULATOR_RUNTIME_PLAN.md)（2026-09-08 起草，尚未开工）。该计划基于实测结论修订了本文的几处方案（编译器改用 sucrase、中断不可恢复、`digitalRead` 遇 Z/X 的裁决、`I2cController` 返回状态码、队列溢出转故障态），差异清单见计划第 13 节。以下各节保持提案原文。

## 1. 目标

在现有面包板编辑器中加入可运行的交互式仿真：

1. 用户能选中主控板，为它编写和保存代码。
2. 用户能启动、暂停、单步、复位仿真，并看到虚拟时间和串口输出。
3. 代码通过实际导线和面包板导通关系访问 GPIO、I²C 等接口。
4. 用户可点击/触摸画布上的按钮或传感区域；输入沿真实网络传到 MCU。
5. OLED、LED、按钮和传感器等元件根据运行状态实时改变外观。
6. 错接、未供电、输出冲突、无应答等情况必须明确报错，不能静默“模拟成功”。
7. 保留现有 JSON DSL、CLI、撤销历史和静态校验；仿真运行态与设计态严格分离。

第一版追求的是可信、确定、可扩展的“行为级仿真”，不是 ESP32-S3 Xtensa 指令级仿真。架构必须允许未来替换为真实固件后端，但不能因此阻塞第一版。

## 2. 明确边界

### v0.2 要做

- 代码语言：`Studio TypeScript`，Arduino 风格 API。
- MCU：ESP32-S3 N16R8 行为模型。
- 数字 GPIO：`INPUT`、`INPUT_PULLUP`、`OUTPUT`、高/低/高阻/冲突。
- 板载 BOOT、RST、RGB LED。
- TTP223：点击/按住触摸区时输出变化。
- I²C 控制器级事务：地址、写入、读取、ACK/NACK。
- SSD1315/SSD1306 兼容的 128×64 OLED 显示缓冲区。
- 串口控制台：`Serial.print/println`。
- 确定性虚拟时钟：`delay`、定时器、暂停、单步、倍速。
- 供电与公共地的最低限度检查。
- 仿真状态在画布实时呈现，但不写入撤销栈。

### v0.2 暂不做

- Xtensa LX7 指令级执行、ESP-IDF/Arduino C++ 本地编译。
- Wi-Fi、Bluetooth、USB 协议栈。
- SPICE、模拟波形精确计算、寄生参数、发热和器件损坏模型。
- I²C 的逐位时序、电容、上升沿和时钟拉伸精确模拟。
- 中断优先级、DMA、双核调度的硬件级复刻。

未来的真实固件执行必须作为另一个 `SimulationBackend` 接入，不能侵入电路内核和器件模型。

## 3. 核心设计原则

### 3.1 设计文档是静态事实，运行态是临时事实

- `.breadboard.json` 保存板、元件、导线、网络意图、代码和启动配置。
- 引脚电平、OLED 像素、按钮是否按下、虚拟时间、串口缓存只存在于仿真会话。
- 启动、暂停和运行不增加 `metadata.revision`，不进入撤销/重做。
- 修改接线、元件配置或代码后，当前仿真会话标记为过期，必须自动复位或由用户确认热重载。

### 3.2 复用现有导通图

`@breadboard-studio/core` 已能从孔阵、引脚、内部网络和导线建立网络。仿真器应消费其结果，不再维护第二套接线关系：

```text
DesignDocument
  → buildModel
  → buildConnectivity
  → SimulationSnapshot（稳定的 net id、pin → net 映射）
  → 事件内核 / 器件驱动
```

### 3.3 确定性优先

相同设计、相同代码、相同输入事件和随机种子，必须得到相同输出。所有时间使用虚拟微秒；测试不依赖真实 `setTimeout`。

### 3.4 器件通过网络交流

MCU 不允许直接查找某个 OLED 实例。它只能驱动/读取自己的引脚或发起绑定到 SDA/SCL 网络的 I²C 事务。这样接错线、断线和地址冲突才能真实暴露。

### 3.5 代码执行必须隔离

用户代码不能访问 DOM、`window`、`localStorage`、网络、文件系统或应用内部 Store。代码在独立 Web Worker 中的 QuickJS/WASM 沙箱运行，主线程只暴露白名单硬件 API。

## 4. 建议的工作区结构

新增纯 TypeScript 包：

```text
packages/sim/
  src/
    index.ts
    types.ts                 # 公共协议与运行态类型
    snapshot.ts              # DesignModel/Connectivity → SimulationSnapshot
    scheduler.ts             # 确定性事件队列和虚拟时间
    digital-net.ts           # 0/1/Z/X 与驱动冲突解析
    power.ts                 # 最低限度供电判定
    bus/i2c.ts               # 控制器级 I²C 总线
    devices/registry.ts      # driver id → 工厂
    devices/esp32s3.ts
    devices/ttp223.ts
    devices/ssd1315.ts
    runtime/backend.ts       # SimulationBackend 接口
    runtime/studio-ts.ts     # Studio TS 后端
    worker/protocol.ts
  test/

apps/web/src/simulator/
  SimulatorController.ts     # Worker 生命周期、状态快照、命令
  simulatorStore.ts          # 与编辑器 store 分开的运行态 store
  worker.ts                  # 沙箱和 packages/sim 的 Worker 入口
  code/CodeEditor.tsx
  ui/SimulatorPanel.tsx
  ui/SerialConsole.tsx
  ui/IoInspector.tsx
  ui/SimulatorToolbar.tsx
  visuals/SimulationOverlay.tsx
```

依赖方向：

```text
schema ← catalog ← core ← sim
                   ↑      ↑
                 render   web
```

`packages/sim` 不依赖 React、DOM 或 Zustand。`render` 不依赖 `sim`；Web 通过通用视觉状态把两者组合起来。

## 5. 数据模型与 schema 1.1

### 5.1 设计文档新增字段

将 schema 从 `1.0` 升至 `1.1`，提供无损迁移 `1.0 → 1.1`。字段均可选，因此旧项目迁移后行为不变。

```ts
interface ProgramAsset {
  id: string;
  name: string;
  target_component_id: string;
  language: 'studio-ts';
  source: string;
  entry?: string;            // 默认 main.ts，为以后多文件预留
}

interface SimulationConfig {
  active_program_id?: string;
  speed?: 0.1 | 0.25 | 0.5 | 1 | 2 | 5 | 10;
  random_seed?: number;
  usb_powered_components?: string[];
}

interface DesignDocument {
  // 原字段……
  programs?: ProgramAsset[];
  simulation?: SimulationConfig;
}
```

示例：

```json
{
  "schema_version": "1.1",
  "programs": [
    {
      "id": "program_main",
      "name": "触摸显示示例",
      "target_component_id": "mcu",
      "language": "studio-ts",
      "entry": "main.ts",
      "source": "import { gpio, Serial, sleep } from '@bbs/runtime';\n..."
    }
  ],
  "simulation": {
    "active_program_id": "program_main",
    "speed": 1,
    "random_seed": 1,
    "usb_powered_components": ["mcu"]
  }
}
```

代码编辑属于设计修改，必须通过 `applyOps`：

```ts
type Op =
  | { op: 'add_program'; program: ProgramAsset }
  | { op: 'update_program'; id: string; patch: Partial<ProgramAsset> }
  | { op: 'remove_program'; id: string }
  | { op: 'set_simulation_config'; patch: Partial<SimulationConfig> }
  | ExistingOps;
```

删除 MCU 时同步删除或显式报告关联程序。建议删除元件时一并清理其程序，和当前网络意图清理规则保持一致。

### 5.2 元件目录新增仿真描述

不要把具体行为写进巨大的 JSON。目录只声明驱动、引脚映射和可交互区域；行为在 `packages/sim` 驱动中实现。

```ts
interface SimulationDefinition {
  driver: string; // 版本化，如 mcu.esp32s3.behavioral@1
  pins?: Record<string, string | number>;
  properties?: Record<string, JsonValue>;
  controls?: Array<{
    id: string;
    feature_label: string;
    action: 'press' | 'touch' | 'toggle' | 'slider';
    channel: string;
  }>;
  visuals?: Array<{
    id: string;
    feature_label: string;
    kind: 'led' | 'display' | 'state';
    channel: string;
  }>;
}

interface ComponentDefinition {
  // 原字段……
  simulation?: SimulationDefinition;
}
```

首批定义：

| 元件 | driver | 关键绑定 |
| --- | --- | --- |
| ESP32-S3 N16R8 | `mcu.esp32s3.behavioral@1` | GPIO 号、BOOT、RST、板载 RGB |
| TTP223 | `input.ttp223@1` | `touch` 控制 → `OUT` |
| SSD1315 OLED | `display.ssd1315@1` | `SDA`、`SCL`、I²C 地址、128×64 framebuffer |
| 通用 LED | `output.led@1` | 阳极/阴极、电流方向 → 发光强度 |
| SHT41 | `sensor.sht4x@1` | 温湿度滑杆 → I²C 寄存器 |

`feature_label` 必须匹配现有 `features[].label`，使点击区域和渲染区域继续由目录几何定义。

## 6. 仿真快照

每次开始/复位仿真时，从当前设计构建只读快照：

```ts
interface SimulationSnapshot {
  designRevision: number;
  designHash: string;
  nets: SimNet[];
  pinToNet: Record<string, string>;
  devices: SimDeviceSpec[];
  programs: ProgramAsset[];
  config: SimulationConfig;
}

interface SimNet {
  id: string;                 // 不使用并查集内部 root；生成稳定 id
  members: string[];
  name?: string;
}
```

稳定 net id 建议使用排序后的成员地址做哈希。这样暂停时编辑导线后，可以准确判断哪些运行态还能复用；第一版可以更保守地整机复位。

启动前检查：

- schema 或物理阻断错误：禁止启动。
- 电源对地短路、不同电压并联：默认禁止启动，提供“仅调试，强制启动”入口但持续红色警示。
- 未供电、缺公共地、I²C 地址冲突：允许启动但产生结构化诊断。
- 没有仿真驱动的元件：保留为无行为的电气端点并报告一次，不让整个项目失败。

## 7. 事件与信号内核

### 7.1 虚拟时钟

```ts
interface SimEvent {
  atUs: number;
  seq: number;       // 同一时间的稳定排序
  source: string;
  type: string;
  payload: unknown;
}
```

- 使用最小堆优先队列。
- `nowUs` 只由调度器推进。
- 每轮最多处理固定事件数，防止用户代码零延迟死循环冻结页面。
- Worker 每 16 ms 或累计一定变更后向 UI 批量发送 diff，不能每个 GPIO 边沿都触发 React 更新。
- `step` 的第一版语义为“执行到下一个可见事件/挂起点”，不是源码行级调试。

### 7.2 数字网络

每个驱动端的值：

```ts
type DigitalValue = 0 | 1 | 'Z' | 'X';
type DriveStrength = 'weak' | 'pull' | 'strong';
```

解析规则：

- 无驱动 → `Z`。
- 同值驱动 → 该值。
- `open_drain` 只能驱动 0 或 Z。
- 强 0 与强 1 同网 → `X`，产生 `digital_contention`。
- 上拉/下拉只在没有相反强驱动时生效。
- `digitalRead(X)` 不能偷偷当成 0。**实施裁决（2026-09-08）**：返回 0，但必须同时产生 `floating_input` / `digital_contention` 诊断，并提供四值原值 API `gpio.digitalReadRaw(pin)`。不采用抛异常，因为未捕获的读取会把会话打成 `faulted`，与阶段 2「拆线后代码不再收到输入但仿真继续」的验收冲突。

网络值变化后，只唤醒订阅该网络的设备。

### 7.3 供电

v0.2 使用离散电源域，不做连续电路：

- USB 供电的 MCU 向其 `3V3`/`5V` 电源输出脚声明电压源。
- 器件只有在 `power_in` 网络电压落入定义范围，且 `ground` 与电源源头共地时才进入 `powered`。
- 未供电设备的数字输出为 Z，I²C 不应答，显示熄灭。
- 电压不匹配产生诊断；不模拟烧毁。

### 7.4 I²C

v0.2 实现控制器级事务，不逐位模拟波形：

```ts
interface I2cController {
  // 实施裁决（2026-09-08）：返回状态码而非 Promise<void>。NACK 是 warning，
  // 会话必须继续；抛异常会被 program_runtime_error 打成 faulted。
  write(address: number, bytes: Uint8Array): Promise<I2cStatus>;
  read(address: number, length: number): Promise<Uint8Array>;      // 失败时长度 0
  writeRead(address: number, write: Uint8Array, readLength: number): Promise<Uint8Array>;
}
```

事务仍需通过网络判断设备是否真的连接到相同 SDA/SCL、是否供电、地址是否匹配。多个同地址设备返回 `i2c_address_collision`；断线/错误地址返回 NACK。接口预留低层 SDA/SCL 边沿模式，未来支持 bit-bang。

## 8. MCU 代码运行时

### 8.1 语言选择

第一版使用 `Studio TypeScript`：

- TypeScript 由浏览器中的 **sucrase** 懒加载转译（**实施裁决（2026-09-08）**：原定 `esbuild-wasm` 实测需额外下载 13,978,850 B wasm，与本文 §14「不进首屏主包」的精神冲突；sucrase 无 wasm 且逐行保真，行号可直接映回编辑器）。
- **只做语法转译，不做类型检查**：写 `.ts` 不等于有类型保护，类型错误要到运行期才暴露为 `program_runtime_error`。
- 生成的 JavaScript 放进 QuickJS/WASM 沙箱执行。
- 只允许导入 `@bbs/runtime` 和内置器件库；禁止任意 npm、网络和文件访问。
- 编辑器可使用 Monaco，也必须懒加载；若包体积压力过大，第一阶段先用带行号的轻量编辑器，接口保持不变。

推荐 API：

```ts
import {
  gpio, Wire, Serial, sleep,
  INPUT, INPUT_PULLUP, OUTPUT, HIGH, LOW
} from '@bbs/runtime';
import { SSD1306 } from '@bbs/devices/ssd1306';

const TOUCH = 8;
const oled = new SSD1306(Wire, 0x3c, 128, 64);

export async function setup() {
  gpio.pinMode(TOUCH, INPUT);
  Serial.begin(115200);
  await Wire.begin({ sda: 9, scl: 10 });
  await oled.begin();
}

export async function loop() {
  oled.clear();
  oled.setColor('white');
  oled.text(8, 24, gpio.digitalRead(TOUCH) ? 'Touched' : 'Ready');
  await oled.show();
  await sleep(20);
}
```

所有可能等待虚拟时间或总线的操作均为异步。运行时必须检测连续不 `await` 的死循环，并在指令预算耗尽时**终止当前 loop 并进入故障态**，显示源码位置和 `execution_budget_exceeded`（**实施裁决（2026-09-08）**：QuickJS 的中断不可恢复，被中断的调用不会续跑，所以只能终止而非暂停）。

### 8.2 后端接口

```ts
interface SimulationBackend {
  readonly id: string;
  prepare(snapshot: SimulationSnapshot, program: ProgramAsset): Promise<void>;
  start(): Promise<void>;
  pause(): Promise<void>;
  step(): Promise<void>;
  reset(): Promise<void>;
  sendControl(event: ControlEvent): void;
  onMessage(listener: (message: RuntimeMessage) => void): () => void;
  dispose(): Promise<void>;
}
```

后续可以增加：

- `esp32s3-qemu-local@1`：本地 companion service 编译并运行 ELF。
- `esp32s3-firmware-wasm@1`：若成熟的 Xtensa/WASM 模拟器可用，直接在浏览器运行。
- `remote-hardware@1`：通过 WebSerial 将相同界面连接到真实开发板。

这些后端必须复用相同的 `SimulationSnapshot`、器件驱动协议、UI 和诊断格式。

## 9. 器件行为

### 9.1 ESP32-S3 N16R8

- 数字 GPIO 号从目录仿真映射读取，禁止依赖数组下标。
- BOOT 按钮按下时将 GPIO0 拉低，松开恢复。
- RST 按钮按下触发 MCU reset；代码、串口和外设初始化状态复位，外部器件不一定复位。
- 板载 RGB 由驱动通道控制，画布颜色优先显示运行态；停止后恢复目录/实例配置颜色。
- 5V/3V3/GND 建立电源域。
- 首版不模拟 N16R8 的 Flash/PSRAM 容量和双核，只把型号信息暴露为常量。

### 9.2 TTP223

- 用户 `pointerdown` 触摸区 → `pressed=true`，`pointerup/cancel` → false。
- 默认瞬时模式：有触摸时 OUT=HIGH，无触摸时 OUT=LOW。
- 允许目录属性声明反相/锁存模式，第一版 UI 可先不暴露焊盘配置。
- 未供电时 OUT=Z。
- 触摸事件必须带虚拟时间戳并可录制/回放。

### 9.3 SSD1315 OLED

- 地址默认 `0x3c`，遵从实例 `config.i2c_address`。
- 实现常用控制命令、页寻址/水平寻址、显示开关、反色、对比度和 1024 字节 GDDRAM。
- 第一阶段只需覆盖内置 `SSD1306` 客户端库会发出的命令集合；遇到未知命令保留状态并给一次 warning。
- `display off` 或未供电时屏幕黑色。
- 白色/蓝色为面板固有颜色属性；像素亮度由 framebuffer 与对比度共同决定。

### 9.4 视觉状态

设备驱动输出通用、只读的视觉状态：

```ts
type DeviceVisualState =
  | { kind: 'led'; feature: string; rgb: [number, number, number]; intensity: number }
  | { kind: 'display'; feature: string; width: number; height: number; pixels: Uint8Array; color: string; enabled: boolean }
  | { kind: 'pressed'; feature: string; active: boolean };
```

Web 根据 `feature` 找到目录的 `features[].rect_um` 并覆盖绘制。不要把 1024 字节 OLED 缓冲区写回 `ComponentInstance.config`。

## 10. Worker 通信

主线程 → Worker：

```ts
type HostCommand =
  | { type: 'prepare'; snapshot: SimulationSnapshot }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'reset' }
  | { type: 'set-speed'; speed: number }
  | { type: 'control'; event: ControlEvent }
  | { type: 'dispose' };
```

Worker → 主线程：

```ts
type RuntimeMessage =
  | { type: 'status'; status: SimStatus; nowUs: number }
  | { type: 'visual-diff'; revision: number; states: Record<string, DeviceVisualState[]> }
  | { type: 'serial'; componentId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'diagnostic'; diagnostic: SimDiagnostic }
  | { type: 'io-snapshot'; nets: NetRuntimeView[] }
  | { type: 'profile'; eventsPerSecond: number; queueDepth: number };
```

大缓冲区用 transferable `ArrayBuffer`，显示刷新合并到最多 30 FPS。协议消息必须可序列化、带版本号，并做运行会话 id 校验，防止旧 Worker 消息污染新会话。

## 11. Web 界面

### 11.1 顶部控制

增加一组仿真控制：

- `▶ 运行`
- `⏸ 暂停`
- `⏭ 单步事件`
- `↻ 复位`
- 倍速选择
- 状态灯：停止 / 编译 / 运行 / 暂停 / 故障

设计处于运行状态时，涉及拓扑的编辑默认禁用；点击“停止并编辑”后恢复。第一版不要尝试在运行中增删导线。

### 11.2 代码区

右侧新增“仿真”标签，包含：

1. 目标主控选择。
2. 程序名称和语言。
3. “打开代码编辑器”按钮。
4. 编译诊断。
5. 串口控制台。
6. 引脚/网络监视器。

代码编辑器建议作为中间区域可调整大小的底部抽屉，不能挤压元件库到不可用。支持保存、格式化、`Cmd/Ctrl+Enter` 运行、`Esc` 关闭。

### 11.3 画布交互

- 运行时，可交互 feature 使用手型光标和轻微高亮。
- 点击 BOOT、RST、TTP223 触摸区应阻止元件拖动，但不改变选择。
- 按住型控件必须监听 pointer capture、pointerup 和 pointercancel，避免鼠标移出后永远保持按下。
- OLED 和 RGB 的变化直接叠加到当前高仿真模型上。
- 选择某根网络时，属性面板显示当前值、驱动源和冲突信息。

## 12. 状态机

```text
idle
  └─ Run → compiling → prepared → running
running
  ├─ Pause → paused
  ├─ Reset → prepared → running
  ├─ runtime error → faulted
  └─ Stop / topology changed → idle
paused
  ├─ Run → running
  ├─ Step → stepping → paused
  ├─ Reset → prepared → paused
  └─ Stop / topology changed → idle
faulted
  ├─ Reset → compiling/prepared
  └─ Stop → idle
```

任何异步消息都带 `sessionId`。状态机拒绝非法命令，例如 `idle` 时 pause、`compiling` 时 step。

## 13. 诊断模型

```ts
interface SimDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  atUs?: number;
  componentIds?: string[];
  pinAddresses?: string[];
  netIds?: string[];
  source?: { programId: string; line: number; column: number };
}
```

首批诊断码：

- `simulation_blocked_by_design`
- `device_unpowered`
- `missing_common_ground`
- `digital_contention`
- `floating_input`
- `unsupported_device`
- `i2c_nack`
- `i2c_address_collision`
- `i2c_unknown_command`
- `program_compile_error`
- `program_runtime_error`
- `execution_budget_exceeded`
- `stale_simulation_snapshot`

点击诊断应定位元件/网络或跳转代码行。

## 14. 性能与安全预算

- 仿真逻辑全部在 Worker；主线程只处理用户输入和批量视觉 diff。
- 默认单次 Worker 时间片最多 5 ms 或 10,000 个事件，以先到者为准。
- 默认串口缓存 1 MB，超出后丢弃最旧内容并提示。
- 默认事件队列上限 100,000，超过即**进入故障态**（**实施裁决（2026-09-08）**：队列满之后没有任何操作能让它缩小，恢复运行会立刻再次溢出，故不能只是暂停）。
- OLED UI 刷新上限 30 FPS，串口 UI 刷新上限 20 FPS。
- Monaco、sucrase、QuickJS 均动态导入，不能进入编辑器首屏主包。
- Worker 无网络权限不是浏览器天然保证，必须由 QuickJS 隔离；不能直接用 `new Function` 执行用户代码。
- 导入项目时只保存源代码，不自动运行。

## 15. 测试策略

### 单元测试

- 调度器：同时间稳定顺序、取消、周期任务、事件预算。
- 数字网络：Z、上拉、开漏、冲突、恢复。
- 电源域：USB 供电、断电、缺地、电压不匹配。
- I²C：ACK、NACK、地址冲突、写读组合。
- TTP223：按下、松开、断电。
- SSD1315：初始化序列、寻址、像素写入、关屏、复位。
- ESP32：GPIO 映射、BOOT、RST、RGB。
- 快照：同一设计稳定生成、拓扑改变导致 hash 改变。

### 集成测试

使用固定设计：N16R8 + TTP223 + SSD1315。

1. 程序启动并打印 `ready`。
2. 点击触摸区。
3. TTP223 OUT 网络变高。
4. MCU 读取高电平。
5. MCU 通过真实 SDA/SCL 网络写 OLED。
6. OLED framebuffer 出现 `Touched`。
7. 松开后恢复 `Ready`。

再构造断 SDA、错误地址、OLED 未供电、GPIO 输出冲突四个反例。

### E2E

- 编辑代码 → 运行 → 串口出现输出。
- 点击 TTP223 → OLED 和 RGB 改变。
- 按 RST → `setup` 再次执行。
- 修改接线 → 运行停止并提示快照过期。
- 刷新页面 → 代码仍在，运行态不恢复、不自动执行。
- 导出/导入 JSON → 程序和启动配置完整保留。

所有核心测试使用虚拟时间，不允许用长时间真实 sleep。

## 16. 分阶段实施

### 阶段 0：schema 与最小外壳

- 增加 schema 1.1、类型、JSON Schema 和迁移。
- 增加 program ops 与删除依赖清理。
- 新建 `packages/sim` 和 Worker 协议类型。
- Web 加仿真状态机和空面板，不执行代码。

验收：代码能随项目保存、撤销、导入导出；旧 1.0 项目无损打开。

### 阶段 1：第一条竖切——板载 RGB 闪烁

- 调度器、数字网络、仿真快照。
- Studio TS 编译与 QuickJS Worker。
- ESP32 GPIO 和 RGB 驱动。
- 运行/暂停/复位、串口与错误显示。

验收：用户代码每 500 ms 改变一次 RGB；暂停后颜色冻结，复位后时间归零；UI 不掉帧。

### 阶段 2：物理按钮和 TTP223

- feature 命中测试、pointer capture、ControlEvent。
- BOOT/RST 和 TTP223 行为。
- 数字网络监视器、浮空与冲突诊断。

验收：按钮必须通过导线网络影响 MCU；拆线后代码不再收到输入。

### 阶段 3：I²C 与 SSD1315 OLED

- 控制器级 I²C。
- SSD1315 GDDRAM 和常用命令。
- 通用 display visual overlay。
- 内置 SSD1306 TypeScript 客户端库。

验收：示例代码在正确接线时显示文本；交换 SDA/SCL 或改错地址时 NACK 且屏幕保持黑色。

### 阶段 4：传感器、调试与录制

- SHT41/BMP390/LTR390 行为模型及属性滑杆。
- 输入事件录制/回放。
- 网络值时间线、断点和源码级调试探索。

### 阶段 5：可选真实固件后端

- 先写 RFC 和技术验证，不直接承诺产品化。
- 调查 ESP-IDF QEMU、Xtensa 模拟器 WASM、WebSerial 真板三条路线。
- 只有在 GPIO/I²C/定时器最小示例稳定后才接入现有 `SimulationBackend`。

## 17. 首个 PR 的严格范围

新会话不要一次实现整份文档。第一个 PR 只做：

1. schema 1.1 的 `programs`、`simulation` 与迁移。
2. 对应 `applyOps`、序列化和删除依赖处理。
3. `packages/sim` 骨架、公共类型、空状态机。
4. Web “仿真”标签、程序编辑/保存，不执行代码。
5. 单元测试、E2E 和文档同步。

第二个 PR 再做 RGB 闪烁竖切。这样可以先稳定文件兼容性和边界，再引入 WASM 与 Worker。

## 18. 完成定义

v0.2 只有同时满足以下条件才算完成：

- 用户确实在项目中编写并保存代码，而不是选择几个预制动画。
- 程序只能通过引脚/网络影响外设。
- TTP223 可触摸，OLED 可显示程序生成的像素，RGB 可由程序驱动。
- 拆线、错线、断电、地址错误会产生不同且正确的结果。
- 运行用户代码不会阻塞主线程，也不能访问浏览器和网络能力。
- 相同输入可确定性重放。
- 现有静态编辑、自动排线、导出和 CLI 流程没有回归。
- 项目刷新后不会自动运行导入的代码。

## 19. 给新会话的开工提示词

```text
请阅读 README.md、docs/ARCHITECTURE.md 和 docs/SIMULATOR_DESIGN.md；
如果仓库中存在 AGENTS.md，也一并阅读并遵守。然后实施“阶段 0：schema 与最小外壳”。

要求：
1. 先检查当前工作区已有修改，不覆盖或回退用户改动。
2. schema 升级到 1.1，并实现 1.0 → 1.1 无损迁移。
3. programs/simulation 必须走 schema、类型、applyOps、撤销、导入导出和删除依赖测试。
4. 新建 packages/sim，只实现公共协议和可测试的状态机骨架，不提前模拟 GPIO/I²C。
5. Web 增加“仿真”标签和程序编辑保存入口，但本阶段不执行用户代码。
6. 更新必要文档并运行 pnpm test、pnpm typecheck、pnpm test:e2e、pnpm build。
7. 不提交、不推送，除非我明确要求。
```
