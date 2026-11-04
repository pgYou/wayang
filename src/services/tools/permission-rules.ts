/**
 * Worker tool permission rules: reduce a tool call to an access verdict.
 *
 * The path boundary itself is NOT defined here — it is delegated to the shared
 * access policy (`@/infra/permission/policy`), which owns:
 *
 *   1. the sensitive list (highest priority, not overridable by any allow):
 *      a read AND a write both ask for approval; `sensitiveMode: 'deny'`
 *      refuses both without asking instead,
 *   2. user-config `allowedDirs` / `autoAllowRoots` / `sensitiveDirs`
 *      (plus the deprecated `deniedDirs` alias, merged into the same list),
 *   3. the task's own `allowedDirs`,
 *   4. the task workspace,
 *   5. "reads inside home are fine, writes are not" — DELIBERATELY NARROWED
 *      here (see `evaluateFileAccess` and `narrowHomeRead`): a worker is
 *      auto-allowed only inside its workspace / task allowedDirs / configured
 *      roots. Reading the rest of the user's home still asks, because the
 *      sensitive list covers credentials and tool config, not `.env` files,
 *      keys or other projects' sources.
 *
 * This module only adds what is tool-specific:
 *
 *   - which access mode a tool implies (read / write / unknown),
 *   - how a bash command string is reduced to path candidates (expanding
 *     `$HOME` / `${HOME}` first) and whether each candidate sits in a
 *     read-only, write-capable or unclassifiable command segment (see
 *     `READ_ONLY_COMMANDS` and `segmentAccess`),
 *   - the destructive-command heuristic, which stays a "ask the controller"
 *     tier on top of the policy (the policy only judges paths),
 *   - escalation to `ask` when a target cannot be determined statically:
 *     `~user` (another user's home), command substitution, output redirection,
 *     and a read-only-table command that FAILED its own deferred condition
 *     (`sed -f`, a script that executes or writes — `read-only-unverified`).
 *
 * Verdicts: `allow` → run immediately, `ask` → controller approval,
 * `deny` → refuse without asking (`sensitiveMode: 'deny'` on a sensitive hit).
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  decideAccess,
  type AccessDecision,
  type AccessMode,
  type DecideAccessResult,
  type MatchedRule,
  type SensitiveMatchSource,
} from '@/infra/permission/policy';
import { mergeSensitiveDirs, resolveSensitiveMode } from '@/infra/permission/permission-config';
import {
  CMDSUBST_PLACEHOLDER,
  classifyRedirections,
  isDiscardRedirectTarget,
  tokenizeShellLite,
  type ShellSegment,
  type ShellSubstitution,
} from '@/services/tools/shell-lexer';
import type { PermissionConfig } from '@/types/config';

/** File tools gated by the permission middleware for path access. */
export const FILE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'search_files', 'search_content'] as const;

/** File tools that only read. Every other file tool counts as a write. */
const READ_ONLY_FILE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'search_files', 'search_content']);

/**
 * Bash commands matching these patterns always require controller approval.
 * Matches at command start or after shell operators (|, ;, &&) to reduce
 * false positives from quoted strings.
 */
const DANGEROUS_BASH_PATTERN = /(?:^|\||;|&&)\s*(?:rm\s|sudo\b|chmod\b|chown\b|mkfs\b|dd\s|shutdown\b|reboot\b|kill\s+-9)/;

/**
 * Matched rules beyond the policy's own set: the destructive-command tier and
 * the "nothing to judge" case live in this module, not in the policy.
 */
export type WorkerMatchedRule =
  | MatchedRule
  | 'dangerous-bash'
  | 'no-path'
  | 'home-other-user'
  | 'dynamic-shell'
  | 'read-only-unverified';

/** Everything the shared policy needs to know about ONE worker run's boundary. */
export interface WorkerAccessScope {
  /**
   * The user's home directory — the POLICY BOUNDARY (sensitive-list anchor and
   * read scope). Injected by the engine (never read globally here). In
   * production it is the process home (`os.homedir()`), but it is a separate
   * concept from `~` EXPANSION: `expandHome` always anchors on the process
   * home so a tool opens exactly what a shell would, while this field decides
   * whether that path is inside the scope a worker may touch.
   */
  homeDir: string;
  /** The task's workspace: the tool cwd and this run's writable boundary. */
  workspace: string;
  /** Extra directories granted to this one task (`task.taskAllowedDirs`). */
  taskAllowedDirs?: string[];
  /** User-config permission section (`config.permission`). */
  permission?: PermissionConfig;
}

export interface ToolAccessDecision {
  decision: AccessDecision;
  matchedRule: WorkerMatchedRule;
  /**
   * Present on `deny`. The message handed back to the worker — it names the
   * path the WORKER supplied and nothing else (no sensitive-list entry, no
   * canonical symlink target), so a refusal discloses nothing the worker
   * didn't already know.
   */
  message?: string;
  /**
   * Present on `ask` when the reason is not obvious from the call itself — e.g.
   * a command substitution or output redirection whose target cannot be
   * determined statically. Surfaces in the approval request so the controller
   * understands WHY it is being asked.
   */
  reason?: string;
  /**
   * The sensitive-list entry that matched (`.ssh`, `.docker/config.json`, a
   * configured dir). Present on a sensitive hit — in an approval request and
   * in the audit trail it explains the verdict; in a refusal message it is
   * deliberately omitted.
   */
  matchedEntry?: string;
  /** Which sensitive rule produced the hit (`segment`, `config-dir`, …). */
  matchedSource?: SensitiveMatchSource;
  /**
   * True when a sensitive-list entry was hit. For a sensitive verdict that IS
   * the reason (`matchedRule: 'sensitive-list'`); a stronger rule can still
   * raise the verdict — `dangerous-bash` sets this flag too, because the call
   * touches the entry whether or not the danger rule also fired.
   */
  sensitive?: boolean;
  /** Canonical (realpath-normalized) target the verdict was made about. */
  resolvedPath?: string;
  /**
   * How the target was judged: read / write / unknown (bash semantics). On a
   * command-level verdict this is the STRICTEST access its candidates justify
   * (`write` > `read` > `unknown`) — see `commandAccess`.
   */
  access?: AccessMode;
  /**
   * Canonical paths this call would need approval FOR — one entry per asking
   * candidate, and only on an `ask` reached by judging path candidates (a
   * `dangerous-bash`, `dynamic-shell`, `home-other-user` or
   * `read-only-unverified` escalation carries none: those asks are not "one
   * path, once" decisions).
   *
   * Exists for the task approval memory (issue #46): a grant is per
   * `direction:path`, so a reuse decision must know EVERY path the call asks
   * about. Checking just `resolvedPath` (the first asking candidate) would let
   * an approved `cat /etc/a /etc/b` silently cover `/etc/b` on the second run.
   */
  askPaths?: string[];
}

