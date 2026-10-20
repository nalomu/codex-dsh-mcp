export type Caller = 'codex' | 'dsh';
export type State =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export const terminal = (s: State) => !['queued', 'running'].includes(s);
export interface GitSnapshot {
  available: boolean;
  status?: string;
  diffStat?: string;
  head?: string;
  warning: string;
}
export interface Round {
  number: number;
  key?: string;
  prompt: string;
  state: State;
  startedAt?: string;
  endedAt?: string;
  result?: string;
  error?: string;
  before?: GitSnapshot;
  after?: GitSnapshot;
}
export interface Task {
  id: string;
  caller: Caller;
  target: Caller;
  cwd: string;
  lockRoot: string;
  key: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  state: State;
  sessionId?: string;
  workerPid?: number;
  rounds: Round[];
}
export interface Progress {
  seq: number;
  taskId: string;
  round: number;
  kind: string;
  data: unknown;
  at: string;
}
export interface Execution {
  cwd: string;
  sessionId?: string;
  prompt: string;
  signal: AbortSignal;
  emit(kind: string, data: unknown): void;
  session(id: string): void;
  worker(pid: number): void;
}
export interface Executor {
  run(input: Execution): Promise<string>;
}
export interface RuntimeConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface Config {
  port: number;
  allowedRoots: string[];
  stateDir: string;
  tokens: Record<Caller, string>;
  codex: RuntimeConfig & { model?: string; sourceHome: string };
  dsh: RuntimeConfig & {
    provider: string;
    model: string;
    sourceHome: string;
    modules: string;
  };
  taskTimeoutMs: number;
}
