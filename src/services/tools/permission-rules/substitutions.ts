// Command-substitution gate: `$(…)` interiors are judged by the same rules the top level uses.

import { tokenizeShellLite, type ShellSegment, type ShellSubstitution } from '@/services/tools/shell-lexer';
import { evaluateBashCommand } from './bash-access';
import { headCommand } from './bash-head';
import { isReadOnlySegment, isWriteSegment } from './bash-classification';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/**
 * How deep command substitutions are followed before giving up. A command
 * nested deeper than this asks: past a few levels the intent is more likely
 * generated code than a diagnostic one-liner.
 */
export const MAX_CMDSUBST_DEPTH = 5;

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
export function evaluateSubstitutions(
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