/**
 * Result of expanding a leading `~` / `$HOME` token in a path.
 *
 * `~` and `~/...` expand against the PROCESS home (see `expandHome`).
 * `~<name>` (tilde followed by anything other than `/` or end-of-word) names
 * ANOTHER user's home. We deliberately do NOT resolve it — that would mean
 * reading /etc/passwd or guessing the layout — so it is reported as
 * unresolvable and the caller forces an approval. Treating it as a relative
 * path would be wrong: a shell reads `cat ~root/.ssh/x` as `/root/.ssh/x`,
 * not as workspace-relative.
 */
export interface HomeExpansion {
  /** Path after `~` / `~/` / `$HOME` expansion; unchanged for `~<name>`. */
  path: string;
  /** True for `~<name>` — another user's home, which cannot be resolved safely. */
  unresolvable: boolean;
}

/**
 * The process's home directory — the anchor a SHELL expands `~` and `$HOME`
 * to (`os.homedir()`: `$HOME` when set, the account entry otherwise).
 *
 * TWO different "home" concepts must not be conflated:
 *
 *   - THIS one is an IO semantic: `read_file('~/x')` and `cat ~/x` must open
 *     the same file, and the shell's anchor is the process environment —
 *     never a Wayang flag or the session layout.
 *   - The policy boundary (`WorkerAccessScope.homeDir`, renamed `userHome`):
 *     WHO may read what. In production it is the same directory, but it is a
 *     separate decision input — a scope may anchor anywhere (tests inject
 *     temp dirs), and expansion must not follow it.
 */
export function processHomeDir(): string {
  return homedir();
}

/**
 * Expand a leading `~` / `$HOME` token against the PROCESS home.
 *
 * Exported for the file tools (`read_file` onwards): the tool must open the
 * SAME path the permission gate judged, and both must match what a shell
 * would open for `~/x` / `$HOME/x`. That anchor is the process home — never
 * the policy boundary (`scope.homeDir`), which may differ (a Wayang run with
 * a custom root anchors its policy elsewhere while the worker's shell still
 * expands `~` to the real `$HOME`).
 *
 * `$HOME` / `${HOME}` are accepted as leading tokens for the file tools and
 * declared workspaces, where no shell sits in between to expand them. A bare
 * `$HOMEDIR`-style prefix is NOT expanded (only the exact spellings).
 * `~<name>` stays unresolvable — see `HomeExpansion`.
 */
export function expandHome(p: string): HomeExpansion {
  const home = processHomeDir();
  if (p === '~' || p === '$HOME' || p === '${HOME}') {
    return home === ''
      ? { path: p, unresolvable: true }
      : { path: home, unresolvable: false };
  }
  if (p.startsWith('~/')) {
    return home === ''
      ? { path: p, unresolvable: true }
      : { path: resolve(home, p.slice(2)), unresolvable: false };
  }
  for (const prefix of ['$HOME/', '${HOME}/']) {
    if (p.startsWith(prefix)) {
      return home === ''
        ? { path: p, unresolvable: true }
        : { path: resolve(home, p.slice(prefix.length)), unresolvable: false };
    }
  }
  if (p.startsWith('~')) return { path: p, unresolvable: true };
  return { path: p, unresolvable: false };
}

/**
 * Replace `$HOME` / `${HOME}` with the PROCESS home BEFORE path candidate
 * extraction, so `cat $HOME/.ssh/id_rsa` is judged against the same concrete
 * path a shell would open (and the sensitive list can see it) — the same
 * anchor `expandHome` uses. Only these two spellings are rewritten:
 * positional/special parameters (`$1`, `$@`, …) and every other variable are
 * left untouched, so common `awk '{print $1}'` commands never trip the gates.
 */
function expandHomeVars(command: string): string {
  const home = processHomeDir();
  if (home === '') return command;
  // `${HOME}` first, then a bare `$HOME` not followed by an identifier char
  // (so `$HOMEDIR` is not partially rewritten).
  return command.replace(/\$\{HOME\}/g, home).replace(/\$HOME(?![A-Za-z0-9_])/g, home);
}

/**
 * Commands that only READ what they are pointed at.
 *
 * Membership is opt-in — "no write feature found" is NOT enough to be a read,
 * so `python`, `make` and `npm` stay outside the table and keep their previous
 * `unknown` verdict. The table serves BOTH classifiers: the top-level one (a
 * candidate in a read-only segment is judged `read`, see `segmentAccess`) and
 * the command-substitution interior (`$(cat notes.txt)` needs no approval).
 *
 * Three members are conditional, and the conditions are enforced outside the
 * table:
 *
 *   - `sed` and `find` write only with a flag (`sed -i`, `find -delete`,
 *     `find -exec …`) — `isWriteSegment` owns that split, so a write segment is
 *     never read-only whatever the table says;
 *   - `sed` is a read only when its SCRIPT is — GNU's `e` / `w` / `W` / `r` / `R`
 *     live inside the script string — `isReadOnlySedScript` (see
 *     `SED_READ_ONLY_SCRIPT_COMMANDS`);
 *   - `git` is a read only for its read subcommands — `isReadOnlyGitCommand`.
 *
 * A condition that FAILS is not the same as an off-table command: `sed` is on
 * the table because it usually only reads, so a script that executes, writes
 * or cannot be located makes the segment `unverified` (see `classifySegment`)
 * and the top level escalates it to an approval (`read-only-unverified`)
 * instead of letting the no-candidate fallback run it silently.
 *
 * Classifying a read never widens what a worker may touch on its own: the
 * policy still judges every path, and a policy allow that rests solely on
 * "reads inside home" is still narrowed to an approval for bash candidates
 * (see `narrowHomeRead`), exactly as `evaluateFileAccess` does for file tools.
 * The classification exists to get the DIRECTION right — the audit trail and
 * the approval request then say read / write / unknown instead of calling
 * every `cat` unknown.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'cat', 'ls', 'head', 'tail', 'wc', 'grep', 'rg', 'stat', 'file', 'readlink',
  'which', 'command', 'echo', 'printf', 'date', 'pwd', 'tree', 'du', 'df',
  'cut', 'sort', 'uniq', 'tr', 'diff', 'sed', 'find', 'git',
]);

/**
 * sed is on `READ_ONLY_COMMANDS` only when its SCRIPT cannot execute a shell
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
function isReadOnlySedScript(script: string): boolean {
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
 * `BASH_FLAGGED_WRITE_VERBS`, and takes no separate value.
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
function sedScriptsOf(words: readonly string[]): string[] | undefined {
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

/**
 * How deep command substitutions are followed before giving up. A command
 * nested deeper than this asks: past a few levels the intent is more likely
 * generated code than a diagnostic one-liner.
 */
