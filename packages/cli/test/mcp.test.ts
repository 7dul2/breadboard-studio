import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMcpServer } from '../src/mcp.js';

const root = resolve(import.meta.dirname, '..', '..', '..');
const examples = join(root, 'examples');
const envNode = join(examples, 'environment_node.breadboard.json');

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bb-mcp-'));
});

/** Connect a real client to a real server over an in-memory transport pair. */
async function withClient(fn: (client: Client) => Promise<void>) {
  const server = createMcpServer();
  const client = new Client({ name: 'bb-mcp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

interface ToolReply {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

/** The JSON body every tool returns as its single text content block. */
function body(reply: ToolReply): Record<string, unknown> {
  return JSON.parse(reply.content[0]!.text!);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolReply;
}

/** A throwaway copy of an example, so write tests never touch the repository. */
function fixture(name: string): string {
  const target = join(work, `${name}-${Math.random().toString(36).slice(2)}.breadboard.json`);
  copyFileSync(join(examples, name), target);
  return target;
}

describe('bb mcp', () => {
  it('completes the initialize handshake and lists every tool', async () => {
    await withClient(async (client) => {
      expect(client.getServerVersion()?.name).toBe('breadboard-studio');
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'apply_patch',
        'autowire',
        'build_steps',
        'catalog_inspect',
        'catalog_list',
        'connectivity',
        'design_inspect',
        'design_validate',
        'export_design',
        'list_ops',
        'list_programs'
      ]);
      // The write-capable tools must not advertise themselves as read-only.
      const readOnly = (n: string) => tools.find((t) => t.name === n)!.annotations?.readOnlyHint;
      expect(readOnly('design_validate')).toBe(true);
      expect(readOnly('catalog_list')).toBe(true);
      expect(readOnly('apply_patch')).toBe(false);
      expect(readOnly('autowire')).toBe(false);
      // Every tool documents itself and has a schema.
      for (const t of tools) {
        expect(t.description && t.description.length).toBeTruthy();
        expect(t.inputSchema.type).toBe('object');
      }
    });
  });

  it('catalog tools return the same JSON as the CLI, and refusals are tool errors', async () => {
    await withClient(async (client) => {
      const list = body(await call(client, 'catalog_list'));
      expect(list.ok).toBe(true);
      expect(list.command).toBe('catalog.list');
      const refs = (list.items as { ref: string }[]).map((i) => i.ref);
      expect(refs).toContain('xiao_esp32s3_sense@1');
      expect(refs).toContain('breadboard_830@1');

      const inspect = body(await call(client, 'catalog_inspect', { ref: 'xiao_esp32s3_sense@1' }));
      expect(inspect.command).toBe('catalog.inspect');
      expect((inspect.definition as { pins: unknown[] }).pins.length).toBe(14);

      const missing = await call(client, 'catalog_inspect', { ref: 'nope@1' });
      expect(missing.isError).toBe(true);
      const err = body(missing).error as { code: number; message: string };
      expect(err.code).toBe(2);
      expect(err.message).toContain('nope@1');
    });
  });

  it('design_validate reports both a clean example and the short-circuit counterexample', async () => {
    await withClient(async (client) => {
      const good = body(await call(client, 'design_validate', { file: envNode }));
      expect(good.ok).toBe(true);
      expect((good.summary as { error: number }).error).toBe(0);

      const bad = await call(client, 'design_validate', { file: join(examples, 'invalid', 'short_power_ground.breadboard.json') });
      // A design with errors is a *successful* tool call: the results are the point.
      expect(bad.isError).toBeFalsy();
      const report = body(bad);
      expect(report.ok).toBe(false);
      const results = report.results as { code: string; severity: string; suggestion: string | null }[];
      const short = results.find((r) => r.code === 'power_ground_short');
      expect(short?.severity).toBe('error');
      expect(short?.suggestion).toBeTruthy();
    });
  });

  it('connectivity derives an address from design_inspect and rejects unknown ones', async () => {
    await withClient(async (client) => {
      const design = body(await call(client, 'design_inspect', { file: envNode }));
      const boardId = (design.boards as { id: string }[])[0]!.id;
      const ok = body(await call(client, 'connectivity', { file: envNode, from: `${boardId}.a1` }));
      expect(ok.group as string[]).toContain(`${boardId}.a1`);
      expect(ok.command).toBe('connectivity');

      const bad = await call(client, 'connectivity', { file: envNode, from: 'nope.z9' });
      expect(bad.isError).toBe(true);
      const err = body(bad).error as { code: number; message: string };
      expect(err.code).toBe(2);
      expect(err.message).toContain('nope.z9');
    });
  });

  it('apply_patch defaults to dry-run, writes only with write:true, and refuses stale revisions', async () => {
    await withClient(async (client) => {
      const file = fixture('desk_device.breadboard.json');
      const before = readFileSync(file, 'utf8');
      const design = body(await call(client, 'design_inspect', { file }));
      const revision = design.revision as number;
      const patch = { ops: [{ op: 'set_metadata', patch: { notes: 'from mcp test' } }] };

      const planned = body(await call(client, 'apply_patch', { file, patch }));
      expect(planned.dry_run).toBe(true);
      expect(planned.out).toBeNull();
      expect(planned.previous_revision).toBe(revision);
      expect(readFileSync(file, 'utf8')).toBe(before); // dry-run touched nothing

      const written = body(await call(client, 'apply_patch', { file, patch, write: true, expected_revision: revision }));
      expect(written.dry_run).toBe(false);
      expect(written.revision).toBe(revision + 1);
      const after = readFileSync(file, 'utf8');
      expect(after).not.toBe(before);
      expect(after).toContain('from mcp test');

      // The stale revision is now refused with the CLI's conflict code.
      const conflict = await call(client, 'apply_patch', { file, patch, write: true, expected_revision: revision });
      expect(conflict.isError).toBe(true);
      const err = body(conflict).error as { code: number; message: string };
      expect(err.code).toBe(3);
      expect(err.message.length).toBeGreaterThan(0);
      expect(readFileSync(file, 'utf8')).toBe(after); // a refused write left the file alone
    });
  });

  it('autowire plans by pin role and leaves the file untouched unless told to write', async () => {
    await withClient(async (client) => {
      const file = fixture('touch_display.breadboard.json');
      const design = body(await call(client, 'design_inspect', { file }));
      const components = design.components as { id: string; model: string }[];
      const host = components.find((c) => c.model.startsWith('esp32s3'))!.id;
      const peripherals = components.filter((c) => c.id !== host).map((c) => c.id);

      // Strip every wire first (through a real write transaction), so the planner
      // has something to plan rather than reporting it all as already connected.
      const wires = design.wires as { id: string }[];
      expect(wires.length).toBeGreaterThan(0);
      const stripped = body(await call(client, 'apply_patch', { file, patch: { ops: wires.map((w) => ({ op: 'remove_wire', id: w.id })) }, write: true }));
      expect((stripped.summary as { error: number }).error).toBe(0);
      const empty = readFileSync(file, 'utf8');

      const planned = body(await call(client, 'autowire', { file, host, components: peripherals }));
      expect(planned.command).toBe('autowire');
      expect(planned.dry_run).toBe(true);
      const plan = planned.plan as { host: string; connections: unknown[]; bridges: unknown[]; optimization: unknown };
      expect(plan.host).toBe(host);
      expect(plan.connections.length).toBeGreaterThan(0);
      expect(plan.bridges.length).toBeGreaterThan(0);
      expect(plan.optimization).toBeTruthy();
      expect(readFileSync(file, 'utf8')).toBe(empty); // planning alone touched nothing
    });
  });

  it('export_design returns SVG and canonical JSON inline without writing files', async () => {
    await withClient(async (client) => {
      const svg = body(await call(client, 'export_design', { file: envNode }));
      expect(svg.format).toBe('svg');
      expect(svg.content as string).toContain('<svg');
      expect(svg.bytes as number).toBeGreaterThan(1000);

      const asJson = body(await call(client, 'export_design', { file: envNode, format: 'json' }));
      const design = JSON.parse(asJson.content as string) as { metadata: { revision: number } };
      expect(asJson.format).toBe('json');
      // The exported bytes are the same document validate hashed.
      const validated = body(await call(client, 'design_validate', { file: envNode }));
      const inspected = body(await call(client, 'design_inspect', { file: envNode }));
      expect(design.metadata.revision).toBe(inspected.revision);
      expect(validated.hash).toBe(inspected.hash);
    });
  });

  it('list_ops and build_steps expose the patch vocabulary and the wiring order', async () => {
    await withClient(async (client) => {
      const ops = body(await call(client, 'list_ops'));
      const names = (ops.ops as { op: string }[]).map((o) => o.op);
      expect(names).toContain('auto_wire');
      expect(names).toContain('add_wire');
      expect(names).toContain('replace_design');

      const steps = body(await call(client, 'build_steps', { file: envNode }));
      expect(steps.count as number).toBeGreaterThan(0);
      const first = (steps.steps as { index: number; from_label: string; to_label: string }[])[0]!;
      expect(first.index).toBe(1);
      expect(first.from_label).toBeTruthy();
      expect(first.to_label).toBeTruthy();
      expect(steps.note as string).toContain('不代表实物已经导通');
    });
  });
});
