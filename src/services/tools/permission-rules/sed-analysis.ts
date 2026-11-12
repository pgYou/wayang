// sed script analysis: is a `sed` invocation provably read-only?

/**
 * sed is a table read only when its SCRIPT cannot execute a shell
 * command or write a file. Those abilities are one letter long and live inside
 * the script STRING, where a token-level sweep cannot see them:
 *
 *   - `e` runs the pattern space as a command (`sed -n '1e id'`) and `s///e`
 *     runs the replacement; `w` / `W` write the pattern space to a file, and
 *     `r` / `R` read an arbitrary file into it (`sed -n 'w /tmp/x'`,
 *     `sed -n 'r /etc/passwd'`);
 *   - `isWriteSegment` only knows the flag forms (`sed -i`), so none of the
 *     above is caught by the write tier either.
 *
 * Hence the whitelist below: a script is a read only when EVERY command in it
 * is one of these. POSIX sed has no `e` at all and the list covers everyday
 * usage (`p d n N P D h H g G x = l b t`, labels, braces, `s` / `y`), so
 * tightening costs nothing in practice. A script we cannot LOCATE (`-f file`,
 * an ordering we do not model) is not read either — fail closed.
 */
const SED_READ_ONLY_SCRIPT_COMMANDS: ReadonlySet<string> = new Set([
  'p', 'd', 'n', 'N', 'P', 'D', 'h', 'H', 'g', 'G', 'x', '=', 'l', 'b', 't', ':', '{', '}',
]);

/** sed short options that never take a value (`sed -n`, `-E`, `-z`, …). */
const SED_VALUE_FREE_SHORT_OPTIONS: ReadonlySet<string> = new Set(['n', 'r', 'E', 's', 'u', 'z']);

/** sed long options that never take a value (`--version`, `--quiet`, …). */
const SED_VALUE_FREE_LONG_OPTIONS: ReadonlySet<string> = new Set([
  '--quiet', '--silent', '--debug', '--posix', '--sandbox', '--unbuffered',
  '--zero-terminated', '--null-data', '--regexp-extended', '--separate',
  '--follow-symlinks', '--version', '--help',
]);

/**
 * Index just past the closing `delimiter` of a delimited run starting at
 * `start`, or -1 when the run never closes. A backslash escapes the next
 * character, so `s/a\/b/c/` and `\%a;b%` are each scanned as ONE run.
 */