const MAX_CMDSUBST_DEPTH = 5;

/**
 * Commands that write to the paths they name. A candidate in the same command
 * segment as one of these is judged as a WRITE (so a sensitive target asks as
 * an approved-once write, or is refused outright under `sensitiveMode: 'deny'`).
 *
 * This is the write half of the direction split: `rm ~/.ssh/x` and
 * `cat ~/.ssh/x` both escalate, but the first reports `access: write` and the
 * second `access: read`, and a refusal names the direction it refused.
 * A command missing from this table loses no safety —
 * it is judged `unknown` (see `READ_ONLY_COMMANDS` for the read half), which the
 * policy treats as a write for scope purposes.
 */
const BASH_WRITE_VERBS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'ln', 'tee', 'dd', 'truncate', 'install',
  'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'shred', 'unlink', 'chattr',
  'mkfs', 'mkswap', 'mount', 'umount',
]);

/**
 * Verbs that write only with a specific flag (`sed -i`, `find -delete`, …).
 * Both the verb and one of its flags must appear in the same segment.
 *
 * `find` needs the full write set because it is a read-only command otherwise
 * (see `READ_ONLY_COMMANDS`): every option that creates, deletes, truncates or
 * hands a file WRITE handle to another command lives here. `/…/ -ok` prompts but
 * still runs a command, so it belongs in the write tier with `-exec`.
 */
const BASH_FLAGGED_WRITE_VERBS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sed', ['-i', '--in-place']],
  ['perl', ['-i']],
  ['ruby', ['-i']],
  [
    'find',
    [
      '-delete', '-fprint', '-fprint0', '-fls', '-fprintf', '-exec', '-execdir', '-ok', '-okdir',
    ],
  ],
]);

/**
 * Does `word` spell the option `flag`? Three spellings count: the flag itself,
 * `flag=value`, and a SHORT flag with a glued value (`sed -i.bak`, `sed -i''`).
 * The glued form is only accepted for two-character flags and only when the next
 * character is not a letter, so `-include` is not read as `-i`.
 */
function isFlagWord(word: string, flag: string): boolean {
  if (word === flag || word.startsWith(`${flag}=`)) return true;
  return flag.length === 2 && word.startsWith(flag) && !/[A-Za-z]/.test(word.charAt(flag.length));
}

/**
 * Does this segment certainly write — a write verb, a write flag, or an output
 * redirection into a real file? Read from the lexer's tokens, so a discard
 * (`> /dev/null`) and an fd copy (`2>&1`) are not mistaken for a file write,
 * and a `>` inside quotes is not mistaken for a redirection.
 */
function isWriteSegment(segment: ShellSegment): boolean {
  const words: string[] = [];
  for (const token of segment.tokens) {
    if (token.kind === 'word') {
      words.push(token.word.text);
      continue;
    }
    const { redirect } = token;
    if (redirect.kind !== 'output') continue;
    if (isDiscardRedirectTarget(redirect.target?.text)) continue;
    return true;
  }
  for (const word of words) {
    if (BASH_WRITE_VERBS.has(word)) return true;
    const flags = BASH_FLAGGED_WRITE_VERBS.get(word);
    if (flags && flags.some((flag) => words.some((other) => isFlagWord(other, flag)))) return true;
  }
  return false;
}

/**
 * git subcommands that only read. `git` itself is in `READ_ONLY_COMMANDS`, so
 * everything else — `clean`, `checkout`, `reset`, `push`, `commit`, `stash`, …
 * — falls back to `unknown` and keeps the old verdict.
 */
const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'grep',
  'describe', 'shortlog',
]);

/**
 * Subcommands whose BARE form reads but whose flags mutate (`git branch -D`,
 * `git remote add`). They are read-only only with an explicit list flag.
 */
const GIT_LIST_ONLY_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['branch', ['-a', '--all', '--list', '-l']],
  ['remote', ['-v', '--verbose']],
]);

/** git global options that consume the NEXT word (`git -C /repo status`). */
const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
]);

/**
 * Is this `git …` segment a read? `words` starts at the `git` word, so global
 * options are skipped first (`git --no-pager log`, `git -C /repo diff`) and the
 * subcommand is the first word that is neither an option nor an option's value.
 * No subcommand at all (bare `git`) is NOT read: it is unknown, fail closed.
 */
function isReadOnlyGitCommand(words: readonly string[]): boolean {
  const args = words.slice(1);
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const subcommand = args[i];
  if (subcommand === undefined) return false;
  if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return true;
  const listFlags = GIT_LIST_ONLY_FLAGS.get(subcommand);
  if (listFlags === undefined) return false;
  const flags = args.slice(i + 1).filter((word) => word.startsWith('-'));
  return flags.length > 0 && flags.every((flag) => listFlags.includes(flag));
}

/**
 * Commands that only launch another command. The real command sits behind them,
 * so a segment's head word is the first word that is not a leading variable
 * assignment and not one of these prefixes (`sudo cat x`, `env FOO=1 cat x`,
 * `nohup time cat x`). Skipping them is what lets `sudo cat ~/notes.md` be
 * judged as the read it is — the destructive-command tier still asks for the
 * `sudo` itself.
 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  'sudo', 'env', 'nohup', 'time', 'nice', 'ionice', 'command', 'exec', 'builtin',
]);

/** Options of the wrappers above that consume the NEXT word as their value. */
const WRAPPER_OPTIONS_WITH_VALUE: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'sudo',
    [
      '-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from',
      '-h', '--host', '-r', '--role', '-t', '--type', '-U', '--other-user',
      '-T', '--command-timeout', '-D', '--chdir',
    ],
  ],
  ['env', ['-u', '--unset', '-C', '--chdir', '-S', '--split-string']],
  ['nice', ['-n', '--adjustment']],
  ['ionice', ['-c', '--class', '-n', '--classdata', '-p', '--pid']],
  ['exec', ['-a']],
]);

/** A leading shell variable assignment (`FOO=1`), not a command word. */
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The command a segment actually runs: leading assignments skipped, wrapper
 * prefixes (with their own arguments) skipped, then the command word — plus the
 * words from that command on, so `git` can read its subcommand.
 *
 * `command -v x` / `builtin -V x` are queries, not launches, so the wrapper IS
 * the command word there (`command` is on the read-only table for that reason).
 * A segment with no command word at all — or with a command substitution in its
 * place — returns `undefined`, and the caller keeps the verdict `unknown`.
 */
