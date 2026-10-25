import { Readable, Writable } from 'node:stream';
import {
  ClientApp,
  ndJsonStream,
  PROTOCOL_VERSION,
  type NewSessionResponse,
  type PromptResponse,
  type ClientConnection,
} from '@agentclientprotocol/sdk';
import { ManagedProcess } from '../process.js';
import { prepareDsh, dshSandboxMode } from '../runtime.js';
import { withDeadline } from '../deadline.js';
import { dshPermissionGuard } from '../dsh-permission.js';
import { executionDetails } from '../progress.js';
import { workerPrompt } from '../coordination.js';
import type { Config, Executor, Execution } from '../types.js';
export class DshExecutor implements Executor {
  constructor(
    readonly config: Config,
    readonly redact: (v: unknown) => string,
  ) {}
  async run(input: Execution) {
    const home = await prepareDsh(this.config, input.cwd);
    const permission = dshPermissionGuard(this.config);
    const proc = new ManagedProcess(
      {
        ...this.config.dsh,
        args: [...this.config.dsh.args, '--profile', 'acp'],
      },
      input.cwd,
      { DSH_HOME: home, DSH_PERMISSION_MODE: dshSandboxMode(this.config) },
      this.redact,
      (s) => {
        permission.stderr(s);
        input.emit('stderr', s);
      },
    );
    input.worker(proc.pid);
    let result = '';
    let denied = false;
    let activeSession = input.sessionId;
    let cancelTimer: NodeJS.Timeout | undefined;
    const app = new ClientApp();
    app.onRequest('session/request_permission', ({ params }) => {
      denied = true;
      input.emit('permission_denied', {
        tool: params.toolCall?.title ?? 'unknown',
        reason: 'Extra permissions are denied',
      });
      const reject = params.options.find(
        (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
      );
      return {
        outcome: reject
          ? { outcome: 'selected', optionId: reject.optionId }
          : { outcome: 'cancelled' },
      };
    });
    app.onNotification('session/update', ({ params: p }) => {
      const u = p.update;
      if (
        u.sessionUpdate === 'agent_message_chunk' &&
        u.content.type === 'text'
      ) {
        result += u.content.text;
        input.emit('message', u.content.text);
      } else if (
        u.sessionUpdate === 'tool_call' ||
        u.sessionUpdate === 'tool_call_update'
      )
        input.emit('tool', {
          id: u.toolCallId,
          ...('title' in u ? { title: u.title } : {}),
          ...('status' in u ? { status: u.status } : {}),
          ...executionDetails(
            {
              ...('kind' in u ? { kind: u.kind } : {}),
              ...('rawInput' in u ? { input: u.rawInput } : {}),
              ...('rawOutput' in u ? { output: u.rawOutput } : {}),
              ...('content' in u ? { content: u.content } : {}),
              ...('locations' in u ? { locations: u.locations } : {}),
            },
            this.redact,
          ),
        });
    });
    let cx: ClientConnection | undefined;
    const abort = () => {
      const stop = () => {
        cx?.close(new Error('TASK_ABORTED'));
        void proc.stop().catch(() => {});
      };
      if (cx && activeSession) {
        void cx.agent
          .notify('session/cancel', { sessionId: activeSession })
          .catch(() => {});
        cancelTimer = setTimeout(stop, 2000);
      } else stop();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal.aborted) throw input.signal.reason;
      cx = app.connect(
        ndJsonStream(
          Writable.toWeb(proc.child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(proc.child.stdout) as ReadableStream<Uint8Array>,
        ),
      );
      const agent = cx.agent;
      const init = await withDeadline(
        agent.request(
          'initialize',
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: 'codex-dsh-bridge', version: '0.1.0' },
          },
          { cancellationSignal: input.signal },
        ),
        30000,
        'ACP_INITIALIZE_TIMEOUT',
      );
      if (init.protocolVersion !== 1)
        throw new Error('ACP_VERSION_UNSUPPORTED');
      const common = { cwd: input.cwd, mcpServers: [] };
      if (input.sessionId) {
        await withDeadline(
          agent.request('session/resume', {
            ...common,
            sessionId: input.sessionId,
          }),
          30000,
          'ACP_RESUME_TIMEOUT',
        );
      }
      const created = input.sessionId
        ? undefined
        : await withDeadline(
            agent.request<NewSessionResponse>('session/new', common),
            30000,
            'ACP_CREATE_TIMEOUT',
          );
      if (
        created &&
        created.configOptions?.find((o) => o.id === 'model')?.currentValue !==
          JSON.stringify([this.config.dsh.provider, this.config.dsh.model])
      )
        throw new Error('DSH_MODEL_CONFIGURATION_MISMATCH');
      const sessionId = input.sessionId ?? created!.sessionId;
      activeSession = sessionId;
      input.session(sessionId);
      // Auto mode is usable only after the helper confirmed a session was
      // published with the official reviewer active. A missing acknowledgement
      // fails the task before any prompt is sent; it never downgrades silently.
      await permission.verify();
      const prompt = await agent.request<PromptResponse>(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: workerPrompt(input.prompt) }],
        },
        { cancellationSignal: input.signal },
      );
      await withDeadline(
        agent.request('session/close', { sessionId }),
        10000,
        'ACP_CLOSE_TIMEOUT',
      );
      if (denied)
        throw new Error(
          'PERMISSION_DENIED: DSH requested additional permission; inspect task events and files',
        );
      if (prompt.stopReason !== 'end_turn')
        throw new Error(`DSH_STOPPED: ${prompt.stopReason}`);
      return result;
    } finally {
      clearTimeout(cancelTimer);
      input.signal.removeEventListener('abort', abort);
      cx?.close();
      await proc.stop();
    }
  }
}
