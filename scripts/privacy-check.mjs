/** Scan the staged/tracked snapshot, never runtime directories or secret values
 * in diagnostics. Optional --secrets-file accepts a local JSON string array. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) throw new Error('Git inspection failed');
  return result.stdout;
}
const paths = git(['ls-files', '-z'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
if (!paths.length)
  throw new Error('Privacy check requires a nonempty Git index');
const secretArg = process.argv.indexOf('--secrets-file');
const secrets =
  secretArg < 0
    ? []
    : JSON.parse(readFileSync(process.argv[secretArg + 1], 'utf8'));
if (
  !Array.isArray(secrets) ||
  secrets.some((value) => typeof value !== 'string' || value.length < 6)
)
  throw new Error('Expected a local JSON array of nonempty secret strings');
const issues = [];
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'GitHub token',
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  ],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['bearer credential', /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/i],
  ['personal macOS volume', /\/Volumes\/[A-Za-z0-9_. -]+\//],
  ['personal temporary path', /\/(?:private\/)?var\/folders\/[A-Za-z0-9_/-]+/],
  [
    'personal Windows home',
    /[A-Za-z]:[\\/]+Users[\\/]+(?!you[\\/]|user[\\/]|username[\\/]|example[\\/]|<user>[\\/])[^\\/\s"']+[\\/]/i,
  ],
  [
    'Windows temporary path',
    /[A-Za-z]:[\\/]+(?:Windows[\\/]+Temp|[^\r\n"']*AppData[\\/]+Local[\\/]+Temp)[\\/]/i,
  ],
];
for (const path of paths) {
  if (
    /(?:^|\/)(?:\.bridge|node_modules|dist|work|evidence|\.env(?:\..*)?)(?:\/|$)/.test(
      path,
    ) ||
    /(?:\.sqlite(?:-.*)?|\.pem|\.key)$/.test(path) ||
    path === 'INSTALLATION.md'
  ) {
    issues.push([path, 'runtime/private file']);
    continue;
  }
  const entry = git(['ls-files', '--stage', '--', path]).toString('utf8');
  if (entry.startsWith('120000 ')) {
    issues.push([path, 'symlink']);
    continue;
  }
  const buffer = git(['show', `:${path}`]);
  if (buffer.includes(0)) {
    issues.push([path, 'unexpected binary']);
    continue;
  }
  const content = buffer.toString('utf8');
  for (const [name, pattern] of patterns)
    if (pattern.test(content)) issues.push([path, name]);
  for (const match of content.matchAll(
    /\/(?:Users|home)\/([A-Za-z0-9_.<>-]+)\//g,
  )) {
    if (!['you', 'user', 'username', 'example', '<user>'].includes(match[1]))
      issues.push([path, 'personal home path']);
  }
  if (secrets.some((secret) => content.includes(secret)))
    issues.push([path, 'configured secret']);
}
if (issues.length) {
  for (const [path, category] of issues) console.error(`${path}: ${category}`);
  process.exitCode = 1;
} else
  console.log(
    `Privacy check passed for ${paths.length} indexed files; no secret values were printed.`,
  );
