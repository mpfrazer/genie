// Shared by the CLI tests. Not a test file itself.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

/** The UserPromptExpansion hook's grant for a typed `/genie:<command> <args>` (grants.ts). */
export function grant(cwd: string, home: string, args: string[]) {
  const [command, ...rest] = args;
  const commandArgs = rest.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const input = JSON.stringify({ cwd, expansion_type: 'slash_command', command_name: `genie:${command}`, command_args: commandArgs });
  spawnSync('node', [CLI, 'hook', 'user-prompt-expansion'], { cwd, input, encoding: 'utf8', env: { ...process.env, GENIE_HOME: home } });
}
