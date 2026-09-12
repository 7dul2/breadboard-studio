/**
 * `bb mcp` — an MCP server on stdio that exposes the same engine as the CLI.
 *
 * Three rules make this a channel and not a second implementation:
 *   1. Every tool is a thin wrapper over `queries.ts`, the same data layer the
 *      CLI prints with `--json`. There is no MCP-only payload shape to drift.
 *   2. Read-only by default. `autowire` and `apply_patch` plan and report, and
 *      only touch the file when the caller passes `write: true`; both accept
 *      `expected_revision`/`expected_hash` so a stale view cannot clobber it.
 *   3. A returned rule failure is a *successful* tool call whose `ok` is false
 *      (the agent needs the results), while a usage/transaction error becomes
 *      `isError` with the same `{ok:false, error:{code,message}}` body the CLI
 *      writes. The distinction matters: "your design has an error" and "your
 *      patch could not be applied" are different instructions to the caller.
 *
 * Nothing is written to stdout except protocol traffic: the CLI's own text
 * rendering never runs here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CATALOG_VERSION } from '@breadboard-studio/catalog';
import { CliError, applyPatchData, autowireData, catalogInspectData, catalogListData, connectivityData, exportDesignData, inspectData, opsData, programsData, readDesign, stepsData, validateData } from './queries.js';

export const MCP_SERVER_NAME = 'breadboard-studio';
export const MCP_SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Breadboard Studio：面包板布局设计与静态校验。这里的工具与 `bb` CLI 共用同一套几何、导通图与事务引擎。',
  '推荐流程：catalog_list / catalog_inspect 查型号 → design_inspect 看设计 → design_validate 跑规则 → apply_patch 或 autowire 修改（默认 dry-run，write:true 才落盘；带 expected_revision 防并发覆盖）→ design_validate 复查 → export_design 导出图。',
  '地址格式：孔 `board.hole`（如 bb1.a5；排 a–j，电源轨 top_outer_1），端子 `component.pin`。',
  '文件路径相对 MCP server 的工作目录或绝对路径；设计与 CLI 共用 `.breadboard.json`。',
  'validate 报告 0 error 不等于电路已验证可安全上电；needs_review 项需要人工核对，请如实转述，不要替它下结论。',
  `目录版本 ${CATALOG_VERSION}。`
].join('\n');

interface ToolResult {
  /** SDK result shape requires an index signature; the extra keys are protocol metadata. */
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function failure(e: CliError): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: e.code, message: e.message, ...e.extra } }, null, 2) }] };
}

/** `CliError` becomes an `isError` result; anything else is a bug and propagates. */
async function guarded(fn: () => Record<string, unknown>): Promise<ToolResult> {
  try {
    return json(fn());
  } catch (e) {
    if (e instanceof CliError) return failure(e);
    throw e;
  }
}

