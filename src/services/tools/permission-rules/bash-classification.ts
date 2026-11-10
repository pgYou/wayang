// Segment classification: does one shell segment READ, WRITE, or neither?

import type { AccessMode } from '@/infra/permission/policy';
import { isDiscardRedirectTarget, type ShellSegment } from '@/services/tools/shell-lexer';
import {
  GIT_READ_SUBCOMMANDS,
  isReadCommand,
  isWriteCommand,
  writeFlagsOf,
} from './command-tables';
import { headCommand } from './bash-head';
import { isReadOnlySedScript, sedScriptsOf } from './sed-analysis';

/**
 * Commands that only READ what they are pointed at — the `read` capability of
 * the command table (see `command-tables.ts`).
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

/**
 * Commands that write to the paths they name — the `write` capability of the
 * command table. A candidate in the same command segment as one of these is
 * judged as a WRITE (so a sensitive target asks as an approved-once write, or
 * is refused outright under `sensitiveMode: 'deny'`).
 *
 * This is the write half of the direction split: `rm ~/.ssh/x` and
 * `cat ~/.ssh/x` both escalate, but the first reports `access: write` and the
 * second `access: read`, and a refusal names the direction it refused.
 * A command missing from this table loses no safety —
 * it is judged `unknown` (see the read half above), which the policy treats
 * as a write for scope purposes.
 */

/**
 * Verbs that write only with a specific flag (`sed -i`, `find -delete`, …) —
 * the table's `writeFlags`. Both the verb and one of its flags must appear in
 * the same segment.
 */

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
    if (isWriteCommand(word)) return true;
    const flags = writeFlagsOf(word);
    if (flags && flags.some((flag) => words.some((other) => isFlagWord(other, flag)))) return true;
  }
  return false;
}

/**
 * Is the COMMAND WORD a write verb (optionally gated on a flag — `sed -i`)?
 * Unlike `isWriteSegment` this ignores words in ARGUMENT position, so
 * `npm install axios` (the word `install` as an argument) is not a write.
 */
export function isWriteCommandHead(command: string, words: readonly string[]): boolean {
  if (isWriteCommand(command)) return true;
  const flags = writeFlagsOf(command);
  return flags !== undefined && flags.some((flag) => words.some((other) => isFlagWord(other, flag)));
}

/**
 * git subcommands that only read — `GIT_READ_SUBCOMMANDS`, derived from the
 * command table's `git` entry. `git` itself is a `read`-capability command, so
 * everything else — `clean`, `checkout`, `reset`, `push`, `commit`, `stash`, …
 * — falls back to `unknown` and keeps the old verdict.
 */

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
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return true;
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
   * The head command when it is a table read but the deferred condition
   * attached to it failed — `sed` (a script that executes, writes, or cannot
   * be located at all) and `date` (`-s` / `--set` sets the clock). A future
   * condition on `find` / `git` would plug in here. Never set on a write
   * segment: a write verb / flag / redirection settles the segment as a
   * write FIRST, whatever the table says.
   */
  unverified?: string;
}

/**
 * Does this word set the system clock on `date`? `-s`, `--set`, `--set=…` and
 * short clusters carrying the `s` (`-us`, `-ds`) — `-u` / `-d` alone only
 * change the DISPLAY; `-s` mutates state, so it must never ride a silent
 * classification (read-only table or inert).
 */
export function isDateSetFlag(word: string): boolean {
  if (word === '-s' || word.startsWith('--set')) return true;
  return /^-[^-]*s/.test(word);
}

/**
 * Classify one segment: `write` when it certainly writes (write verb, write
 * flag, or a redirection into a real file — `isWriteSegment`), `read` when its
 * head command is a table read AND every deferred condition attached to it
 * holds, `unknown` otherwise. Segments are judged independently so a `cat`
 * next to a `tee` keeps its own direction.
 */
