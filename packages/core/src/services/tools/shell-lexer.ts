/**
 * A deliberately small shell lexer, used to answer two questions the bash
 * permission rules cannot answer with a regex:
 *
 *   1. WHERE does a redirection write? (`2>/dev/null` discards, `2>&1` copies a
 *      descriptor, `> notes.txt` writes a real file — a `>` regex treats all
 *      three the same and prompts for the first two.)
 *   2. WHAT is inside a command substitution? (`$(command -v x)` and
 *      `` `date` `` are read-only; `$(rm -rf /)` is not. Single quotes have to
 *      be literal for this, and `$(` has to be balanced.)
 *
 * This is NOT a shell parser and does not aim to be: it understands quoting,
 * escapes, control operators, redirections and command substitution, and
 * anything it cannot finish is reported as an error. Callers turn an error into
 * `ask` — never `allow` — so a command the lexer misreads is over-approved, not
 * under-approved. No runtime dependency is added (design §A: no `shell-quote` /
 * `bash-parser`).
 *
 * The implementation lives in the `./shell-lexer/` modules (types → scanners →
 * redirects → tokenize, plus classify for the redirection verdict); this file
 * is the stable import surface (`@/services/tools/shell-lexer`).
 */
export { CMDSUBST_PLACEHOLDER } from './shell-lexer/types';
export type {
  ShellSubstitution,
  ShellWord,
  ShellRedirectKind,
  ShellRedirect,
  ShellToken,
  ShellSegment,
  ShellTokenizeResult,
} from './shell-lexer/types';
export { tokenizeShellLite } from './shell-lexer/tokenize';
export { isDiscardRedirectTarget, classifyRedirections } from './shell-lexer/classify';
export type { RedirectionClassification } from './shell-lexer/classify';