const file = z.string().describe('设计文件路径（.breadboard.json；相对 MCP server 的 cwd 或绝对路径）');
const writeFlag = z.boolean().optional().describe('是否真的写入文件；默认 false，只报告（dry-run），文件一个字节都不动');

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { instructions: INSTRUCTIONS });

  // ---- catalog -----------------------------------------------------------

  server.registerTool(
    'catalog_list',
    {
      title: '列出元件与面包板目录',
      description: '列出目录中的定义：ref（id@version）、kind、分类、安装方式、几何/电气证据状态、引脚名与是否参数化。引用任何型号之前先查这里。',
      inputSchema: { design: z.string().optional().describe('同时列出该设计 embedded_catalog 中的定义') },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ design }) => guarded(() => catalogListData(design ? readDesign(design) : null))
  );

  server.registerTool(
    'catalog_inspect',
    {
      title: '查看一个定义',
      description: '查看一个板或元件的完整定义：引脚表（角色、电压、方向、auto_wire、reserved 保留标记、备注）、参数 schema、尺寸几何、电源信息与来源。ref 形如 esp32s3_n16r8_dual_usb@1（版本可省略时用 `bb catalog list` 的写法）。',
      inputSchema: {
        ref: z.string().describe('定义引用，如 ssd1315 oled_0_96_ssd1315_i2c@1'),
        design: z.string().optional().describe('同时在该设计内嵌定义中查找')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ ref, design }) => guarded(() => catalogInspectData(ref, design ? readDesign(design) : null))
  );

  server.registerTool(
    'list_ops',
    {
      title: '列出补丁操作类型',
      description: '列出 apply_patch 支持的全部操作类型与字段。写补丁前先查这个，不要凭记忆拼 op 名。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => guarded(() => opsData())
  );

  // ---- read-only design queries -----------------------------------------

  server.registerTool(
    'design_inspect',
    {
      title: '汇总设计',
      description: '汇总一个设计：元数据、revision 与内容 hash、面包板、元件引脚落孔、导线（含是否导通）、网络、程序列表与仿真配置。改动前后都用它核对 revision/hash。',
      inputSchema: { file },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file: f }) => guarded(() => inspectData(f))
  );

  server.registerTool(
    'design_validate',
    {
      title: '运行全部规则',
      description: '运行全部静态规则（短路、断网、孔位冲突、板体遮挡、I²C 地址冲突、电源等），返回 summary 与逐条 results（含 severity、code、blocking、suggestion）。ok:false 表示存在 error，但工具调用本身成功——结果就是你要的东西。注意：0 error 不等于电路已验证。',
      inputSchema: { file },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file: f }) => guarded(() => validateData(f, 'error'))
  );

  server.registerTool(
    'connectivity',
    {
      title: '查询孔位/端子导通',
      description: '查询一个孔或端子的导通关系：板内导通组（同列 a–e / f–j、电源轨分段）、所属网络与完整导通集合（孔与引脚）。地址格式 board.hole 或 component.pin。',
      inputSchema: { file, from: z.string().describe('孔地址 board.hole（如 bb1.a5）或端子 component.pin（如 mcu.GPIO5）') },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file: f, from }) => guarded(() => connectivityData(f, from))
  );

  server.registerTool(
    'build_steps',
    {
      title: '逐线搭建步骤',
      description: '按线号输出逐根接线步骤：两端孔位标签、颜色、线材类型、估算长度。用于照图搭建实物。',
      inputSchema: { file },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file: f }) => guarded(() => stepsData(f))
  );

  server.registerTool(
    'list_programs',
    {
      title: '列出程序与仿真配置',
      description: '列出设计中的程序（id、名称、目标主控、语言、行数，不含源码）与仿真配置、启动程序。',
      inputSchema: { file },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file: f }) => guarded(() => programsData(f))
  );

  server.registerTool(
    'export_design',
    {
      title: '导出 SVG / JSON',
      description: '导出布局图（SVG，含图例与标签）或规范化 JSON。内容直接返回，不写文件——需要文件时请调用方自己保存。',
      inputSchema: {
        file,
        format: z.enum(['svg', 'json']).optional().describe('默认 svg；json 为规范化设计文档'),
        title: z.string().optional().describe('SVG 标题（默认项目名）'),
        legend: z.boolean().optional().describe('SVG 是否绘制图例（默认 true）'),
        pin_labels: z.boolean().optional().describe('SVG 是否标注引脚名（默认 true）'),
        hole_labels: z.boolean().optional().describe('SVG 是否标注每个孔名（默认 false）')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file: f, format, title, legend, pin_labels, hole_labels }) =>
      guarded(() => exportDesignData(f, { format, title, legend, pinLabels: pin_labels, holeLabels: hole_labels }))
  );

  // ---- transactions (write only on explicit opt-in) ----------------------

  server.registerTool(
    'autowire',
    {
      title: '自动排线规划',
      description: '按目录引脚角色把外设接到主板：电源/地经电源轨、I²C 接总线引脚、信号接空闲 GPIO；规划器会利用电源轨、处理 I²C 地址冲突并报告无法连接的引脚。默认 dry-run 只报告；write:true 才写入。生成的是一份可核对的布局，不是电气仿真。',
      inputSchema: {
        file,
        host: z.string().describe('主板元件 ID（主控或电源模块）'),
        components: z.array(z.string()).optional().describe('外设元件 ID 列表（与 all 二选一）'),
        all: z.boolean().optional().describe('除主板外的全部元件'),
        write: writeFlag,
        out: z.string().optional().describe('输出文件（默认覆盖输入文件）'),
        supply_voltage_v: z.number().optional().describe('外设电压范围未知或有多种选择时优先使用的主板电压'),
        power_distribution: z.enum(['auto', 'rail', 'direct']).optional().describe('电源/地走电源轨或只在孔组间串接（默认 auto）'),
        route: z.enum(['auto', 'flat', 'elevated']).optional().describe('线材：auto 按长度/绕路选择（默认）、flat 硬质跳线、elevated 杜邦线'),
        net_intents: z.boolean().optional().describe('是否生成/更新 net_intents（默认 true）'),
        optimize: z.enum(['global', 'greedy']).optional().describe('global 全局搜索（默认，结果不劣于贪心）或 greedy 逐引脚贪心'),
        i2c_conflicts: z.enum(['bus_first', 'address_first', 'report']).optional().describe('同地址器件：先开第二条总线（默认）/ 先改可配置地址 / 只报告'),
        time_budget_ms: z.number().optional().describe('全局搜索时限（毫秒）'),
        place_suggestions: z.boolean().optional().describe('对最长飞线做有界重放置搜索并在 suggestions 里报告改进（会多做几次完整重排，慢；只建议不改设计）'),
        signal_pins: z.record(z.string(), z.string()).optional().describe('指定信号引脚，如 {"touch.IO": "GPIO4"}'),
        require_all: z.boolean().optional().describe('有引脚无法连接时整体失败、不写文件'),
        expected_revision: z.number().optional().describe('期望的 revision；文件已被别人改动时拒绝写入（错误码 3）'),
        expected_hash: z.string().optional().describe('期望的内容 hash')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (args) =>
      guarded(() =>
        autowireData(args.file, {
          host: args.host,
          ...(args.components ? { components: args.components } : {}),
          ...(args.all ? { all: true } : {}),
          ...(args.supply_voltage_v !== undefined ? { supply: args.supply_voltage_v } : {}),
          ...(args.power_distribution ? { power: args.power_distribution } : {}),
          ...(args.route ? { route: args.route } : {}),
          ...(args.net_intents !== undefined ? { intents: args.net_intents } : {}),
          ...(args.optimize ? { optimize: args.optimize } : {}),
          ...(args.i2c_conflicts ? { i2cConflicts: args.i2c_conflicts } : {}),
          ...(args.time_budget_ms !== undefined ? { timeBudget: args.time_budget_ms } : {}),
          ...(args.place_suggestions ? { placeSuggestions: true } : {}),
          ...(args.signal_pins ? { signalPins: args.signal_pins } : {}),
          ...(args.require_all ? { requireAll: true } : {}),
          ...(args.out ? { out: args.out } : {}),
          dryRun: args.write !== true,
          ...(args.expected_revision !== undefined ? { expectRevision: args.expected_revision } : {}),
          ...(args.expected_hash ? { expectHash: args.expected_hash } : {})
        })
      )
  );

  server.registerTool(
    'apply_patch',
    {
      title: '原子应用补丁',
      description: '原子应用结构化补丁 {expected_revision?, expected_hash?, ops:[...]}：结构错误会阻止整批应用，失败时不写文件。默认 dry-run 只报告；write:true 才写入。操作类型见 list_ops。',
      inputSchema: {
        file,
        patch: z.record(z.string(), z.unknown()).describe('补丁对象：{expected_revision?, expected_hash?, ops: [...]}（op 类型见 list_ops）'),
        write: writeFlag,
        out: z.string().optional().describe('输出文件（默认覆盖输入文件）'),
        force: z.boolean().optional().describe('即使存在 blocking 错误也写入（默认 false）'),
        expected_revision: z.number().optional().describe('覆盖补丁内的 expected_revision'),
        expected_hash: z.string().optional().describe('覆盖补丁内的 expected_hash')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ file: f, patch, write, out, force, expected_revision, expected_hash }) =>
      guarded(() =>
        applyPatchData(f, {
          patch,
          ...(out ? { out } : {}),
          dryRun: write !== true,
          ...(force ? { force: true } : {}),
          ...(expected_revision !== undefined ? { expectRevision: expected_revision } : {}),
          ...(expected_hash ? { expectHash: expected_hash } : {})
        })
      )
  );

  return server;
}

/**
 * Serve MCP over stdio. The process stays alive until the client closes stdin;
 * nothing is printed outside the protocol, so `bb mcp` is safe to embed in an
 * agent's config.
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
