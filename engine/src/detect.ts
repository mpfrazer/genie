// Best-effort repo inspection for `genie init`. Everything here is a suggestion written into
// config.yaml for the user to review, never a silent runtime assumption.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config/types.ts';

export interface Detected {
  commands: Record<string, string>;
  provider: Config['forge']['provider'];
  baseBranch: string;
  ecosystem?: string;
  /** Command for the pr.ready gate, when the repo has CI the forge can report on. */
  ciCommand?: string;
}

/**
 * Waits for CI on the current branch's PR, then watches it to completion.
 * `gh pr checks` exits 1 with "no checks reported" until the forge registers the workflow runs,
 * which can lag a fresh push by several seconds, so poll for up to two minutes first.
 */
export const GITHUB_CI_COMMAND = [
  '# Wait up to 2 minutes for CI to register on the PR, then watch it to completion.',
  'for i in $(seq 24); do gh pr checks 2>&1 | grep -q "no checks reported" || break; sleep 5; done',
  'gh pr checks --watch --interval 15',
].join('\n');

function hasGithubWorkflows(root: string): boolean {
  const dir = join(root, '.github', 'workflows');
  return existsSync(dir) && readdirSync(dir).some((f) => /\.ya?ml$/.test(f));
}

function git(root: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

function nodeCommands(root: string): Record<string, string> | undefined {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // An unparseable package.json still tells us the package manager; scripts stay empty.
  }
  const [pm, install] = existsSync(join(root, 'pnpm-lock.yaml'))
    ? ['pnpm', 'pnpm install --frozen-lockfile']
    : existsSync(join(root, 'yarn.lock'))
      ? ['yarn', 'yarn install --frozen-lockfile']
      : existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))
        ? ['bun', 'bun install --frozen-lockfile']
        : ['npm', existsSync(join(root, 'package-lock.json')) ? 'npm ci' : 'npm install'];

  const run = (script: string) => (pm === 'npm' && script === 'test' ? 'npm test' : `${pm} run ${script}`);
  const commands: Record<string, string> = { install };
  const pick = (key: string, candidates: string[]) => {
    const found = candidates.find((c) => scripts[c]);
    if (found) commands[key] = run(found);
  };
  pick('build', ['build']);
  pick('lint', ['lint']);
  pick('typecheck', ['typecheck', 'type-check', 'tsc', 'check-types']);
  pick('test', ['test']);
  return commands;
}

export function detect(root: string): Detected {
  let commands: Record<string, string> = {};
  let ecosystem: string | undefined;
  const node = nodeCommands(root);
  if (node) {
    commands = node;
    ecosystem = 'node';
  } else if (existsSync(join(root, 'Cargo.toml'))) {
    commands = { build: 'cargo build', lint: 'cargo clippy -- -D warnings', test: 'cargo test' };
    ecosystem = 'rust';
  } else if (existsSync(join(root, 'go.mod'))) {
    commands = { build: 'go build ./...', lint: 'go vet ./...', test: 'go test ./...' };
    ecosystem = 'go';
  }

  const remote = git(root, ['remote', 'get-url', 'origin']) ?? '';
  const provider = remote.includes('github.com') ? 'github' : remote.includes('gitlab') ? 'gitlab' : 'none';
  const originHead = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '');
  const baseBranch = originHead ?? git(root, ['symbolic-ref', '--short', 'HEAD']) ?? 'main';

  const ciCommand = provider === 'github' && hasGithubWorkflows(root) ? GITHUB_CI_COMMAND : undefined;
  return { commands, provider, baseBranch, ecosystem, ciCommand };
}
