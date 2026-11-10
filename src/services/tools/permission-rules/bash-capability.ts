// #51 layer 2 — the capability gate: every segment classifies as
// read / write / exec / network / dynamic / unknown, and the historic
// "no path candidate → allow" fallback is replaced by a gate that allows only
// what the capability tables justify: reads inside the allowed directories,
// writes whose resolved targets stay inside the workspace.

import { resolve as resolvePath, sep } from 'node:path';
import {
  CMDSUBST_PLACEHOLDER,
  isDiscardRedirectTarget,
  type ShellSegment,
} from '@/services/tools/shell-lexer';
import { decidePath, narrowHomeRead, toToolDecision } from './access-verdict';
import { isReadOnlySegment, isWriteCommandHead } from './bash-classification';
import { headCommand } from './bash-head';
import { SHELL_COMMANDS } from './shell-script';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/** What ONE segment is capable of, beyond the read/write access split. */
export type SegmentCapability =
  | 'read'
  | 'write'
  | 'exec'
  | 'network'
  | 'dynamic'
  | 'unknown';

/**
 * Shells and interpreters at the command position: what they actually do is
 * decided by the script they run, not by the verb, so the verb alone cannot
 * justify a silent allow — `python -c '…'`, `awk 'BEGIN{system(…)}'` and
 * `bash <<EOF` all ask. `bash -c` scripts were already judged recursively by
 * `evaluateShellScripts` before this gate runs.
 */
const INTERPRETER_COMMANDS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'dash', 'zsh', 'ksh', 'busybox',
  'python', 'python3', 'node', 'perl', 'ruby', 'awk', 'php', 'lua',
]);

/** Commands whose primary effect is reaching the network. */
const NETWORK_COMMANDS: ReadonlySet<string> = new Set(['curl', 'wget', 'nc', 'scp']);

/** Write verbs beyond `BASH_WRITE_VERBS` (which `isWriteSegment` reads). */
const WRITE_CAPABILITY_COMMANDS: ReadonlySet<string> = new Set(['rsync']);

/**
 * Launchers `headCommand` does NOT strip (it strips sudo / env / nohup / time /
 * nice / ionice / command / exec / builtin): the inner command sits behind the
 * launcher's own arguments, so the head word itself must be unfolded here.
 * `ssh` is folded in: with no remote command it is pure network, with one it
 * launches that command on the far side.
 */
const LAUNCHER_COMMANDS: ReadonlySet<string> = new Set([
  'script', 'su', 'setsid', 'watch', 'timeout', 'ssh',
]);

/** `source` / `.` run a script inside the current shell — inherently dynamic. */
const DYNAMIC_COMMANDS: ReadonlySet<string> = new Set(['source', '.']);

