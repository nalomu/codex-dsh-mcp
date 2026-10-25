// Deterministic protocol peer; never contacts a model. Exercises real adapters.
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) {
  console.log(
    JSON.parse(
      readFileSync(
        new URL('../src/generated/codex-version.json', import.meta.url),
      ),
    ).version,
  );
  process.exit(0);
}
if (process.argv.includes('login')) {
  console.log('Logged in using fixture');
  process.exit(0);
}
const mode = process.argv[2];
let session = 'fixture-' + mode;
let count = 0;
let pendingPermission;
let promptRequest;
const send = (m) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const ok = (id, result = {}) => send({ id, result });
const update = (text) =>
  send({
    method: 'session/update',
    params: {
      sessionId: session,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  });
const finish = (id, text) => {
  if (mode === 'dsh') {
    update(text);
    ok(id, { stopReason: 'end_turn' });
  } else {
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: session, delta: text },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: session,
        turn: { id: 'turn-1', status: 'completed' },
      },
    });
  }
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 900) {
    if (mode === 'dsh') {
      if (m.result.outcome.optionId !== 'deny')
        throw new Error('permission accepted');
      ok(promptRequest, { stopReason: 'end_turn' });
    } else {
      if (m.result.decision !== 'decline')
        throw new Error('permission accepted');
      send({
        method: 'turn/completed',
        params: {
          threadId: session,
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: { message: 'Permission denied' },
          },
        },
      });
    }
    return;
  }
  if (m.method === 'initialize')
    return ok(
      m.id,
      mode === 'dsh'
        ? {
            protocolVersion: 1,
            agentCapabilities: {
              sessionCapabilities: { resume: {}, close: {} },
            },
            agentInfo: { name: 'fixture', version: '1' },
          }
        : { userAgent: 'fixture' },
    );
  if (['initialized', 'session/cancel'].includes(m.method)) return;
  if (m.method === 'mcpServerStatus/list')
    return ok(m.id, {
      data: process.env.INHERITED_MCP ? [{ name: 'bad' }] : [],
      nextCursor: null,
    });
  if (
    ['session/new', 'thread/start', 'session/resume', 'thread/resume'].includes(
      m.method,
    )
  ) {
    if (mode === 'dsh' && m.params.mcpServers.length)
      throw new Error('child inherited MCP');
    if (mode === 'codex' && m.params.config.features.multi_agent !== false)
      throw new Error('child agent enabled');
    if (m.method.endsWith('/resume')) {
      session = m.params.sessionId ?? m.params.threadId;
      count = Number(readFileSync('.fixture-count', 'utf8'));
    }
    return ok(
      m.id,
      mode === 'dsh'
        ? {
            sessionId: session,
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                type: 'select',
                currentValue: JSON.stringify(['test', 'test']),
                options: [
                  { value: JSON.stringify(['test', 'test']), name: 'Test' },
                ],
              },
            ],
          }
        : { thread: { id: session } },
    );
  }
  if (m.method === 'session/close') return ok(m.id, {});
  if (['session/prompt', 'turn/start'].includes(m.method)) {
    let prompt =
      mode === 'dsh' ? m.params.prompt[0].text : m.params.input[0].text;
    if (prompt.includes('\n--- BRIDGE TASK ---\n'))
      prompt = prompt.split('\n--- BRIDGE TASK ---\n').at(-1);
    promptRequest = m.id;
    if (mode === 'codex') ok(m.id, { turn: { id: 'turn-1' } });
    if (prompt === 'permission')
      return send({
        id: 900,
        method:
          mode === 'dsh'
            ? 'session/request_permission'
            : 'item/commandExecution/requestApproval',
        params:
          mode === 'dsh'
            ? {
                sessionId: session,
                toolCall: { toolCallId: 'x', title: 'elevate' },
                options: [
                  { kind: 'reject_once', optionId: 'deny', name: 'deny' },
                ],
              }
            : { threadId: session, command: 'blocked' },
      });
    if (prompt === 'hang') {
      spawn(
        process.execPath,
        [
          '-e',
          "setTimeout(()=>require('fs').writeFileSync('escaped.txt','bad'),3000);setInterval(()=>{},1000)",
        ],
        { stdio: 'ignore' },
      );
      return;
    }
    count++;
    if (prompt === 'observe') {
      if (mode === 'dsh') {
        send({
          method: 'session/update',
          params: {
            sessionId: session,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'visible-command',
              title: 'node test',
              kind: 'execute',
              status: 'in_progress',
              rawInput: { command: 'node --test' },
            },
          },
        });
        send({
          method: 'session/update',
          params: {
            sessionId: session,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'visible-command',
              status: 'completed',
              rawOutput: {
                stdout: '4 passed',
                apiKey: 'fixture-progress-private-key',
              },
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: '4 passed' },
                },
              ],
            },
          },
        });
      } else {
        send({
          method: 'item/started',
          params: {
            threadId: session,
            item: {
              type: 'commandExecution',
              id: 'visible-command',
              command: 'node --test',
              cwd: process.cwd(),
              status: 'inProgress',
            },
          },
        });
        send({
          method: 'item/completed',
          params: {
            threadId: session,
            item: {
              type: 'commandExecution',
              id: 'visible-command',
              command: 'node --test',
              status: 'completed',
              aggregatedOutput: '4 passed',
              exitCode: 0,
            },
          },
        });
      }
    }
    writeFileSync('.fixture-count', String(count));
    writeFileSync('result.txt', `${mode}:${count}`);
    setTimeout(
      () => finish(m.id, `completed ${mode} round ${count}`),
      prompt === 'slow' ? 500 : 20,
    );
    return;
  }
  if (m.id !== undefined) ok(m.id, {});
});
setInterval(() => {}, 1000);
