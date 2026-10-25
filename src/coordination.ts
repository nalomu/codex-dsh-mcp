import type { Task } from './types.js';
export const workerInstructions = `You are an independent delegated worker. Keep detailed execution logs local. Communicate only meaningful progress, blockers, questions, and a concise final result. For each report output a fenced block exactly like:
\`\`\`bridge-message
{"kind":"progress","text":"short factual update"}
\`\`\`
Allowed kinds: progress, question, result. Keep each text under 1000 characters. A question must be the final report of this turn: stop work and end the turn to wait for a supervisor reply. A result should list changed files, tests, and remaining issues. Supervisor messages are delivered at turn boundaries, not by interrupting a running tool. Do not delegate, commit, or change permissions. Preserve existing edits.`;
export const taskDelimiter = '\n--- BRIDGE TASK ---\n';
export function workerPrompt(prompt: string) {
  return workerInstructions + taskDelimiter + prompt;
}
export interface Report {
  kind: 'progress' | 'question' | 'result';
  text: string;
}
export class ReportDecoder {
  private buffer = '';
  last?: Report;
  private count = 0;
  constructor(private emit: (report: Report) => void) {}
  write(text: string) {
    this.buffer += text;
    for (;;) {
      const start = this.buffer.indexOf('```bridge-message');
      if (start < 0) {
        this.buffer = this.buffer.slice(-20);
        return;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      const end = this.buffer.indexOf('```', 17);
      if (end < 0) {
        if (this.buffer.length > 16000) this.buffer = this.buffer.slice(-20);
        return;
      }
      const body = this.buffer.slice(17, end).trim();
      this.buffer = this.buffer.slice(end + 3);
      try {
        const report = JSON.parse(body);
        if (
          !['progress', 'question', 'result'].includes(report.kind) ||
          typeof report.text !== 'string' ||
          !report.text.trim()
        )
          continue;
        const next: Report = {
          kind: report.kind,
          text: report.text.slice(0, 1000),
        };
        if (this.last?.kind === next.kind && this.last.text === next.text)
          continue;
        this.last = next;
        if (++this.count <= 20 || next.kind !== 'progress') this.emit(next);
      } catch {
        /* Ordinary model text is not a coordination message. */
      }
    }
  }
}
export function conciseResult(text: string | undefined) {
  if (!text) return undefined;
  const decoder = new ReportDecoder(() => {});
  decoder.write(text);
  return (decoder.last?.text ?? text).slice(0, 1600);
}
export function compactTask(t: Task) {
  const round = t.rounds.at(-1);
  return {
    id: t.id,
    target: t.target,
    state: t.state,
    round: t.rounds.length,
    updatedAt: t.updatedAt,
    ...(round?.result ? { result: conciseResult(round.result) } : {}),
    ...(round?.error ? { error: round.error.slice(0, 1000) } : {}),
  };
}
