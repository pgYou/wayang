// Segment classification: does one shell segment READ, WRITE, or neither?

import type { AccessMode } from '@/infra/permission/policy';
import { isDiscardRedirectTarget, type ShellSegment } from '@/services/tools/shell-lexer';
import { headCommand } from './bash-head';
import { isReadOnlySedScript, sedScriptsOf } from './sed-analysis';

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
export function isWriteSegment(segment: ShellSegment): boolean {
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
export function isReadOnlySegment(segment: ShellSegment): boolean {
  return classifySegment(segment).mode === 'read';
}

/** The access a SINGLE segment justifies — see `classifySegment`. */
export function segmentAccess(segment: ShellSegment): AccessMode {
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
export function unverifiedReadOnlyCommand(segments: readonly ShellSegment[]): string | undefined {
  for (const segment of segments) {
    const { unverified } = classifySegment(segment);
    if (unverified !== undefined) return unverified;
  }
  return undefined;
}