function scanSedDelimited(script: string, start: number, delimiter: string): number {
  let i = start;
  while (i < script.length) {
    const ch: string = script[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === delimiter) return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Split a sed script into command fragments on newlines and `;`, keeping
 * address regexes (`/…/`, `\c…c`) and the `s` / `y` delimiter runs whole — a
 * `;` inside them is part of the run, not a command separator
 * (`sed -n '/a;b/p'` is one command).
 *
 * An unterminated run is returned as the tail fragment; the fragment validator
 * rejects it, so a script the splitter cannot follow never becomes a read.
 */
function splitSedCommands(script: string): string[] {
  const fragments: string[] = [];
  let start = 0;
  let i = 0;
  // True until the fragment's command letter has been read: only addresses,
  // their `,` / `~` / `+` / `!` modifiers and whitespace may precede it.
  let atAddress = true;
  const cut = (): void => {
    fragments.push(script.slice(start, i));
    i += 1;
    start = i;
    atAddress = true;
  };
  while (i < script.length) {
    const ch: string = script[i];
    if (ch === '\n' || ch === ';') {
      cut();
      continue;
    }
    if (!atAddress) {
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/') {
      const end = scanSedDelimited(script, i + 1, '/');
      if (end < 0) return fragments.concat(script.slice(start));
      i = end;
      continue;
    }
    if (ch === '\\') {
      const delimiter: string | undefined = script[i + 1];
      if (delimiter === undefined) {
        i += 1;
        continue;
      }
      const end = scanSedDelimited(script, i + 2, delimiter);
      if (end < 0) return fragments.concat(script.slice(start));
      i = end;
      continue;
    }
    if (ch === '$' || ch === ',' || ch === '~' || ch === '+' || ch === '!') {
      i += 1;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      i += 1;
      continue;
    }
    // The command letter. `s` and `y` carry two delimiter runs, which may hold
    // a `;`; every other command's argument ends at the next `;` / newline.
    atAddress = false;
    const delimiter: string | undefined = script[i + 1];
    if ((ch === 's' || ch === 'y') && delimiter !== undefined && delimiter !== ';' && delimiter !== '\n') {
      let end = scanSedDelimited(script, i + 2, delimiter);
      if (end >= 0) end = scanSedDelimited(script, end, delimiter);
      if (end < 0) return fragments.concat(script.slice(start));
      i = end;
      continue;
    }
    i += 1;
  }
  fragments.push(script.slice(start));
  return fragments;
}

/** How `scanSedAddress` ended: an address was read, there was none, or it is broken. */
type SedAddressScan = { kind: 'matched' | 'absent'; next: number } | { kind: 'broken' };

/**
 * Read ONE address starting at `from`: a line number, `$`, `N~M`, `/regex/`,
 * `\c regex c`, or the `+N` / `~N` form that may follow a range comma.
 * 'absent' means the next character does not start an address at all; 'broken'
 * means it starts one that cannot be closed (an unterminated regex).
 */
function scanSedAddress(text: string, from: number): SedAddressScan {
  let i = from;
  const ch: string | undefined = text[i];
  if (ch === undefined) return { kind: 'absent', next: i };
  if (ch === '$') return { kind: 'matched', next: i + 1 };
  if (ch === '/' || ch === '\\') {
    let end: number;
    if (ch === '/') {
      end = scanSedDelimited(text, i + 1, '/');
    } else {
      const delimiter: string | undefined = text[i + 1];
      if (delimiter === undefined) return { kind: 'broken' };
      end = scanSedDelimited(text, i + 2, delimiter);
    }
    return end < 0 ? { kind: 'broken' } : { kind: 'matched', next: end };
  }
  if (ch >= '0' && ch <= '9') {
    while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
    if (text[i] === '~') {
      i += 1;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
    }
    return { kind: 'matched', next: i };
  }
  if (ch === '+') {
    i += 1;
    while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
    return { kind: 'matched', next: i };
  }
  return { kind: 'absent', next: i };
}

/**
 * Strip a fragment's leading address — `[addr[,addr]][!]` — and return what is
 * left (the command text, possibly empty). `undefined` means the address part
 * could not be parsed, so the fragment is not trusted (fail closed).
 *
 * A character scan, not a regex: `/…/` may contain `;`, `,` and escaped
 * delimiters, which no bounded pattern reads reliably.
 */
function stripSedAddresses(fragment: string): string | undefined {
  let i = 0;
  const skipSpace = (): void => {
    while (i < fragment.length) {
      const ch: string = fragment[i];
      if (ch !== ' ' && ch !== '\t' && ch !== '\r') return;
      i += 1;
    }
  };
  skipSpace();
  let scanned = scanSedAddress(fragment, i);
  if (scanned.kind === 'broken') return undefined;
  if (scanned.kind === 'matched') {
    i = scanned.next;
    skipSpace();
    // A range: `1,5`, `/a/,/b/`, `1~3,$`, `2,+4`.
    if (fragment[i] === ',' || fragment[i] === '~') {
      i += 1;
      skipSpace();
      scanned = scanSedAddress(fragment, i);
      if (scanned.kind !== 'matched') return undefined;
      i = scanned.next;
    }
    skipSpace();
    while (fragment[i] === '!') {
      i += 1;
      skipSpace();
    }
  }
  return fragment.slice(i);
}

/**
 * `s<d>pattern<d>replacement<d>flags` — the runs must close, and the flags must
 * not hold `e` (execute the replacement) or `w` / `W` (write it to a file).
 * Those are the only flags that reach outside the pattern space, so the rest
 * (`g`, `3`, `p`, `I`, …) is fine.
 */
function isReadOnlySedSubstitution(command: string): boolean {
  const delimiter: string | undefined = command[1];
  if (delimiter === undefined) return false;
  let end = scanSedDelimited(command, 2, delimiter);
  if (end < 0) return false;
  end = scanSedDelimited(command, end, delimiter);
  if (end < 0) return false;
  const flags = command.slice(end);
  return !/[ewW]/.test(flags);
}

/** `y<d>source<d>dest<d>` — structure only: transliteration cannot execute or write. */
function isReadOnlySedTransliteration(command: string): boolean {
  const delimiter: string | undefined = command[1];
  if (delimiter === undefined) return false;
  const end = scanSedDelimited(command, 2, delimiter);
  if (end < 0) return false;
  return scanSedDelimited(command, end, delimiter) >= 0;
}

/**
 * Is ONE script fragment safe? Addresses are stripped first, then the leading
 * command letter decides: `s` / `y` are checked structurally, a leading `{`
 * recurses into the block body (so `{1e cmd}` cannot hide behind a brace), and
 * every other letter must be on the whitelist — which is what rejects `e`,
 * `w`, `W`, `r`, `R` and everything else. An empty fragment (`;;`, a trailing
 * newline) carries no command and passes.
 */
function isReadOnlySedFragment(fragment: string): boolean {
  const command = stripSedAddresses(fragment);
  if (command === undefined) return false;
  if (command.length === 0) return true;
  const first: string = command[0];
  if (first === '{') return isReadOnlySedFragment(command.slice(1));
  if (first === 's') return isReadOnlySedSubstitution(command);
  if (first === 'y') return isReadOnlySedTransliteration(command);
  return SED_READ_ONLY_SCRIPT_COMMANDS.has(first);
}

/** Is every command in `script` read-only? (see `isReadOnlySedFragment`) */
export function isReadOnlySedScript(script: string): boolean {
  return splitSedCommands(script).every((fragment) => isReadOnlySedFragment(fragment));
}

/**
 * Parse one short-option word (`-n`, `-ne1p`, `-i.bak`) and push the scripts it
 * carries onto `expressions`. Returns how many WORDS it consumed (2 when the
 * option's value is the next word), or undefined when the word holds an option
 * we cannot account for — fail closed.
 *
 * `-f` is rejected outright: the script lives in a file, so it cannot be
 * checked here. `-i` (optionally with a glued suffix) is a write form handled by
 * the table's `writeFlags`, and takes no separate value.
 */
function consumeSedShortOptions(
  word: string,
  next: string | undefined,
  expressions: string[],
): number | undefined {
  let i = 1;
  while (i < word.length) {
    const flag: string = word[i];
    if (flag === 'e') {
      const glued: string = word.slice(i + 1);
      if (glued.length > 0) {
        expressions.push(glued);
        return 1;
      }
      if (next === undefined) return undefined;
      expressions.push(next);
      return 2;
    }
    if (flag === 'f') return undefined;
    if (flag === 'l') {
      // `-l N` / `-lN`: the line-length value is not a script.
      if (word.length > i + 1) return 1;
      return next === undefined ? undefined : 2;
    }
    if (flag === 'i') return 1;
    if (!SED_VALUE_FREE_SHORT_OPTIONS.has(flag)) return undefined;
    i += 1;
  }
  return 1;
}

/**
 * The scripts a `sed` segment will run, or `undefined` when that cannot be
 * determined (in which case the segment is `unknown`, never read).
 *
 * GNU-compatible enough for the spellings people actually write:
 * `-e SCRIPT` / `-eSCRIPT` / `--expression=SCRIPT` / `--expression SCRIPT`
 * (repeatable — every one is checked), and, when no `-e` was given, the first
 * non-option operand as the script. `-f` / `--file` returns undefined by
 * definition: the script lives in a file and cannot be read at judging time.
 * No script at all (`sed --version`, `sed --help`, a bare `sed`) is an EMPTY
 * list — there is nothing that could execute.
 *
 * `words` starts at the `sed` word itself (see `headCommand`). Anything that
 * does not fit the model — an unknown or value-taking option, an operand mixed
 * with `-e` — also returns undefined (fail closed).
 */
export function sedScriptsOf(words: readonly string[]): string[] | undefined {
  const args = words.slice(1);
  const expressions: string[] = [];
  let fromExpression = false;
  let operandScript: string | undefined;
  let positionalOnly = false;
  let i = 0;
  while (i < args.length) {
    const arg: string = args[i];
    if (positionalOnly || !arg.startsWith('-') || arg === '-') {
      // The first bare operand is the script; later ones are input files.
      if (!fromExpression && operandScript === undefined) operandScript = arg;
      i += 1;
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      i += 1;
      continue;
    }
    if (arg === '--expression' || arg.startsWith('--expression=')) {
      const value: string | undefined = arg === '--expression' ? args[i + 1] : arg.slice('--expression='.length);
      if (value === undefined) return undefined;
      expressions.push(value);
      fromExpression = true;
      i += arg === '--expression' ? 2 : 1;
      continue;
    }
    if (arg === '--file' || arg.startsWith('--file=')) return undefined;
    if (arg === '--line-length' || arg.startsWith('--line-length=')) {
      i += arg === '--line-length' ? 2 : 1;
      continue;
    }
    if (arg.startsWith('--')) {
      if (!SED_VALUE_FREE_LONG_OPTIONS.has(arg.split('=')[0])) return undefined;
      i += 1;
      continue;
    }
    const before = expressions.length;
    const consumed = consumeSedShortOptions(arg, args[i + 1], expressions);
    if (consumed === undefined) return undefined;
    if (expressions.length > before) fromExpression = true;
    i += consumed;
  }
  if (fromExpression) {
    // With `-e`, a bare operand is an input FILE — but one seen BEFORE the
    // first `-e` is ambiguous, so that ordering is not modelled: fail closed.
    return operandScript === undefined ? expressions : undefined;
  }
  return operandScript === undefined ? [] : [operandScript];
}
