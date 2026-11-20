// The command POSITION of a shell segment: wrapper prefixes and assignments skipped, plus the destructive-command tier.

import { CMDSUBST_PLACEHOLDER, type ShellSegment } from '@/services/tools/shell-lexer';
import { isDangerousCommand, isWrapperCommand } from './command-tables';

/**
 * Command words that always require controller approval, whatever their targets
 * are — the `danger` mark in the command table (see `command-tables.ts`).
 * Membership is judged on the command position `headCommand` computes — NOT on
 * a line-start regex. The two used to disagree: the regex only matched a verb
 * at the start of the line or right after `|` / `;` / `&&`, while the path
 * rules already stripped wrapper prefixes, so `rm -rf x` asked and
 * `nohup rm -rf x` / `nice rm -rf x` / `env FOO=1 rm -rf x` fell straight
 * through to `allow (no-path)`. Reading the command position makes both paths
 * agree by construction: whatever `cat ~/x` may be judged as, `rm ~/x` may be
 * judged as `rm`.
 *
 * `rm` / `dd` / `kill` carry an arity or flag condition (see `isDangerousHead`),
 * the rest are dangerous as soon as they are the command word.
 */

/**
 * Commands that only launch another command — the `wrapper` mark in the
 * command table. The real command sits behind them, so a segment's head word
 * is the first word that is not a leading variable assignment and not one of
 * these prefixes (`sudo cat x`, `env FOO=1 cat x`, `nohup time cat x`).
 * Skipping them is what lets `sudo cat ~/notes.md` be judged as the read it
 * is — the destructive-command tier still asks for the `sudo` itself.
 */

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

/** The word tokens of a segment, in source order (redirections dropped). */
function segmentWords(segment: ShellSegment): string[] {
  const words: string[] = [];
  for (const token of segment.tokens) {
    if (token.kind === 'word') words.push(token.word.text);
  }
  return words;
}

/**
 * Index of the command word in `words`: leading assignments skipped, wrapper
 * prefixes (with their own arguments) skipped. `words.length` when the segment
 * has no command word (only wrappers and their options, e.g. `sudo -i`).
 *
 * Shared by `headCommand` and the destructive-command tier, so BOTH read the
 * same command position — that is what keeps their verdicts aligned.
 */
function headIndex(words: readonly string[]): number {
  let i = 0;
  while (i < words.length) {
    if (ASSIGNMENT_PATTERN.test(words[i])) {
      i += 1;
      continue;
    }
    if (!isWrapperCommand(words[i])) break;
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
  return i;
}

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
export function headCommand(segment: ShellSegment): { command: string; words: string[] } | undefined {
  const words = segmentWords(segment);
  const i = headIndex(words);
  const command = words[i];
  if (command === undefined || command === CMDSUBST_PLACEHOLDER) return undefined;
  return { command, words: words.slice(i) };
}

/**
 * Is this command word destructive? `words` starts AT the command word, so the
 * arity / flag conditions (`rm` needs an operand, `kill` needs `-9`) are read
 * from its own arguments — the same shape the old line-start regex matched.
 */
function isDangerousHead(command: string, words: readonly string[]): boolean {
  if (isDangerousCommand(command) || command.startsWith('mkfs.')) return true;
  if (command === 'rm' || command === 'dd') return words.length > 1;
  if (command === 'kill') return words.includes('-9');
  return false;
}

/**
 * Does this segment run a destructive command?
 *
 * Judged at the command position (`headIndex`), so a strip-able wrapper does
 * not hide the verb: `nohup rm -rf x`, `nice -n 5 rm -rf x` and
 * `env FOO=1 rm -rf x` are as dangerous as `rm -rf x`. A wrapper that is
 * itself dangerous (`sudo rm …`) is caught through its own word, even when it
 * leaves no command word behind (`sudo -i`), because the tier is about what
 * the line can do, not about which word ends up last.
 */
function isDangerousSegment(segment: ShellSegment): boolean {
  const words = segmentWords(segment);
  const index = headIndex(words);
  const head = words[index];
  if (head === undefined || head === CMDSUBST_PLACEHOLDER) {
    return words.some((word) => isDangerousCommand(word) || word.startsWith('mkfs.'));
  }
  if (words.slice(0, index).includes('sudo')) return true;
  return isDangerousHead(head, words.slice(index));
}

/** Does ANY segment of the command line run a destructive command? */
export function isDangerousCommandLine(segments: readonly ShellSegment[]): boolean {
  return segments.some((segment) => isDangerousSegment(segment));
}
