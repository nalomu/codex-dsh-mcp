import { ManagedProcess, Rpc } from '../process.js';
import { prepareCodex } from '../runtime.js';
import type { Config, Executor, Execution } from '../types.js';
import type { ThreadStartParams } from '../generated/codex/v2/ThreadStartParams.js';
import type { TurnStartParams } from '../generated/codex/v2/TurnStartParams.js';
import { executionDetails } from '../progress.js';
import { workerInstructions } from '../coordination.js';
export class CodexExecutor implements Executor {
  constructor(
    readonly config: Config,
    readonly redact: (v: unknown) => string,
  ) {}
  async run(input: Execution) {
    const home = await prepareCodex(this.config);
    const proc = new ManagedProcess(
      {
        ...this.config.codex,
        args: [
          ...this.config.codex.args,
          'app-server',
          '-c',
          'mcp_servers={}',
          '-c',
          'approval_policy="never"',
          '-c',
          'sandbox_mode="workspace-write"',
          '-c',
          'features.multi_agent=false',
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
        ],
      },
      input.cwd,
      { CODEX_HOME: home },
      this.redact,
      (s) => input.emit('stderr', s),
    );
    input.worker(proc.pid);
    const rpc = new Rpc(proc);
    let sessionId = input.sessionId;
    let result = '';
    let finished = false;
    let turnId: string | undefined;
    let cancelTimer: NodeJS.Timeout | undefined;
    let permissionDenied = false;
    let rejectDone: (e: Error) => void = () => {};
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => {});
    rpc.onRequest = (method, params) => {
      permissionDenied = true;
      input.emit('permission_denied', {
        method,
        reason: 'Extra permissions and interactive requests are disabled',
      });
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      )
        return { decision: 'decline' };
      if (method === 'execCommandApproval') return { decision: 'denied' };
      if (method === 'applyPatchApproval') return { decision: 'denied' };
      throw new Error('PERMISSION_DENIED: unsupported interactive request');
    };
    rpc.onNotification = (method, p) => {
      if (p?.threadId && sessionId && p.threadId !== sessionId) return;
      if (method === 'item/agentMessage/delta') {
        result += p.delta ?? '';
        input.emit('message', p.delta ?? '');
      } else if (
        method === 'item/completed' &&
        p.item?.type === 'agentMessage' &&
        !result
      ) {
        result = p.item.text ?? '';
        input.emit('message', result);
      } else if (method === 'turn/completed') {
        finished = true;
        if (p.turn?.status === 'completed' && !permissionDenied) resolveDone();
        else
          rejectDone(
            new Error(
              `CODEX_TURN_${p.turn?.status}: ${p.turn?.error?.message ?? ''}`,
            ),
          );
      } else if (method === 'error') {
        input.emit('executor_error', p);
        if (p?.willRetry !== true)
          rejectDone(
            new Error(`CODEX_ERROR: ${p?.error?.message ?? 'unknown'}`),
          );
      } else if (method === 'item/started' || method === 'item/completed')
        input.emit(method, {
          type: p.item?.type,
          id: p.item?.id,
          status: p.item?.status,
          ...([
            'commandExecution',
            'fileChange',
            'mcpToolCall',
            'dynamicToolCall',
          ].includes(p.item?.type)
            ? executionDetails(p.item, this.redact)
            : {}),
        });
    };
    proc.child.stdout.once('end', () => {
      if (!finished) rejectDone(new Error('CODEX_DISCONNECTED'));
    });
    const abort = () => {
      const stop = () => {
        rpc.fail(new Error('TASK_ABORTED'));
        rejectDone(new Error('TASK_ABORTED'));
        void proc.stop().catch(() => {});
      };
      if (sessionId && turnId) {
        void rpc
          .request('turn/interrupt', { threadId: sessionId, turnId }, 2000)
          .catch(() => {});
        cancelTimer = setTimeout(stop, 2000);
      } else stop();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal.aborted) throw input.signal.reason;
      await rpc.request('initialize', {
        clientInfo: { name: 'codex_dsh_bridge', version: '0.1.0' },
      });
      rpc.notify('initialized');
      const params: ThreadStartParams = {
        cwd: input.cwd,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
        config: {
          mcp_servers: {},
          features: { multi_agent: false, apps: false, plugins: false },
        },
        developerInstructions:
          workerInstructions + ' Do not reset, revert, clean or merge.',
      };
      const response = sessionId
        ? await rpc.request('thread/resume', {
            ...params,
            threadId: sessionId,
            excludeTurns: true,
          })
        : await rpc.request('thread/start', params);
      sessionId = response.thread.id;
      input.session(sessionId!);
      // Defense in depth: never start a turn if any MCP server was inherited.
      const mcp = await rpc.request('mcpServerStatus/list', {
        threadId: sessionId,
      });
      if ((mcp.data ?? []).length)
        throw new Error(
          'NESTED_DELEGATION_DENIED: child inherited MCP servers',
        );
      const turn: TurnStartParams = {
        threadId: sessionId!,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        approvalPolicy: 'never',
      };
      const started = await rpc.request('turn/start', turn);
      turnId = started.turn.id;
      if (input.signal.aborted) abort();
      await done;
      return result;
    } finally {
      clearTimeout(cancelTimer);
      input.signal.removeEventListener('abort', abort);
      rpc.fail(new Error('EXECUTOR_CLOSED'));
      await proc.stop();
    }
  }
}