function headCommand(segment: ShellSegment): { command: string; words: string[] } | undefined {
  const words: string[] = [];
  for (const token of segment.tokens) {
    if (token.kind === 'word') words.push(token.word.text);
  }

  let i = 0;
  while (i < words.length) {
    if (ASSIGNMENT_PATTERN.test(words[i])) {
      i += 1;
      continue;
    }
    if (!WRAPPER_COMMANDS.has(words[i])) break;
    const next = words[i + 1];
    if (next === '-v' || next === '-V') break; // `command -v x`: the wrapper is the query
    const withValue = WRAPPER_OPTIONS_WITH_VALUE.get(words[i]) ?? [];
    i += 1;
    while (i < words.length) {
      const option = words[i];
      if (ASSIGNMENT_PATTERN.test(option)) {
        i += 1; // `env FOO=1 cat x`
        continue;
      }
      if (!option.startsWith('-')) break;
      i += withValue.includes(option) ? 2 : 1;
    }
  }

  const command = words[i];
  if (command === undefined || command === CMDSUBST_PLACEHOLDER) return undefined;
  return { command, words: words.slice(i) };
}

/**
 * How ONE segment classifies, plus WHY a read-only-table command inside it
 * could not be verified as a read.
 *
 * `unverified` is the fail-closed signal the top level escalates on (see
 * `unverifiedReadOnlyCommand`): an off-table command (`python`, `make`, `npm`)
 * is merely `unknown` and keeps the historic no-candidate allow, while a table
 * member that failed its OWN check must never run silently on the table's
 * promise that it only reads.
 */
interface SegmentClassification {
  /** The access this segment justifies — see `classifySegment`. */
  mode: AccessMode;
  /**
   * The head command when it is on `READ_ONLY_COMMANDS` but the deferred
   * condition the table attaches to it failed — today only `sed` has one (a
   * script that executes, writes, or cannot be located at all). A future
   * condition on `find` / `git` would plug in here. Never set on a write
   * segment: a write verb / flag / redirection settles the segment as a write
   * FIRST, whatever the table says.
   */
  unverified?: string;
}

/**
 * Classify one segment: `write` when it certainly writes (write verb, write
 * flag, or a redirection into a real file — `isWriteSegment`), `read` when its
 * head command is on `READ_ONLY_COMMANDS` AND every deferred condition that
 * table attaches to it holds, `unknown` otherwise. Segments are judged
 * independently so a `cat` next to a `tee` keeps its own direction.
 */
function classifySegment(segment: ShellSegment): SegmentClassification {
  if (isWriteSegment(segment)) return { mode: 'write' };
  const head = headCommand(segment);
  if (head === undefined) return { mode: 'unknown' };
  if (!READ_ONLY_COMMANDS.has(head.command)) return { mode: 'unknown' };
  if (head.command === 'git') {
    // `git`'s subcommand check is a classifier, not a deferred condition: a
    // non-read subcommand is DETERMINED not to be a read (like an off-table
    // command), not "a reader we failed to verify". It therefore stays
    // `unknown` and keeps the historic no-candidate allow (`git clone …`).
    return { mode: isReadOnlyGitCommand(head.words) ? 'read' : 'unknown' };
  }
  // `sed` is a read only when its SCRIPT cannot execute or write: the ability
  // rides inside a script word, so it is judged here rather than by the token
  // sweep. The `-i` write forms were already settled by `isWriteSegment`.
  // When the check fails the segment is not merely `unknown`: `sed` is on the
  // table precisely because it usually only reads, so the failure is reported
  // as `unverified` for the top level to escalate on.
  if (head.command === 'sed') {
    const scripts = sedScriptsOf(head.words);
    if (scripts === undefined) return { mode: 'unknown', unverified: 'sed' };
    return scripts.every((script) => isReadOnlySedScript(script))
      ? { mode: 'read' }
      : { mode: 'unknown', unverified: 'sed' };
  }
  return { mode: 'read' };
}

/**
 * Is this segment a VERIFIED read? (see `classifySegment`)
 *
 * Opt-in, so anything the gate has not been taught to read — `python`, `make`,
 * `npm`, `xargs`, an unparsable head — stays `unknown`. A table command whose
 * deferred condition failed is `unknown` too, but carries `unverified` in its
 * classification (see `unverifiedReadOnlyCommand`).
 */
function isReadOnlySegment(segment: ShellSegment): boolean {
  return classifySegment(segment).mode === 'read';
}

/** The access a SINGLE segment justifies — see `classifySegment`. */
function segmentAccess(segment: ShellSegment): AccessMode {
  return classifySegment(segment).mode;
}

/**
 * The first head command that is on `READ_ONLY_COMMANDS` but FAILED the
 * deferred condition the table attaches to it (see `classifySegment`), or
 * undefined. This is the fail-closed signal for the top level: such a line
 * must not run silently just because it produced no asking path candidate
 * (relative operands only) or only candidates the policy would allow — the
 * table's promise ("this command only reads") is exactly what failed to
 * verify.
 */
function unverifiedReadOnlyCommand(segments: readonly ShellSegment[]): string | undefined {
  for (const segment of segments) {
    const { unverified } = classifySegment(segment);
    if (unverified !== undefined) return unverified;
  }
  return undefined;
}

/** A path candidate plus how the policy should judge it. */
interface BashCandidate {
  path: string;
  /** The access its own segment justifies — see `segmentAccess`. */
  access: AccessMode;
  /** Present for redirection targets — surfaced on `ask` so the reason is clear. */
  reason?: string;
}

/**
 * Split one unquoted shell word into path candidates. A word only yields a
 * candidate when a piece of it STARTS with `/` or `~`: `src/cli.ts` must not be
 * mistaken for the absolute path `/cli.ts`, and a URL (`https://…`) is not a
 * filesystem path. `--prefix=/usr/local` and `of=$HOME/x` do carry one, so the
 * word is split on `=` as before.
 */
function pathPieces(text: string, access: BashCandidate['access']): BashCandidate[] {
  const candidates: BashCandidate[] = [];
  for (const piece of text.split('=')) {
    if (!piece.startsWith('/') && !piece.startsWith('~')) continue;
    // The discard family is never a file to judge: `tee /dev/null` is not a
    // write outside the workspace.
    if (isDiscardRedirectTarget(piece)) continue;
    candidates.push({ path: piece, access });
  }
  return candidates;
}