function classifySegment(segment: ShellSegment): SegmentClassification {
  if (isWriteSegment(segment)) return { mode: 'write' };
  const head = headCommand(segment);
  if (head === undefined) return { mode: 'unknown' };
  if (!isReadCommand(head.command)) return { mode: 'unknown' };
  if (head.command === 'git') {
    // `git`'s subcommand check is a classifier, not a deferred condition: a
    // non-read subcommand is DETERMINED not to be a read (like an off-table
    // command), not "a reader we failed to verify". It therefore stays
    // `unknown` and keeps the historic no-candidate allow (`git clone …`).
    return { mode: isReadOnlyGitCommand(head.words) ? 'read' : 'unknown' };
  }
  // `date -s` / `--set` sets the clock: the read table's promise ("only
  // reads") fails exactly like `sed -f`'s, so the shape escalates as
  // `unverified` instead of riding the table (see `unverifiedReadOnlyCommand`).
  if (head.command === 'date') {
    const sets = head.words.slice(1).some(isDateSetFlag);
    if (sets) return { mode: 'unknown', unverified: 'date' };
    return { mode: 'read' };
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
 * The first head command that is a table read but FAILED the deferred
 * condition attached to it (see `classifySegment`), or undefined. This is the
 * fail-closed signal for the top level: such a line must not run silently
 * just because it produced no asking path candidate (relative operands only)
 * or only candidates the policy would allow — the table's promise ("this
 * command only reads") is exactly what failed to verify.
 */
export function unverifiedReadOnlyCommand(segments: readonly ShellSegment[]): string | undefined {
  for (const segment of segments) {
    const { unverified } = classifySegment(segment);
    if (unverified !== undefined) return unverified;
  }
  return undefined;
}

/**
 * #51 fail-closed tier: shell shapes that carry an INNER command this gate
 * never analyzes. Judged on the command position (see `headCommand`), so a
 * wrapper prefix does not hide the shape and a shape word used as a mere
 * argument (`echo xargs`) does not trip it.
 *
 * `bash -c` / `sh -c` scripts are deliberately NOT here — `evaluateShellScripts`
 * already judges them recursively — and a script FILE operand is handled by
 * `unanalyzedScriptFile` in `shell-script.ts`. No parser is added: recognizing
 * the shape is enough to escalate, and the returned label names it so the
 * approval reason can say WHY the line is being asked about.
 */

/** find flags that hand control to ANOTHER command (an unanalyzed inner command). */
const FIND_INNER_COMMAND_FLAGS: ReadonlySet<string> = new Set([
  '-exec', '-execdir', '-ok', '-okdir',
]);

/**
 * Heads that re-base the cwd, so every relative path in the segments AFTER them
 * changes meaning. `cd` is spelled `cd`, but the lexer keeps a leading
 * parenthesis inside the word — `(cd …` is a SUBSHELL, which restores the old
 * cwd and is therefore exactly the shape a per-line cursor cannot follow.
 */
const CD_HEAD_PATTERN = /^\(*cd$/;

/**
 * Process the directory STACK rather than a plain working directory:
 * `pushd <dir> && …` re-bases later relative paths exactly like `cd`, `popd`
 * jumps to a directory whose value only the running shell knows. Neither can be
 * resolved statically, so both fail closed like the `cd` shape.
 */
const DIRECTORY_STACK_COMMANDS: ReadonlySet<string> = new Set(['pushd', 'popd']);

/** Shell control-flow keywords: a segment whose command word is one of these opens an inner command. */
const COMPOUND_KEYWORDS: ReadonlySet<string> = new Set([
  'for', 'while', 'until', 'do', 'done', 'if', 'then', 'else', 'elif', 'fi',
  'case', 'esac', 'select', 'function', '{', '}',
]);

/**
 * The first unanalyzed-inner-command shape among `segments` (a label for the
 * approval reason), or undefined. A cwd change is a shape only when another
 * segment follows it — a bare `cd` has no inner command, and `cd <dir> && ...`
 * is the form that quietly re-bases every later relative path.
 *
 * Four spellings are recognized, and only LITERAL `cd <dir>` chains are
 * resolved elsewhere (see `applyCdChain`); everything else keeps this
 * fail-closed ask: `cd <dir> && …` (including `cd -`, whose target is OLDPWD and
 * `cd $VAR`, whose target this gate cannot know), the subshell form `(cd …)`
 * (it restores the old cwd, so one cursor cannot follow it) and the directory
 * stack `pushd` / `popd`.
 */
export function unanalyzedInnerCommand(segments: readonly ShellSegment[]): string | undefined {
  for (let i = 0; i < segments.length; i += 1) {
    const head = headCommand(segments[i]);
    if (head === undefined) continue;
    if (head.command === 'xargs') return 'xargs';
    if (head.command === 'eval') return 'eval';
    if (head.command === 'find') {
      const flag = head.words.find((word) => FIND_INNER_COMMAND_FLAGS.has(word));
      if (flag !== undefined) return `find ${flag}`;
    }
    if (COMPOUND_KEYWORDS.has(head.command)) return 'shell compound keyword (for / do / then ...)';
    // A cwd change re-bases the relative paths of everything after it. Only a
    // FOLLOWED segment is a shape: a bare `cd` / `pushd` runs nothing inside.
    if (i < segments.length - 1) {
      if (head.command === 'cd') return 'cd <dir> && ...';
      // `(cd …)` is a subshell — it restores the old cwd, so the line cannot be
      // followed with one cursor, which is why it lands here as its own shape.
      if (CD_HEAD_PATTERN.test(head.command)) return `subshell (${head.command.replace(/^\(+/, '')} ...)`;
      if (DIRECTORY_STACK_COMMANDS.has(head.command)) return `${head.command} <dir> && ...`;
    }
  }
  return undefined;
}
