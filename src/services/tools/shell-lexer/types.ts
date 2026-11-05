// Types and the substitution placeholder shared across the shell-lexer modules.

/** Placeholder standing in for a command substitution inside a word. */
export const CMDSUBST_PLACEHOLDER = '__cmdsubst__';

/** A command substitution found inside a word. */
export interface ShellSubstitution {
  /** Inner command text, exactly as written between the delimiters. */
  inner: string;
  /** The construct as written (`$(...)` or a backticked form) — used in reasons. */
  raw: string;
}

/** A shell word after quote removal; substitutions collapse to a placeholder. */
export interface ShellWord {
  /** Word text with quoting/escapes removed and every substitution replaced. */
  text: string;
  /** Command substitutions inside this word, in source order. */
  substitutions: ShellSubstitution[];
}

/** What a redirection does with its target. */
export type ShellRedirectKind = 'output' | 'input' | 'fd-dup' | 'here-doc' | 'here-string';

export interface ShellRedirect {
  /** Operator as written (`>`, `>>`, `2>`, `&>`, `&>>`, `2>&1`, `<<`, `<<<`, …). */
  operator: string;
  kind: ShellRedirectKind;
  /** Output fd for `N>`; `2` for `&>`; undefined otherwise. */
  fd?: number;
  /** The target word; absent for file-descriptor duplication. */
  target?: ShellWord;
}

export type ShellToken =
  | { kind: 'word'; word: ShellWord }
  | { kind: 'redirect'; redirect: ShellRedirect };

/** One command of a command line (a pipeline stage, a `&&` branch, …). */
export interface ShellSegment {
  tokens: ShellToken[];
}

/** Lexer result: the segments, or why the command could not be parsed. */
export type ShellTokenizeResult = { ok: true; segments: ShellSegment[] } | { ok: false; error: string };

/** A heredoc whose body still has to be skipped. */
export interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}
