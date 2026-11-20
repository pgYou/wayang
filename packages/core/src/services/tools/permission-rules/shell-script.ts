// Shell `-c` script gate: scripts judged recursively by the same rules as the line itself.

import { CMDSUBST_PLACEHOLDER, tokenizeShellLite, type ShellSegment } from '@/services/tools/shell-lexer';
import { evaluateBashCommand } from './bash-access';
import { headCommand } from './bash-head';
import { MAX_CMDSUBST_DEPTH } from './substitutions';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/** Shells whose `-c` argument is a SCRIPT this gate has to judge itself. */
/**
 * Shells whose `-c` script `evaluateShellScripts` judges recursively. Exported
 * for the #51 capability gate, which must not re-judge a segment whose script
 * was already analyzed here (an allowed inner command keeps the line allowed).
 */
export const SHELL_COMMANDS: ReadonlySet<string> = new Set(['bash', 'sh', 'dash', 'zsh']);

/** Shell options that consume the NEXT word, so it is not the script operand. */
const SHELL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-o', '+o', '-O', '+O', '--rcfile', '--init-file',
]);

/**
 * A command word that still carries an unexpanded variable (``$CMD``): the
 * shell decides at run time what it runs, so it cannot be judged statically.
 */
const DYNAMIC_WORD_PATTERN = /^\$/;

/** What a shell segment was asked to run with `-c` (see `shellScriptOf`). */
interface ShellScript {
  /** The shell itself (`bash`, `sh`, …) — named in the approval reason. */
  shell: string;
  /** The script text as written (the lexer already removed its quoting). */
  script: string;
}

/**
 * The `-c` script a segment runs, if it runs one.
 *
 * `bash -c 'cat ~/.ssh/id_rsa'` hides its real command behind a string
 * argument: the outer line only shows `bash`, which is off the read-only table
 * (→ `unknown`) and yields no path candidate, so the file access went unseen
 * and the line was allowed. `-lc` / `-ic` / `-exc` are the same flag in a
 * cluster and `--command` is the long spelling; all of them take the NEXT word
 * as the script. The lexer already removed the quoting, so the script is the
 * bare command text a shell would run.
 *
 * `bash script.sh` (no `-c`) returns `'script-file'`: a script FILE's contents
 * are not part of the command line this gate judges, so this gate cannot see
 * the inner commands it runs. `evaluateShellScripts` leaves that case alone;
 * `unanalyzedScriptFile` reports it to the #51 fail-closed tier instead.
 */
function shellScriptOf(segment: ShellSegment): ShellScript | 'missing-operand' | 'script-file' | undefined {
  const head = headCommand(segment);
  if (head === undefined || !SHELL_COMMANDS.has(head.command)) return undefined;
  const words = head.words;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') return words[i + 1] === undefined ? undefined : 'script-file';
    if (SHELL_OPTIONS_WITH_VALUE.has(word)) {
      i += 1; // `bash -o pipefail -c '…'`: the option value is not an operand
      continue;
    }
    if (word === '--command') {
      const script = words[i + 1];
      return script === undefined ? 'missing-operand' : { shell: head.command, script };
    }
    if (word.startsWith('--command=')) {
      return { shell: head.command, script: word.slice('--command='.length) };
    }
    if (word.startsWith('--')) continue; // other long flags take no value here
    // The first operand without a `-c` before it is the script FILE: its
    // contents are not on the command line, so (#51) it is reported as an
    // unanalyzed inner command instead of silently returning `undefined`.
    if (!word.startsWith('-')) return 'script-file';
    if (word.slice(1).includes('c')) {
      const script = words[i + 1];
      return script === undefined ? 'missing-operand' : { shell: head.command, script };
    }
  }
  return undefined;
}

/**
 * Can the script be judged as written?
 *
 * `bash -c "$CMD"` and `bash -c "$(cat script.txt)"` hand the shell a string
 * assembled at run time: recursing into the LITERAL text would prove nothing
 * about what actually runs, so both escalate (fail closed) instead of being
 * judged as the harmless words they spell.
 */