/**
 * Extract path candidates from a lexed command line: absolute / `~` words plus
 * the targets of redirections into real files.
 *
 * Relative spellings are deliberately NOT extracted (historic behaviour: a
 * relative word is not a path candidate, so it never triggers a prompt). Bash
 * resolves those against the task workspace, which is also the tool's cwd.
 *
 * Candidates are collected segment by segment so each one carries the strongest
 * access its OWN segment can justify: a `cat` in one segment cannot downgrade
 * the `tee` next to it. A redirection target is always a write, whatever the
 * rest of the segment does.
 */
function extractPathCandidates(segments: ShellSegment[]): BashCandidate[] {
  const candidates: BashCandidate[] = [];
  for (const segment of segments) {
    const segmentLevel = segmentAccess(segment);
    for (const token of segment.tokens) {
      if (token.kind === 'word') {
        candidates.push(...pathPieces(token.word.text, segmentLevel));
        continue;
      }
      const { redirect } = token;
      if (redirect.kind === 'fd-dup' || redirect.kind === 'here-doc' || redirect.kind === 'here-string') continue;
      const target = redirect.target?.text;
      if (target === undefined || isDiscardRedirectTarget(target)) continue;
      // A substitution target is judged through evaluateSubstitutions instead.
      if (target.includes(CMDSUBST_PLACEHOLDER)) continue;
      const access: AccessMode = redirect.kind === 'output' ? 'write' : segmentLevel;
      for (const candidate of pathPieces(target, access)) {
        candidates.push(
          redirect.kind === 'output'
            ? { ...candidate, reason: `output redirection to "${target}"` }
            : candidate,
        );
      }
    }
  }
  return candidates;
}

/**
 * The access a whole command line is audited under: the STRICTEST access any of
 * its candidates justifies, ordered `write` > `read` > `unknown`. A command line
 * is one unit of execution, so a single write-capable candidate makes the line a
 * write even when every other candidate is a read.
 *
 * This is a REPORTING value only — each candidate was still judged on its own
 * access above, so a `cat` next to a `tee` is not treated as a write. The audit
 * trail records it as its own `access` field, apart from the tool-category
 * `operation` (bash → `exec`).
 */
function commandAccess(candidates: readonly BashCandidate[]): AccessMode {
  let access: AccessMode = 'unknown';
  for (const candidate of candidates) {
    if (candidate.access === 'write') return 'write';
    if (candidate.access === 'read') access = 'read';
  }
  return access;
}

/** Run one path past the shared policy with this run's boundary as context. */
function decidePath(
  scope: WorkerAccessScope,
  path: string,
  access: AccessMode,
): DecideAccessResult {
  const permission = scope.permission;
  return decideAccess({
    path,
    access,
    cwd: scope.workspace,
    userHome: scope.homeDir,
    taskWorkspace: scope.workspace,
    taskAllowedDirs: scope.taskAllowedDirs,
    configAllowedDirs: permission?.allowedDirs,
    autoAllowRoots: permission?.autoAllowRoots,
    // `sensitiveDirs` is the current key; `deniedDirs` is its deprecated alias
    // and is merged (deduped) here so a legacy config keeps protecting exactly
    // the directories it declares.
    extraSensitiveDirs: mergeSensitiveDirs(permission),
    sensitiveMode: resolveSensitiveMode(permission),
  });
}

/**
 * Map a policy verdict onto a tool verdict, carrying the explainability fields
 * (matched entry / source / canonical path / judged access) along so approval
 * requests and the audit trail can name the hit.
 */
function toToolDecision(verdict: DecideAccessResult, access: AccessMode): ToolAccessDecision {
  return {
    decision: verdict.decision,
    matchedRule: verdict.matchedRule,
    resolvedPath: verdict.resolvedPath,
    access,
    ...(verdict.matchedEntry !== undefined && {
      matchedEntry: verdict.matchedEntry,
      matchedSource: verdict.matchedSource,
      sensitive: true,
    }),
  };
}

/**
 * Declare the canonical target as this verdict's only asking path.
 *
 * Applied where the verdict was reached by judging ONE concrete path — a file
 * tool, or one candidate inside a bash command. The task approval memory
 * (issue #46) keys grants on `direction:path`, so an `ask` must say WHICH paths
 * it is about; `resolvedPath` alone is not enough for a bash command whose
 * several candidates all ask (see `ToolAccessDecision.askPaths`).
 */
function withAskPaths(decision: ToolAccessDecision): ToolAccessDecision {
  if (decision.decision !== 'ask' || decision.resolvedPath === undefined) return decision;
  return { ...decision, askPaths: [decision.resolvedPath] };
}

/**
 * Narrow the policy's "reads inside home" allow for a BASH candidate.
 * The policy lets a read happen anywhere under home (the controller's own read
 * scope, rule 6), but a WORKER's silence-worthy scope is its workspace, its task
 * allowedDirs and the explicitly configured roots. A bash candidate that the
 * classification now names a `read` gets exactly the same treatment a file tool
 * gets: the allow is turned back into an approval. Classifying a command as a
 * read therefore changes only the DIRECTION reported (audit trail, approval
 * request) — never the set of paths a worker may open without asking.
 *
 * The test is the policy's `withinReadScope` flag, not the `matchedRule` string,
 * so renaming the rule cannot widen access.
 */
function narrowHomeRead(verdict: DecideAccessResult, candidate: BashCandidate): ToolAccessDecision {
  if (verdict.decision === 'allow' && verdict.withinReadScope) {
    return {
      decision: 'ask',
      matchedRule: 'read-within-home',
      resolvedPath: verdict.resolvedPath,
      access: candidate.access,
      ...(verdict.resolvedPath !== undefined && { askPaths: [verdict.resolvedPath] }),
    };
  }
  return withAskPaths(toToolDecision(verdict, candidate.access));
}

/**
 * Decide a file tool call. `read_file` / `search_files` / `search_content` are
 * reads; `write_file` / `edit_file` are writes. A call without a usable `path`
 * has nothing to judge and is allowed (the tool then uses its own cwd).
 *
 * NARROWER THAN THE POLICY ON PURPOSE: `read-within-home` is downgraded to
 * `ask`. The controller may read anywhere under home (its own read scope, 4b),
 * but a WORKER's silence-worthy scope is its workspace, its task allowedDirs
 * and the explicitly configured roots. The sensitive list only covers
 * credentials and tool config — `.env` files, SSH keys inside a project, other
 * projects' sources are all "inside home" and must not be readable without an
 * approval.
 */
