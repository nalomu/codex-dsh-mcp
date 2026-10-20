// Opt-in real inference in a new temporary Git project. Never touches business repositories.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { Manager } from '../dist/manager.js';
import { CodexExecutor } from '../dist/adapters/codex.js';
import { DshExecutor } from '../dist/adapters/dsh.js';
import { redactor, exec } from '../dist/security.js';
const base = await loadConfig(process.argv[2]);
const root = resolve('work/live');
await mkdir(root, { recursive: true });
const cwd = await mkdtemp(join(root, 'project-'));
await exec('git', ['init', '-q', cwd]);
await writeFile(join(cwd, 'dirty.txt'), 'pre-existing user edit\n');
await writeFile(
  join(cwd, 'package.json'),
  JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
);
const config = { ...base, allowedRoots: [cwd], taskTimeoutMs: 180000 };
const redact = redactor([
  ...Object.values(config.tokens),
  ...Object.values(config.codex.env),
  ...Object.values(config.dsh.env),
]);
const store = new Store(join(cwd, 'tasks.sqlite'));
const m = new Manager(
  store,
  [cwd],
  {
    codex: new CodexExecutor(config, redact),
    dsh: new DshExecutor(config, redact),
  },
  redact,
  config.taskTimeoutMs,
);
const report = { at: new Date().toISOString(), cwd, results: [] };
async function wait(caller, id) {
  let after = 0;
  for (;;) {
    const s = await m.wait(caller, id, after, 1000);
    after = s.nextCursor;
    if (!['queued', 'running'].includes(s.task.state)) return s.task;
  }
}
try {
  for (const caller of ['codex', 'dsh']) {
    const file = caller === 'codex' ? 'dsh-probe' : 'codex-probe';
    console.log(
      `Live ${caller} → ${caller === 'codex' ? 'dsh' : 'codex'}: starting`,
    );
    const prompt = `Work only in this temporary Git project. Preserve dirty.txt and other existing files. Do not delegate, commit or install dependencies. Create ${file}.js exporting function add(a,b) that returns a+b, plus ${file}.test.js using node:test and node:assert/strict to test positive and negative numbers. Run node --test ${file}.test.js. Return changed files and test outcome.`;
    let task = await m.run(caller, prompt, cwd, 'live-' + caller);
    task = await wait(caller, task.id);
    const item = {
      caller,
      target: task.target,
      taskId: task.id,
      state: task.state,
      rounds: task.rounds.map((r) => ({
        state: r.state,
        result: r.result,
        error: r.error,
      })),
    };
    report.results.push(item);
    if (task.state === 'succeeded') {
      try {
        await exec(process.execPath, ['--test', `${file}.test.js`], {
          cwd,
          timeout: 15000,
        });
        await m.continue(
          caller,
          task.id,
          `Continue in the same session. Add export subtract(a,b) returning a-b to ${file}.js and add positive/negative subtraction tests to ${file}.test.js. Preserve dirty.txt and all unrelated edits. Run node --test ${file}.test.js and report the results. Do not delegate or commit.`,
          'followup',
        );
        task = await wait(caller, task.id);
        item.state = task.state;
        item.rounds = task.rounds.map((r) => ({
          state: r.state,
          result: r.result,
          error: r.error,
        }));
        if (task.state === 'succeeded') {
          const tests = await exec(
            process.execPath,
            ['--test', `${file}.test.js`],
            { cwd, timeout: 15000 },
          );
          await exec(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `import{add,subtract}from'./${file}.js';if(add(-1,2)!==1||subtract(2,5)!==-3)throw Error('bad result')`,
            ],
            { cwd, timeout: 15000 },
          );
          item.hostVerification = tests.stdout;
        }
      } catch (e) {
        item.hostError = redact(String(e));
        item.state = 'failed';
      }
    }
    item.dirtyPreserved =
      (await readFile(join(cwd, 'dirty.txt'), 'utf8')) ===
      'pre-existing user edit\n';
    console.log(`${caller}: ${item.state}`);
  }
} finally {
  await m.close();
  store.close();
  const path = resolve('work/live-report.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`Report: ${path}`);
  if (
    report.results.length !== 2 ||
    report.results.some(
      (r) =>
        r.state !== 'succeeded' || !r.dirtyPreserved || r.rounds.length !== 2,
    )
  )
    process.exitCode = 1;
}
