// A deliberately small shell reader: enough to find the simple commands inside a Bash tool call
// (`cd x && git push`, `FOO=1 env git push`, `sh -c "…"`, `$(…)`). It is defense in depth for the
// gate hook, not a sandbox. Anything it can't see through is caught by the engine's own checks.

/** One simple command: its words with quotes removed, in order. */
export type Argv = string[];

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')'];

/** Stands in for a command substitution inside the outer command's words. */
const SUBST = '$(…)';

/** Splits a command line into simple commands, descending into `$(…)`, backticks, and `sh -c`. */
export function simpleCommands(line: string, depth = 0): Argv[] {
  const out: Argv[] = [];
  for (const argv of split(line)) {
    const inner = shellCArgument(argv);
    if (inner !== undefined && depth < 4) {
      out.push(...simpleCommands(inner, depth + 1));
    } else if (argv.length > 0) {
      out.push(argv);
    }
  }
  return out;
}

function split(line: string): Argv[] {
  const commands: Argv[] = [];
  let argv: Argv = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) argv.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (argv.length > 0) commands.push(argv);
    argv = [];
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      const end = close === -1 ? line.length : close;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) i++;
        if (line[i] === '$' && line[i + 1] === '(') {
          // Command substitution inside double quotes still runs: surface it as its own command.
          const close = matchParen(line, i + 1);
          commands.push(...split(line.slice(i + 2, close)));
          word += SUBST;
          i = close;
          continue;
        }
        word += line[i];
      }
    } else if (c === '\\') {
      if (line[i + 1] !== '\n') word += line[i + 1] ?? '';
      inWord = true;
      i++;
    } else if (c === '#' && !inWord) {
      const nl = line.indexOf('\n', i);
      i = nl === -1 ? line.length : nl - 1;
    } else if ((c === '$' && line[i + 1] === '(') || c === '`') {
      // Run the substitution as its own command, but keep the outer command's words intact.
      const close = c === '`' ? closingBacktick(line, i) : matchParen(line, i + 1);
      commands.push(...split(line.slice(c === '`' ? i + 1 : i + 2, close)));
      word += SUBST;
      inWord = true;
      i = close;
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === '&' && (word.endsWith('>') || word.endsWith('<') || line[i + 1] === '>')) {
      // `2>&1`, `>&2`, `&>file`: part of a redirection, not a control operator.
      word += c;
      inWord = true;
    } else {
      const op = OPERATORS.find((o) => line.startsWith(o, i));
      if (op) {
        endCommand();
        i += op.length - 1;
      } else {
        word += c;
        inWord = true;
      }
    }
  }
  endCommand();
  return commands;
}

function closingBacktick(line: string, open: number): number {
  const close = line.indexOf('`', open + 1);
  return close === -1 ? line.length : close;
}

function matchParen(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return i;
  }
  return line.length;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** The script passed to `sh -c '…'` (or `eval …`), if this command is one. */
function shellCArgument(argv: Argv): string | undefined {
  const words = stripWrappers(argv);
  const cmd = basename(words[0] ?? '');
  if (cmd === 'eval') return words.slice(1).join(' ');
  if (!SHELLS.has(cmd)) return undefined;
  const flag = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
  return flag === -1 ? undefined : words[flag + 1];
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'time', 'nohup', 'nice', 'builtin']);

/** Drops leading `VAR=value` assignments and transparent wrappers like `env` or `sudo`. */
export function stripWrappers(argv: Argv): Argv {
  let i = 0;
  while (i < argv.length) {
    const w = argv[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
    } else if (WRAPPERS.has(basename(w))) {
      i++;
      // Wrapper flags (`env -i`, `sudo -u root`, `nice -n 5`): skip them and a value if one follows.
      while (i < argv.length && argv[i]!.startsWith('-')) {
        const flag = argv[i]!;
        i++;
        if (['-u', '-g', '-n', '-C'].includes(flag)) i++;
      }
    } else {
      break;
    }
  }
  return argv.slice(i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