export function evaluateFileAccess(
  scope: WorkerAccessScope,
  toolName: string,
  args: Record<string, unknown>,
): ToolAccessDecision {
  const rawPath = args.path;
  if (typeof rawPath !== 'string' || !rawPath) return { decision: 'allow', matchedRule: 'no-path' };

  const access: AccessMode = READ_ONLY_FILE_TOOLS.has(toolName) ? 'read' : 'write';
  const expanded = expandHome(rawPath);
  if (expanded.unresolvable) {
    // `~user`: another user's home. We do not guess it, so we cannot prove it
    // is inside any allowed scope — ask rather than silently allow.
    return {
      decision: 'ask',
      matchedRule: 'home-other-user',
      reason: "`~user` names another user's home directory, which cannot be resolved safely",
    };
  }

  const verdict = decidePath(scope, expanded.path, access);
  // Downgrade when — and only when — the allow rests SOLELY on the policy's
  // "read inside home" rule. Structured check (withinReadScope), not the
  // matchedRule string literal, so renaming the rule cannot widen access.
  if (verdict.decision === 'allow' && verdict.withinReadScope) {
    return {
      decision: 'ask',
      matchedRule: 'read-within-home',
      resolvedPath: verdict.resolvedPath,
      access,
      ...(verdict.resolvedPath !== undefined && { askPaths: [verdict.resolvedPath] }),
    };
  }
  return withAskPaths(toToolDecision(verdict, access));
}

/** Every command substitution in a lexed command line, in source order. */
function collectSubstitutions(segments: ShellSegment[]): ShellSubstitution[] {
  const substitutions: ShellSubstitution[] = [];
  for (const segment of segments) {
    for (const token of segment.tokens) {
      const word = token.kind === 'word' ? token.word : token.redirect.target;
      if (word) substitutions.push(...word.substitutions);
    }
  }
  return substitutions;
}

/**
 * Is a substituted command read-only, so that the substitution itself needs no
 * approval? Every segment in it must be a read by the SAME rules the top level
 * uses — head command on `READ_ONLY_COMMANDS` (`isReadOnlySegment`), no write
 * verb, no write flag such as `sed -i` / `find -delete`, no redirection into a
 * real file. One table, two callers: a command taught to read here is a read
 * at the top level too, and vice versa.
 *
 * Nested substitutions are judged again by the caller's recursion, so
 * `$(echo $(date))` stays exempt while `$(echo $(rm -rf /))` does not.
 */
function checkSubstitutionInner(inner: string): { ok: true } | { ok: false; reason: string } {
  const tokenized = tokenizeShellLite(inner);
  if (!tokenized.ok) return { ok: false, reason: `cannot parse it (${tokenized.error})` };
  if (tokenized.segments.length === 0) return { ok: false, reason: 'it is empty' };
  for (const segment of tokenized.segments) {
    const head = headCommand(segment);
    if (head === undefined) return { ok: false, reason: 'it has no command word to judge' };
    if (isWriteSegment(segment)) return { ok: false, reason: `\`${head.command}\` writes` };
    if (!isReadOnlySegment(segment)) {
      return { ok: false, reason: `\`${head.command}\` is not a read-only command` };
    }
  }
  return { ok: true };
}

/**
 * Decide the command substitutions of one command line.
 *
 * A substitution is exempt when its inner command is read-only (see
 * `checkSubstitutionInner`) AND that inner command passes the ordinary bash
 * rules — so `$(command -v waya)` and `$(cat notes.txt)` run, while
 * `$(cat /etc/passwd)` asks for the path and `$(rm -rf /)` asks for the command.
 * Everything else asks: an inner command outside the read-only list, an empty
 * or unparsable inner command, or nesting deeper than `MAX_CMDSUBST_DEPTH`.
 *
 * Returns `undefined` when the whole command line may continue to be judged.
 */
function evaluateSubstitutions(
  scope: WorkerAccessScope,
  segments: ShellSegment[],
  depth: number,
): ToolAccessDecision | undefined {
  const substitutions = collectSubstitutions(segments);
  if (substitutions.length === 0) return undefined;
  if (depth + 1 > MAX_CMDSUBST_DEPTH) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `command substitution nested deeper than ${MAX_CMDSUBST_DEPTH} levels`,
    };
  }

  for (const substitution of substitutions) {
    const inner = substitution.inner.trim();
    if (inner.length === 0) {
      return { decision: 'ask', matchedRule: 'dynamic-shell', reason: `empty command substitution ${substitution.raw}` };
    }
    const readOnly = checkSubstitutionInner(inner);
    if (!readOnly.ok) {
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: `command substitution ${substitution.raw}: ${readOnly.reason}`,
      };
    }
    const verdict = evaluateBashCommand(scope, inner, depth + 1);
    // A refusal inside the substitution (`sensitiveMode: 'deny'`, or a
    // destructive deny) refuses the whole command; a sensitive ASK is wrapped
    // below instead, so the outer approval still names the entry.
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask') {
      const detail = verdict.reason ?? (verdict.resolvedPath ? `target ${verdict.resolvedPath}` : verdict.matchedRule);
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: `command substitution ${substitution.raw} needs approval: ${detail}`,
        // Carry the inner hit through, so an approval request still names the
        // path (and the sensitive entry) the substituted command would touch.
        ...(verdict.resolvedPath !== undefined && { resolvedPath: verdict.resolvedPath }),
        ...(verdict.matchedEntry !== undefined && {
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
          sensitive: true,
        }),
      };
    }
  }
  return undefined;
}

/**
 * Sensitive-hit sweep for a command the lexer rejected.
 *
 * It can only TIGHTEN a verdict, never loosen one: it splits on the coarse
 * delimiters the old extractor used, treats every absolute / `~` word as a
 * WRITE and returns only when the policy says the word is on the sensitive
 * list. The mode decides what that means: `sensitiveMode: 'deny'` refuses the
 * command, `ask` (default) escalates it carrying the matched entry. Either way
 * a syntactically broken line (`tee ~/.ssh/authorized_keys "x`) does not
 * degrade to a bare "cannot parse" ask that hides WHY it matters.
 */