/** A leading shell variable assignment (`FOO=1`), not a command word. */
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Bare numeric words — `timeout 5 cmd`, `watch -n 2 cmd` — not the inner command. */
const NUMERIC_PATTERN = /^\d+$/;
/** A command word built from an expansion (`$X`) or a backtick cannot be judged. */
const DYNAMIC_WORD_PATTERN = /[$`]/;

/** The word tokens of a segment, in source order (redirections dropped). */
function wordTexts(segment: ShellSegment): string[] {
  const words: string[] = [];
  for (const token of segment.tokens) {
    if (token.kind === 'word') words.push(token.word.text);
  }
  return words;
}

/** `of=../x` → `../x`; a word with no `NAME=` prefix comes back unchanged. */
function stripAssignment(word: string): string {
  const match = word.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/);
  return match === null ? word : match[1];
}

/**
 * The RELATIVE operand words of a command (options, absolute / `~` words and
 * command substitutions excluded). Absolute and `~` spellings were already
 * judged as path candidates by the sweep in `evaluateBashCommand`; relative
 * spellings were not — they are the ones this gate resolves against the cwd.
 */
function relativeOperands(words: readonly string[]): string[] {
  const operands: string[] = [];
  for (const word of words.slice(1)) {
    if (word.startsWith('-')) continue;
    if (word.includes(CMDSUBST_PLACEHOLDER)) continue;
    const value = stripAssignment(word);
    if (value === '' || value.startsWith('/') || value.startsWith('~')) continue;
    operands.push(value);
  }
  return operands;
}

/** Does this segment redirect stdout/stderr into a real (non-discard) file? */
function hasOutputRedirect(segment: ShellSegment): boolean {
  for (const token of segment.tokens) {
    if (token.kind !== 'redirect') continue;
    const { redirect } = token;
    if (redirect.kind !== 'output') continue;
    if (isDiscardRedirectTarget(redirect.target?.text)) continue;
    return true;
  }
  return false;
}

/** This segment's relative `< file` input targets (absolute ones were candidates). */
function relativeInputTargets(segment: ShellSegment): string[] {
  const targets: string[] = [];
  for (const token of segment.tokens) {
    if (token.kind !== 'redirect') continue;
    const { redirect } = token;
    if (redirect.kind !== 'input') continue;
    const target = redirect.target?.text;
    if (target === undefined || isDiscardRedirectTarget(target)) continue;
    if (target.includes(CMDSUBST_PLACEHOLDER)) continue;
    if (target.startsWith('/') || target.startsWith('~')) continue;
    targets.push(target);
  }
  return targets;
}

/** Is `abs` the workspace itself or somewhere underneath it? */
function insideWorkspace(scope: WorkerAccessScope, abs: string): boolean {
  const workspace = resolvePath(scope.workspace);
  return abs === workspace || abs.startsWith(`${workspace}${sep}`);
}

/** Classify a word list from its first non-assignment word (the command). */
function capabilityFromWords(words: readonly string[]): SegmentCapability {
  let start = 0;
  while (start < words.length && ASSIGNMENT_PATTERN.test(words[start])) start += 1;
  const command = words[start];
  if (command === undefined) return 'unknown';
  return capabilityOfHead(command, words.slice(start));
}

/**
 * The launcher split: `timeout 5 python x`, `watch -n 2 ls`, `su -c true` all
 * hide the real command behind the launcher's arguments. The first word that is
 * neither an option nor a bare number is taken as the inner command and
 * classified recursively; `script` / `su` with `-c` take the option's VALUE
 * (a command string) as the inner line; `ssh` skips the host first and is pure
 * network when nothing follows it. No inner command found → `exec`.
 */
function launcherCapability(command: string, words: readonly string[]): SegmentCapability {
  const args = words.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if ((command === 'script' || command === 'su') && word === '-c') {
      const script = args[i + 1];
      return script === undefined
        ? 'exec'
        : capabilityFromWords(script.split(/\s+/).filter(Boolean));
    }
    if (word.startsWith('-')) continue;
    if (NUMERIC_PATTERN.test(word)) continue;
    if (command === 'ssh') {
      const remote = args.slice(i + 1).filter((w) => !w.startsWith('-'));
      return remote.length === 0 ? 'network' : capabilityFromWords(remote);
    }
    return capabilityFromWords(args.slice(i));
  }
  return 'exec';
}

/** Classify a command word (with its words, starting at the command itself). */
function capabilityOfHead(command: string, words: readonly string[]): SegmentCapability {
  if (DYNAMIC_WORD_PATTERN.test(command) || command.includes(CMDSUBST_PLACEHOLDER)) return 'dynamic';
  if (DYNAMIC_COMMANDS.has(command)) return 'dynamic';
  // `git -c <name>=<value>` pulls in external configuration before the
  // subcommand runs — the read classification does not cover that shape.
  if (command === 'git' && words.slice(1).includes('-c')) return 'unknown';
  // `env -S <string>` builds a command line from the string: a shell shape.
  if (command === 'env' && words.includes('-S')) return 'exec';
  if (LAUNCHER_COMMANDS.has(command)) return launcherCapability(command, words);
  if (INTERPRETER_COMMANDS.has(command)) return 'exec';
  if (NETWORK_COMMANDS.has(command)) return 'network';
  if (WRITE_CAPABILITY_COMMANDS.has(command)) return 'write';
  return 'unknown';
}

/**
 * Does this segment carry a `-c` script that `evaluateShellScripts` has ALREADY
 * judged recursively (bash / sh / dash / zsh only — `ksh` and friends are not
 * on that table, so for them the head word itself stays the verdict)? Such a
 * segment contributes nothing to the capability gate: reaching this point
 * means the inner script was analyzed and allowed.
 */
function isJudgedShellScript(head: { command: string; words: string[] }): boolean {
  if (!SHELL_COMMANDS.has(head.command)) return false;
  return head.words
    .slice(1)
    .some(
      (word) =>
        word === '-c' ||
        word.startsWith('--command') ||
        (word.startsWith('-') && !word.startsWith('--') && word.includes('c')),
    );
}

/**
 * The capability of ONE segment. A redirection into a real file settles the
 * segment as a write FIRST (exactly like `classifySegment`); a write VERB at
 * the command position (head-based, so an `install` in argument position of
 * `npm` does not count) is a write; a verified read-only table command is a
 * read; a shell whose `-c` script was already judged recursively contributes
 * nothing; everything else is classified from its head word — exec, network,
 * dynamic, or unknown.
 */
export function segmentCapability(segment: ShellSegment): SegmentCapability {
  if (hasOutputRedirect(segment)) return 'write';
  const head = headCommand(segment);
  if (head !== undefined && isJudgedShellScript(head)) return 'read'; // already judged inside
  if (head !== undefined && isWriteCommandHead(head.command, head.words)) return 'write';
  if (isReadOnlySegment(segment)) return 'read';
  if (head === undefined) {
    // No command word: assignments only, a wrapper that consumed everything
    // (`sudo -i`, already escalated by the destructive tier), or a command
    // substitution sitting IN the command position (judged by the
    // substitution tier; fail closed here). The `env -S` shape is exec.
    const words = wordTexts(segment);
    let i = 0;
    while (i < words.length && ASSIGNMENT_PATTERN.test(words[i])) i += 1;
    const first = words[i];
    if (first === undefined) return 'unknown';
    if (first === 'env' && words.includes('-S')) return 'exec';
    if (DYNAMIC_WORD_PATTERN.test(first) || first.includes(CMDSUBST_PLACEHOLDER)) return 'dynamic';
    return 'unknown';
  }
  return capabilityOfHead(head.command, head.words);
}

/** The head word of a segment, for the ask reasons. */
function headWord(segment: ShellSegment): string {
  const head = headCommand(segment);
  if (head !== undefined) return head.command;
  const words = wordTexts(segment);
  return words.find((word) => !ASSIGNMENT_PATTERN.test(word)) ?? words[0] ?? '…';
}

function ask(matchedRule: ToolAccessDecision['matchedRule'], reason: string): ToolAccessDecision {
  return { decision: 'ask', matchedRule, reason };
}

/**
 * The #51 layer 2 gate. Called from `evaluateBashCommand` after every earlier
 * tier kept its priority; it receives the post-`cd`-slice segments and the cwd
 * cursor the slice ended on. Returns `undefined` when the line may run
 * silently — every segment sits in a capability table AND its targets stay in
 * scope — or the escalation to surface instead of the historic allow.
 *
 * Ordering across segments: a dynamic construct or an out-of-workspace write
 * target (the two shapes that say something specific about WHAT runs) wins
 * over a read path ask, which wins over the capability classes exec → network
 * → unknown. All of them are asks; the order only picks the reason.
 */
export function evaluateCapabilityGate(
  scope: WorkerAccessScope,
  segments: readonly ShellSegment[],
  cursor: string,
): ToolAccessDecision | undefined {
  let execAsk: ToolAccessDecision | undefined;
  let networkAsk: ToolAccessDecision | undefined;
  let unknownAsk: ToolAccessDecision | undefined;

  for (const segment of segments) {
    const capability = segmentCapability(segment);

    if (capability === 'dynamic') {
      const word = headWord(segment);
      const reason = DYNAMIC_COMMANDS.has(word)
        ? `\`${word}\` runs a script inside the current shell — controller approval is required`
        : `the command word "${word}" is dynamically constructed — controller approval is required`;
      return ask('dynamic-shell', reason);
    }

    if (capability === 'write') {
      const head = headCommand(segment);
      const operands = relativeOperands(head !== undefined ? head.words : wordTexts(segment));
      for (const operand of operands) {
        const abs = resolvePath(cursor, operand);
        if (!insideWorkspace(scope, abs)) {
          return ask(
            'write-scope',
            `write target "${operand}" resolves outside the workspace (${abs}) — controller approval is required`,
          );
        }
      }
      continue;
    }

    if (capability === 'read') {
      const head = headCommand(segment);
      const operands = head !== undefined ? relativeOperands(head.words) : [];
      for (const operand of [...operands, ...relativeInputTargets(segment)]) {
        const abs = resolvePath(cursor, operand);
        const verdict = decidePath(scope, abs, 'read');
        if (verdict.decision === 'deny') return toToolDecision(verdict, 'read');
        const narrowed = narrowHomeRead(verdict, { path: abs, access: 'read' });
        if (narrowed.decision === 'ask') {
          return { ...narrowed, askPaths: [narrowed.resolvedPath ?? abs] };
        }
      }
      continue;
    }

    if (capability === 'exec') {
      execAsk ??= ask(
        'exec-capability',
        `\`${headWord(segment)}\` runs a shell or interpreter — controller approval is required (exec capability)`,
      );
    } else if (capability === 'network') {
      networkAsk ??= ask(
        'network-capability',
        `\`${headWord(segment)}\` reaches the network — controller approval is required (network capability)`,
      );
    } else if (capability === 'unknown') {
      unknownAsk ??= ask(
        'unknown-capability',
        `\`${headWord(segment)}\` is not on the bash capability tables — controller approval is required (unknown capability)`,
      );
    }
  }

  return execAsk ?? networkAsk ?? unknownAsk;
}

/**
 * The write-scope check for output redirection targets (issue #51 layer 2),
 * called from the redirection tier of `evaluateBashCommand`. Relative targets
 * were never path candidates, so they are resolved against the cwd cursor
 * here: every target inside the workspace → `undefined` (the capability gate
 * allows the write); any target escaping it → a `write-scope` ask. Absolute
 * and `~` spellings were already judged by the candidate sweep and are left
 * to the verdict that sweep produced.
 */
export function redirectWriteScopeAsk(
  scope: WorkerAccessScope,
  targets: readonly string[],
  cursor: string,
): ToolAccessDecision | undefined {
  for (const target of targets) {
    if (target.startsWith('/') || target.startsWith('~')) continue;
    const abs = resolvePath(cursor, target);
    if (!insideWorkspace(scope, abs)) {
      return ask(
        'write-scope',
        `output redirection target "${target}" resolves outside the workspace (${abs}) — controller approval is required`,
      );
    }
  }
  return undefined;
}
