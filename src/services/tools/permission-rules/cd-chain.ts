// The `cd` slice of a command line: a local cwd cursor walked over leading literal `cd` segments.

import { normalizePath } from '@/infra/permission/policy';
import { CMDSUBST_PLACEHOLDER, type ShellSegment } from '@/services/tools/shell-lexer';
import { decidePath, narrowHomeRead, toToolDecision } from './access-verdict';
import { expandHome } from './home-expansion';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/**
 * A `cd` chain resolved so far: the segments still to analyze, and — when the
 * chain itself decided the command — the verdict.
 */
export interface CdChainResult {
  /** The segments this gate still has to judge (the leading `cd`s are consumed). */
  segments: ShellSegment[];
  /** Present when the slice already decided the command (an ask or a refusal). */
  decision?: ToolAccessDecision;
  /**
   * The cwd cursor AFTER the consumed `cd` run (#51 layer 2): relative paths in
   * the remaining segments resolve against this directory. Undefined when the
   * slice stopped on a decision (the caller returns it before judging the rest).
   */
  cwd?: string;
}

/**
 * Words a `cd` target must not contain to count as a LITERAL path.
 *
 * The lexer has already removed quotes and escapes, so whatever survives here is
 * what the shell would expand: `$` / backtick (a parameter or a command
 * substitution), and the glob metacharacters (`*`, `?`, `[...]`, `{…}`). None of
 * them name a path this gate could canonicalize, so each keeps the #51
 * fail-closed ask instead of being "resolved".
 */
const NON_LITERAL_TARGET_CHARS = /[$`*?[\]{}]/;

/**
 * The target of a literal `cd <path>` segment, or undefined when the segment is
 * not exactly that shape.
 *
 * "Exactly" is the point: two word tokens and nothing else, the first spelled
 * `cd`, the second a non-empty literal path that is not `-` (which means
 * OLDPWD, a value this gate cannot know). A redirection, an extra operand, a
 * wrapper prefix or a substitution all fail the shape and are left to the #51
 * fallback.
 */
export function literalCdTarget(segment: ShellSegment): string | undefined {
  if (segment.tokens.length !== 2) return undefined;
  const [command, argument] = segment.tokens;
  if (command.kind !== 'word' || argument.kind !== 'word') return undefined;
  if (command.word.text !== 'cd') return undefined;
  if (command.word.substitutions.length > 0) return undefined;
  const target = argument.word.text;
  if (target === '' || target === '-') return undefined;
  if (argument.word.substitutions.length > 0) return undefined;
  if (target.includes(CMDSUBST_PLACEHOLDER)) return undefined;
  if (NON_LITERAL_TARGET_CHARS.test(target)) return undefined;
  return target;
}

/** Why the chain asks about `target` — one of the three shapes the controller can act on. */
function cdAskReason(scope: WorkerAccessScope, argument: string, abs: string, verdict: ToolAccessDecision): string {
  if (verdict.sensitive === true && verdict.matchedEntry !== undefined) {
    return `cd target "${argument}" is the sensitive location ${verdict.matchedEntry} (${abs}) — controller approval is required`;
  }
  if (verdict.matchedRule === 'read-within-home') {
    return `cd target "${argument}" is inside the home directory (${abs}) — controller approval is required`;
  }
  return `cd target "${argument}" resolves outside the allowed scope (${abs}) — controller approval is required`;
}

/**
 * Walk the leading `cd <literal path>` segments of a command line with a LOCAL
 * cwd cursor, and judge each target against the same policy the rest of the bash
 * gate uses.
 *
 * Issue #51 escalates every `cd <dir> && …` because a `cd` re-bases the relative
 * paths of the segments after it, and those relative spellings are (by historic
 * design) not path candidates at all — so nothing checked where they land. This
 * slice answers the narrower question that actually matters: where does the
 * shell END UP? Each target is expanded (`~` only — `~user` stays unresolvable
 * and keeps the #51 ask), made absolute against the CURSOR, canonicalized with
 * the policy's own `normalizePath` (deepest existing ancestor + missing tail,
 * so a symlinked ancestor cannot smuggle the target elsewhere) and judged as a
 * READ.
 *
 * Landing inside the allowed scope means every relative path the following
 * segments name is confined to a directory this gate has already vetted, so the
 * chain may cross the `&&` and the consumed `cd` segments drop out of the
 * analysis. Landing anywhere else — a sensitive location, the readable-but-not-
 * silent part of home, outside the scope entirely — asks, naming the target, the
 * canonical path and WHY. Nothing about the slice can turn an ask into an allow:
 * an unjudged shape keeps the #51 fallback, and a subject that is not a
 * `cd`-only `&&` chain stops the walk at once (`;`, `||`, `|` are never crossed).
 *
 * The cursor is a plain local variable: the function is pure apart from the
 * read-only `realpath` lookups the policy itself performs, it holds no state
 * between calls, and it starts from the scope's workspace — the shell's cwd.
 */
export function applyCdChain(scope: WorkerAccessScope, segments: readonly ShellSegment[]): CdChainResult {
  let cwd = scope.workspace;
  let i = 0;

  while (i + 1 < segments.length && segments[i].operator === '&&') {
    const argument = literalCdTarget(segments[i]);
    if (argument === undefined) break;
    const expanded = expandHome(argument);
    // `~user` names another user's home — the #51 tier reports it, unchanged.
    if (expanded.unresolvable) break;

    const abs = normalizePath(expanded.path, { base: cwd });
    const verdict = decidePath(scope, abs, 'read');
    if (verdict.decision === 'deny') {
      return { segments: segments.slice(i), decision: toToolDecision(verdict, 'read') };
    }
    // The policy allows reads anywhere under home; a worker's silent scope is
    // narrower (see `narrowHomeRead`), so the same narrowing applies here.
    const narrowed = narrowHomeRead(verdict, { path: abs, access: 'read' });
    if (narrowed.decision === 'ask') {
      return {
        segments: segments.slice(i),
        decision: { ...narrowed, reason: cdAskReason(scope, argument, abs, narrowed) },
      };
    }
    cwd = abs;
    i += 1;
  }

  // Nothing consumed: the original segments go back untouched, so the #51
  // fallback sees exactly the shape it saw before this slice existed. `cwd` is
  // where the cursor ended up — the shell's directory for the remaining
  // segments, which the #51 capability gate resolves relative paths against.
  return { segments: segments.slice(i), cwd };
}