function fallbackSensitiveHit(
  scope: WorkerAccessScope,
  expandedCommand: string,
): ToolAccessDecision | undefined {
  for (const raw of expandedCommand.split(/[\s=]+/)) {
    const word = raw.replace(/^['"]+/, '').replace(/['"]+$/, '');
    if (!word.startsWith('/') && !word.startsWith('~')) continue;
    const expanded = expandHome(word);
    if (expanded.unresolvable) continue;
    const verdict = decidePath(scope, expanded.path, 'write');
    if (verdict.sensitive) return toToolDecision(verdict, 'write');
  }
  return undefined;
}

/**
 * Decide a bash command.
 *
 * The command string is the unit of execution, so every extractable path
 * candidate is judged separately: a candidate that asks makes the WHOLE line
 * ask (a benign `cat` in the same line cannot launder a sensitive `rm` into a
 * silent run), and under `sensitiveMode: 'deny'` one denied candidate refuses
 * it. A candidate carries the access its OWN segment justifies: `write` for a
 * write verb / redirection segment, `read` when the segment's head command is on
 * `READ_ONLY_COMMANDS`, `unknown` for everything the gate has not been taught
 * (the strict mode: "inside home" alone never justifies a write either).
 *
 * The read classification does NOT widen what runs silently: the policy still
 * judges each path, and a policy allow that rests solely on "reads inside home"
 * is narrowed to an approval here (see `narrowHomeRead`) — the same narrowing
 * `evaluateFileAccess` applies to file tools. Only the DIRECTION changes, from
 * `unknown` (which could not even reach that rule) to a named `read`.
 *
 * Ordering: a hard refusal (only reachable under `sensitiveMode: 'deny'`, from
 * the candidate sweep) → destructive-command tier → dynamic constructs (a
 * command substitution that is not read-only, an output redirection into a real
 * file, a command the lexer cannot parse) → the read-only-unverified
 * escalation (a table command that failed its deferred condition) → remaining
 * `ask` candidates (a sensitive ask first, then the ordinary ones) → allow.
 * A hard refusal therefore outranks the destructive-command heuristic, and a
 * sensitive `ask` carries its hit into the approval request.
 *
 * Fallback when the command yields NO path candidate (`ls -la`, `npm test`,
 * `sed -n 1,10p src/cli.ts`): there is nothing for the policy to judge, so the
 * historic rule applies — a dangerous command still asks, anything else runs.
 * The one exception is the read-only-unverified escalation above: a table
 * command that failed its deferred condition asks precisely because the
 * table's "this only reads" promise is what could not be verified.
 * Relative spellings are never candidates, so the sensitive list cannot see
 * them; they are confined by the task workspace (the shell's cwd), as before.
 *
 * Discard redirections (`> /dev/null`, `2>&1`) and read-only command
 * substitutions are exempt from the dynamic tier — see `evaluateSubstitutions`
 * and `classifyRedirections`.
 */
export function evaluateBashAccess(scope: WorkerAccessScope, command: string): ToolAccessDecision {
  return evaluateBashCommand(scope, command, 0);
}

/**
 * The recursive body of `evaluateBashAccess`. `depth` counts how many command
 * substitutions deep this command sits: the outer command is 0, so
 * `$(cat $(echo x))` reaches 2 and a sixth nested `$(` asks instead of being
 * followed any further.
 */
function evaluateBashCommand(
  scope: WorkerAccessScope,
  command: string,
  depth: number,
): ToolAccessDecision {
  // `$HOME` / `${HOME}` are expanded BEFORE lexing so the concrete path the
  // shell would open is what gets judged (and the sensitive list can see it).
  const expandedCommand = expandHomeVars(command);

  const tokenized = tokenizeShellLite(expandedCommand);
  if (!tokenized.ok) {
    // A command the lexer cannot finish is never a silent allow, and a
    // sensitive hit outranks parseability: it is carried as an ask (with the
    // entry named) or refused, according to `sensitiveMode`.
    const hit = fallbackSensitiveHit(scope, expandedCommand);
    if (hit) return hit;
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `could not parse the shell command (${tokenized.error})`,
    };
  }

  const segments = tokenized.segments;
  const redirections = classifyRedirections(segments);

  const candidates: BashCandidate[] = [];
  let hasUnresolvableHome = false;
  for (const candidate of extractPathCandidates(segments)) {
    const expanded = expandHome(candidate.path);
    if (expanded.unresolvable) {
      hasUnresolvableHome = true;
      continue;
    }
    candidates.push({ ...candidate, path: expanded.path });
  }

  let firstAsk: ToolAccessDecision | undefined;
  let firstAllow: ToolAccessDecision | undefined;
  // A sensitive hit asks with a REASON the controller can act on (a named
  // credential location), while an ordinary out-of-scope ask says only "some
  // path is outside the scope". So a sensitive ask is kept apart and wins over
  // an earlier, vaguer one: `cp notes.md ~/.aws/credentials` must report
  // `.aws`, not the first candidate's `outside-all`. It never turns an ask into
  // an allow, so the boundary is unchanged.
  let sensitiveAsk: ToolAccessDecision | undefined;
  // Every candidate path this call asks about. One approval covers ONE path
  // (the task approval memory keys grants per `direction:path`), so the verdict
  // has to name all of them: `cat /etc/a /etc/b` asks for two grants, and a
  // reuse decision is only valid when BOTH are already held.
  const askPaths: string[] = [];
  for (const candidate of candidates) {
    const verdict = decidePath(scope, candidate.path, candidate.access);
    if (verdict.decision === 'deny') return toToolDecision(verdict, candidate.access);
    const narrowed = narrowHomeRead(verdict, candidate);
    if (narrowed.decision === 'ask') {
      const ask: ToolAccessDecision = {
        ...narrowed,
        ...(candidate.reason !== undefined && { reason: candidate.reason }),
      };
      const askingPath = narrowed.resolvedPath ?? candidate.path;
      if (!askPaths.includes(askingPath)) askPaths.push(askingPath);
      if (ask.sensitive === true) sensitiveAsk ??= ask;
      else firstAsk ??= ask;
    } else firstAllow ??= narrowed;
  }

  // The command as a whole is audited under the STRICTEST access its candidates
  // justify (see `commandAccess`); the verdict above still judged each
  // candidate on its OWN access, so a `cat` next to a `tee` is not a write.
  // With no candidate at all (`ls -la`, `git status`) the direction comes from
  // the segments themselves: a wholly read-only line reports `read`.
  const lineAccess =
    candidates.length > 0
      ? commandAccess(candidates)
      : segments.length > 0 && segments.every((segment) => segmentAccess(segment) === 'read')
        ? 'read'
        : 'unknown';
  // The asking paths are attached only to the path-candidate asks. The
  // escalations below (`dangerous-bash`, `dynamic-shell`, `home-other-user`)
  // are NOT "one path, once" decisions and therefore carry none — the approval
  // memory must not reuse a grant for them.
  if (sensitiveAsk) {
    sensitiveAsk = { ...sensitiveAsk, access: lineAccess, ...(askPaths.length > 0 && { askPaths }) };
  }
  if (firstAsk) firstAsk = { ...firstAsk, access: lineAccess, ...(askPaths.length > 0 && { askPaths }) };
  if (firstAllow) firstAllow = { ...firstAllow, access: lineAccess };

  // A hard refusal (above; only under `sensitiveMode: 'deny'`) outranks
  // everything. Then the destructive tier.
  if (DANGEROUS_BASH_PATTERN.test(expandedCommand)) {
    // Still an approval: the destructive-command rule does not decide what the
    // command does to its targets, so `matchedRule` stays `dangerous-bash`. The
    // candidate sweep may ALREADY have found a sensitive hit (`sudo cat
    // ~/.ssh/id_rsa` names `.ssh`) — dropping it would hide from the controller
    // that the command is dangerous AND touches a credential directory, so the
    // hit fields are carried over.
    //
    // Semantic choice for the conflicting flag: `sensitive` here means "this
    // call touches a sensitive-list entry", while the ORIGIN of the verdict
    // stays in `matchedRule` (`dangerous-bash`). Consumers (approval
    // description, signal payload, TUI) key the hit block off `sensitive`, and
    // a dangerous command that hits `.ssh` must show that block too.
    const hit = sensitiveAsk ?? (firstAsk?.matchedEntry !== undefined ? firstAsk : undefined);
    return {
      decision: 'ask',
      matchedRule: 'dangerous-bash',
      access: lineAccess,
      ...(hit !== undefined && {
        matchedEntry: hit.matchedEntry,
        matchedSource: hit.matchedSource,
        resolvedPath: hit.resolvedPath,
        sensitive: true,
      }),
    };
  }

  // Command substitution: the inner command is judged by the same rules
  // (recursively), so `$(cat /etc/passwd)` asks for the path and
  // `$(command -v waya)` does not ask at all.
  const substitution = evaluateSubstitutions(scope, segments, depth);
  if (substitution) return substitution;

  // A redirection whose target cannot be resolved statically asks.
  if (redirections.unresolved !== undefined) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `output redirection target cannot be determined statically (${redirections.unresolved})`,
    };
  }

  // A redirection into a real file: the policy may well allow the target
  // (inside the workspace), but a redirected write is never silent.
  if (redirections.writeTargets.length > 0 && !firstAsk && !sensitiveAsk) {
    return {
      decision: 'ask',
      matchedRule: 'dynamic-shell',
      reason: `output redirection writes a file ("${redirections.writeTargets.join('", "')}")`,
    };
  }

  // Another user's home cannot be resolved — ask, never a silent allow. The
  // reason is surfaced in the approval request so the controller knows WHY.
  if (hasUnresolvableHome) {
    return {
      decision: 'ask',
      matchedRule: 'home-other-user',
      reason: "`~user` names another user's home directory, which cannot be resolved safely",
    };
  }

  if (sensitiveAsk) return sensitiveAsk;

  // A read-only-table command whose deferred condition failed (`sed -f`, a
  // script that executes or writes): the line LOOKS like a reader, and that is
  // exactly what could not be proven. It asks even with no path candidate at
  // all (relative operands only) and even when every candidate sits inside the
  // workspace — an allow must never rest on a verification that failed. The
  // tiers above keep their priority (a sensitive hit still names its entry, a
  // destructive command still reports `dangerous-bash`), a write segment was
  // already settled as a write inside `classifySegment`, and the ask carries
  // no `askPaths`: it is about the command, not one path, so the task
  // approval memory (issue #46) can never cover it with an old grant.
  const unverifiedCommand = unverifiedReadOnlyCommand(segments);
  if (unverifiedCommand !== undefined) {
    return {
      decision: 'ask',
      matchedRule: 'read-only-unverified',
      reason:
        `\`${unverifiedCommand}\` is on the read-only command table, but its script or arguments ` +
        'cannot be verified as read-only — controller approval is required',
      // Never audited as a read: read-only-ness is exactly what failed to
      // verify. A candidate-proven write keeps its direction.
      access: lineAccess === 'write' ? 'write' : 'unknown',
    };
  }

  if (firstAsk) return firstAsk;
  if (firstAllow) return firstAllow;
  // No candidate to judge: the verdict is the historic one, but the line still
  // reports the direction its segments justify, so the audit trail can tell a
  // read-only line (`git status`) from one the gate does not understand
  // (`npm run build`).
  return { decision: 'allow', matchedRule: 'no-path', access: lineAccess };
}

