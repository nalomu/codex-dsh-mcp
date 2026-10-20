import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
const r = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
  stdio: 'inherit',
});
if (r.status !== 0) process.exit(r.status ?? 1);
copyFileSync(
  'src/generated/codex-version.json',
  'dist/generated/codex-version.json',
);
