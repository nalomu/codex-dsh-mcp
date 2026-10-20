import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod/v4';
import type { Config, Caller } from './types.js';
import type { Manager } from './manager.js';
const id = z.string().uuid();
const cursor = z.number().int().nonnegative().default(0);
const key = z.string().min(1).max(200);
const prompt = z.string().min(1).max(100000);
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function mcpFactory(manager: Manager, caller: Caller) {
  return () => {
    const server = new McpServer(
      { name: 'codex-dsh-bridge', version: '0.1.0' },
      {
        instructions:
          'Delegate only user-authorized work. Tasks directly edit a shared directory. Stop editing that project while a delegated task is queued or running. Use agent_wait until terminal, inspect real diff and tests, then continue the same task if needed. Execution completion does not imply acceptance. Delegated sessions cannot delegate again.',
      },
    );
    const tool = (
      name: string,
      description: string,
      inputSchema: z.ZodObject,
      fn: (a: any) => unknown,
    ) =>
      server.registerTool(name, { description, inputSchema }, async (args) => {
        try {
          const result = await fn(args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: manager.redact(String(e)) },
            ],
          };
        }
      });
    tool(
      'agent_run',
      'Create an independent task on the other agent. Returns immediately; idempotencyKey prevents duplicate work.',
      z.object({ prompt, cwd: z.string(), idempotencyKey: key }).strict(),
      (a) =>
        manager
          .run(caller, a.prompt, a.cwd, a.idempotencyKey)
          .then((task) => ({ task })),
    );
    tool(
      'agent_status',
      'Read task state, result, snapshots and paginated events. Only this caller owns its tasks.',
      z
        .object({
          taskId: id,
          after: cursor,
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict(),
      (a) => manager.status(caller, a.taskId, a.after, a.limit),
    );
    tool(
      'agent_wait',
      'Wait at most 25 seconds for new events or terminal state. Waiting cancellation does not cancel execution.',
      z
        .object({
          taskId: id,
          after: cursor,
          timeoutMs: z.number().int().min(0).max(25000).default(25000),
        })
        .strict(),
      (a) => manager.wait(caller, a.taskId, a.after, a.timeoutMs),
    );
    tool(
      'agent_continue',
      'Append a new round to the same execution session once idle. Inspect existing edits first.',
      z.object({ taskId: id, prompt, idempotencyKey: key }).strict(),
      (a) =>
        manager
          .continue(caller, a.taskId, a.prompt, a.idempotencyKey)
          .then((task) => ({ task })),
    );
    tool(
      'agent_cancel',
      'Cancel queued or running work and wait until its worker process group has stopped.',
      z.object({ taskId: id }).strict(),
      (a) => manager.cancel(caller, a.taskId).then((task) => ({ task })),
    );
    tool(
      'agent_list',
      'List tasks created by this caller, in creation order.',
      z
        .object({ cursor, limit: z.number().int().min(1).max(100).default(20) })
        .strict(),
      (a) => manager.store.list(caller, a.cursor, a.limit),
    );
    return server;
  };
}
export async function serve(config: Config, manager: Manager) {
  const handlers = {
    codex: createMcpHandler(mcpFactory(manager, 'codex')),
    dsh: createMcpHandler(mcpFactory(manager, 'dsh')),
  };
  const nodes = {
    codex: toNodeHandler(handlers.codex, { maxRequestBodySize: 256 * 1024 }),
    dsh: toNodeHandler(handlers.dsh, { maxRequestBodySize: 256 * 1024 }),
  };
  const server = createServer((req, res) => {
    const fail = (code: number, message: string) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: message }));
    };
    if (
      ![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(
        req.headers.host ?? '',
      )
    )
      return fail(403, 'Invalid Host');
    if (
      req.headers.origin !== undefined &&
      ![
        'http://127.0.0.1:' + config.port,
        'http://localhost:' + config.port,
      ].includes(req.headers.origin)
    )
      return fail(403, 'Invalid Origin');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'codex-dsh-bridge',
          version: '0.1.0',
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/admin/stop') {
      if (
        !equal(req.headers.authorization ?? '', `Bearer ${config.tokens.codex}`)
      )
        return fail(401, 'Unauthorized');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stopping: true }));
      setImmediate(() => server.emit('bridge-stop'));
      return;
    }
    const caller =
      req.url === '/mcp/codex'
        ? 'codex'
        : req.url === '/mcp/dsh'
          ? 'dsh'
          : undefined;
    if (!caller) return fail(404, 'Not found');
    if (
      !equal(req.headers.authorization ?? '', `Bearer ${config.tokens[caller]}`)
    )
      return fail(401, 'Unauthorized');
    void nodes[caller](req, res).catch((e) => {
      if (!res.headersSent) fail(500, manager.redact(String(e)));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    async close() {
      server.closeIdleConnections();
      await manager.close();
      await Promise.all([handlers.codex.close(), handlers.dsh.close()]);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