function isStaticallyKnownScript(script: string): boolean {
  if (script.includes(CMDSUBST_PLACEHOLDER)) return false;
  const tokenized = tokenizeShellLite(script);
  if (!tokenized.ok) return true; // the recursion reports the parse failure
  return tokenized.segments.every((segment) => {
    const head = headCommand(segment);
    return head === undefined || !DYNAMIC_WORD_PATTERN.test(head.command);
  });
}

/**
 * Decide the `-c` scripts of one command line by the SAME rules as the line
 * itself (recursively, `depth + 1` — the limit is shared with command
 * substitution, see `MAX_CMDSUBST_DEPTH`).
 *
 * The inner verdict is merged as the stricter of the two (`deny` > `ask` >
 * `allow`): `deny` refuses the whole line, `ask` makes the whole line ask — and
 * it keeps the INNER rule name, so an approval for `bash -c 'cat
 * ~/.ssh/id_rsa'` still says `sensitive-list` / `.ssh` instead of a
 * contentless "the shell command might do something".
 *
 * Returns `undefined` when nothing has to be escalated, so the outer line
 * continues to be judged: a `bash -c 'ls -la'` next to a `cat /etc/hosts` must
 * not silence the outer hit.
 */
export function evaluateShellScripts(
  scope: WorkerAccessScope,
  segments: ShellSegment[],
  depth: number,
): ToolAccessDecision | undefined {
  for (const segment of segments) {
    const found = shellScriptOf(segment);
    // A script FILE has no `-c` text to recurse into; its escalation belongs to
    // the #51 fail-closed tier (see `unanalyzedScriptFile`), not here.
    if (found === undefined || found === 'script-file') continue;
    if (found === 'missing-operand') {
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: '`-c` was given without a script to judge',
      };
    }
    if (depth + 1 > MAX_CMDSUBST_DEPTH) {
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: `\`${found.shell} -c\` nested deeper than ${MAX_CMDSUBST_DEPTH} levels`,
      };
    }
    if (found.script.trim().length === 0) continue; // nothing to run
    if (!isStaticallyKnownScript(found.script)) {
      return {
        decision: 'ask',
        matchedRule: 'dynamic-shell',
        reason: `the \`${found.shell} -c\` script is built at run time, so its command cannot be judged statically`,
      };
    }
    const verdict = evaluateBashCommand(scope, found.script, depth + 1);
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask') {
      const detail = verdict.reason ?? (verdict.resolvedPath ? `target ${verdict.resolvedPath}` : verdict.matchedRule);
      return {
        decision: 'ask',
        matchedRule: verdict.matchedRule,
        reason: `\`${found.shell} -c\` script needs approval: ${detail}`,
        // Carry the inner verdict through, so the approval request still names
        // the path (and the sensitive entry) the inner command would touch —
        // and the approval memory can reuse a grant for the same path.
        ...(verdict.access !== undefined && { access: verdict.access }),
        ...(verdict.resolvedPath !== undefined && { resolvedPath: verdict.resolvedPath }),
        ...(verdict.matchedEntry !== undefined && {
          matchedEntry: verdict.matchedEntry,
          matchedSource: verdict.matchedSource,
          sensitive: true,
        }),
        ...(verdict.askPaths !== undefined && { askPaths: verdict.askPaths }),
      };
    }
  }
  return undefined;
}

/**
 * #51: a shell invoked with a SCRIPT FILE operand (`bash script.sh`,
 * `sh deploy.sh`) runs commands whose text is not on the command line, so this
 * gate can neither see nor judge them. `-c` scripts are NOT flagged — they are
 * already judged recursively by `evaluateShellScripts` (see `shellScriptOf`).
 *
 * Returns a shape label for the approval reason, or undefined. No file is read:
 * recognizing the shape is enough to fail closed.
 */
export function unanalyzedScriptFile(segments: readonly ShellSegment[]): string | undefined {
  for (const segment of segments) {
    if (shellScriptOf(segment) !== 'script-file') continue;
    const shell = headCommand(segment)?.command ?? 'shell';
    return `${shell} script file (contents not read)`;
  }
  return undefined;
}
