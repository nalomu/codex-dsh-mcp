import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const cmd = process.env.CODEX_BIN ?? 'codex';
const version = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) throw new Error(version.stderr);
const result = spawnSync(
  cmd,
  ['app-server', 'generate-ts', '--out', 'src/generated/codex'],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
writeFileSync(
  'src/generated/codex-version.json',
  JSON.stringify(
    { version: version.stdout.trim(), generatedAt: new Date().toISOString() },
    null,
    2,
  ) + '\n',
);