/**
 * Denial message for a sensitive-list refusal. Names the tool and, when the
 * worker supplied one, the path IT asked for — never which sensitive entry
 * matched and never the canonical (possibly symlinked) target, so a refusal
 * discloses nothing the worker didn't already know.
 *
 * A sensitive hit is only refused when the user asked for that
 * (`sensitiveMode: 'deny'`); the default is an approval. So the message says
 * BOTH things: the boundary (it is not a retryable path problem, the rule
 * outranks every allow) and WHY there was no prompt. Without the second half a
 * worker cannot tell "denied, ask the controller for a different route" from
 * "this user configured no prompts", and retries in a loop.
 *
 * `access` picks the direction wording; it defaults to the neutral phrasing, so
 * a caller that does not know the direction stays disclosure-safe.
 */
export function denyMessage(
  toolName: string,
  requestedPath?: string,
  access?: AccessMode,
): string {
  const write = access === 'write';
  const why = '(a protected location; refused without asking — sensitiveMode is "deny")';
  if (toolName === 'bash') {
    return write
      ? `[ERROR] bash: refusing to run this command — it would write to a path on the sensitive list ${why}.`
      : `[ERROR] bash: refusing to run this command — it touches a path on the sensitive list ${why}.`;
  }
  const target = requestedPath ? ` "${requestedPath}"` : '';
  return write
    ? `[ERROR] ${toolName}: refusing to write${target} — the path is on the sensitive list ${why}.`
    : `[ERROR] ${toolName}: refusing access to${target} — the path is on the sensitive list ${why}.`;
}

/**
 * Decide any gated tool call. Unknown tool names are allowed: the middleware
 * only calls this for tools it gates, and a non-path tool has nothing to judge.
 */
export function decideToolAccess(
  scope: WorkerAccessScope,
  toolName: string,
  args: Record<string, unknown>,
): ToolAccessDecision {
  let verdict: ToolAccessDecision;
  if (toolName === 'bash') {
    verdict = evaluateBashAccess(scope, typeof args.command === 'string' ? args.command : '');
  } else if ((FILE_TOOL_NAMES as readonly string[]).includes(toolName)) {
    verdict = evaluateFileAccess(scope, toolName, args);
  } else {
    return { decision: 'allow', matchedRule: 'no-path' };
  }

  if (verdict.decision !== 'deny') return verdict;
  return {
    ...verdict,
    message: denyMessage(toolName, typeof args.path === 'string' ? args.path : undefined, verdict.access),
  };
}
