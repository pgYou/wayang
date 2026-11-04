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
 */

/** Placeholder standing in for a command substitution inside a word. */
export const CMDSUBST_PLACEHOLDER = '__cmdsubst__';

/** Targets whose redirection discards the output instead of writing a file. */
const DISCARD_TARGETS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

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
interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

/** True for a redirection target that discards output (`/dev/null` family). */
export function isDiscardRedirectTarget(target: string | undefined): boolean {
  return target !== undefined && DISCARD_TARGETS.has(target);
}

/** Characters that end a bare word. */
function isWordTerminator(ch: string): boolean {
  return (
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '|' || ch === ';' || ch === '&' || ch === '<' || ch === '>'
  );
}

/** Index of the `"` closing the double-quoted run that starts at `start`, or -1. */
function findClosingDoubleQuote(command: string, start: number): number {
  let i = start + 1;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i;
    i += 1;
  }
  return -1;
}

/** Index of the backtick closing the substitution that starts at `start`, or -1. */
function findClosingBacktick(command: string, start: number): number {
  let i = start + 1;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    i += 1;
  }
  return -1;
}

/**
 * Scan a backticked substitution starting at the backtick. The inner text is
 * kept raw (nested quoting inside backticks is the caller's problem, and the
 * recursive evaluation re-lexes it with the same rules).
 */
function scanBacktickSubstitution(
  command: string,
  start: number,
): { inner: string; next: number } | { error: string } {
  const end = findClosingBacktick(command, start);
  if (end === -1) return { error: 'unbalanced backtick — no closing "`"' };
  return { inner: command.slice(start + 1, end), next: end + 1 };
}

/**
 * Scan a `$(...)` starting at the `$`, honouring quotes, escapes and nested
 * parentheses, so `$(echo $(date))` and `$(stat -c '%s' f)` are not cut short.
 */
function scanDollarSubstitution(
  command: string,
  start: number,
): { inner: string; next: number } | { error: string } {
  const n = command.length;
  let i = start + 2; // past "$("
  let depth = 1;
  let inner = '';
  while (i < n) {
    const ch = command[i] as string;
    if (ch === '\\') {
      inner += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return { error: 'unterminated single quote inside command substitution' };
      inner += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = findClosingDoubleQuote(command, i);
      if (end === -1) return { error: 'unterminated double quote inside command substitution' };
      inner += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = findClosingBacktick(command, i);
      if (end === -1) return { error: 'unterminated backtick inside command substitution' };
      inner += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      inner += ch;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { inner, next: i + 1 };
      inner += ch;
      i += 1;
      continue;
    }
    inner += ch;
    i += 1;
  }
  return { error: 'unbalanced "$(" — no closing ")"' };
}

/**
 * Recognise a command substitution at `start` (either spelling). Returns
 * `undefined` when there is none, so callers fall through to plain text.
 */
function scanSubstitutionAt(
  command: string,
  start: number,
): { substitution: ShellSubstitution; next: number } | { error: string } | undefined {
  const dollarForm = command[start] === '$' && command[start + 1] === '(';
  const backtickForm = command[start] === '`';
  if (!dollarForm && !backtickForm) return undefined;
  const scanned = dollarForm
    ? scanDollarSubstitution(command, start)
    : scanBacktickSubstitution(command, start);
  if ('error' in scanned) return scanned;
  return {
    substitution: { inner: scanned.inner, raw: command.slice(start, scanned.next) },
    next: scanned.next,
  };
}

/** Scan one shell word (quotes removed, substitutions collapsed) starting at `start`. */
function scanWordLite(
  command: string,
  start: number,
): { word: ShellWord; next: number } | { error: string } {
  const n = command.length;
  let i = start;
  let text = '';
  const substitutions: ShellSubstitution[] = [];

  /** Consume one substitution at `i`, appending its placeholder; false when none. */
  const takeSubstitution = (): { ok: true; consumed: boolean } | { ok: false; error: string } => {
    const scanned = scanSubstitutionAt(command, i);
    if (!scanned) return { ok: true, consumed: false };
    if ('error' in scanned) return { ok: false, error: scanned.error };
    substitutions.push(scanned.substitution);
    text += CMDSUBST_PLACEHOLDER;
    i = scanned.next;
    return { ok: true, consumed: true };
  };

  while (i < n) {
    const ch = command[i] as string;

    if (ch === '\\') {
      if (i + 1 < n) {
        text += command[i + 1];
        i += 2;
      } else {
        text += ch;
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      // Single quotes are fully literal: no substitution, no escape handling.
      const end = command.indexOf("'", i + 1);
      if (end === -1) return { error: 'unterminated single quote' };
      text += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        const inner = command[i] as string;
        if (inner === '\\') {
          if (i + 1 < n) {
            text += command[i + 1];
            i += 2;
          } else {
            text += inner;
            i += 1;
          }
          continue;
        }
        if (inner === '"') {
          i += 1;
          closed = true;
          break;
        }
        const taken = takeSubstitution();
        if (!taken.ok) return { error: taken.error };
        if (taken.consumed) continue;
        text += inner;
        i += 1;
      }
      if (!closed) return { error: 'unterminated double quote' };
      continue;
    }

    const taken = takeSubstitution();
    if (!taken.ok) return { error: taken.error };
    if (taken.consumed) continue;

    if (isWordTerminator(ch)) break;
    text += ch;
    i += 1;
  }

  return { word: { text, substitutions }, next: i };
}

/** Scan the `&N` / `&-` tail of a file-descriptor duplication. */
function scanFdDupTail(command: string, start: number): { tail: string; next: number } | { error: string } {
  const match = /^&(\d+|-)/.exec(command.slice(start, start + 8));
  if (!match) return { error: 'unrecognised file-descriptor redirection' };
  return { tail: match[0], next: start + match[0].length };
}

/**
 * Scan the target word of a redirection. Harness scripts write `2> /dev/null`
 * and `2>/dev/null`; both are one redirect with one target.
 */
function scanRedirectTarget(
  command: string,
  start: number,
): { word: ShellWord; next: number } | { error: string } {
  let i = start;
  while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i += 1;
  const ch = command[i];
  if (ch === undefined || isWordTerminator(ch)) return { error: 'redirection without a target' };
  const scanned = scanWordLite(command, i);
  if ('error' in scanned) return scanned;
  if (scanned.word.text.length === 0 && scanned.word.substitutions.length === 0) {
    return { error: 'redirection without a target' };
  }
  return scanned;
}

/** Scan one redirection operator plus its target, starting at the operator character. */
function scanRedirect(
  command: string,
  start: number,
  fd?: number,
):
  | { redirect: ShellRedirect; next: number; heredoc?: PendingHeredoc }
  | { error: string } {
  const ch = command[start] as string;

  // `&>` / `&>>`: stdout AND stderr into one target.
  if (ch === '&') {
    if (command[start + 1] !== '>') return { error: 'unexpected "&" in a redirection' };
    const append = command[start + 2] === '>';
    const target = scanRedirectTarget(command, start + (append ? 3 : 2));
    if ('error' in target) return target;
    return {
      redirect: { operator: append ? '&>>' : '&>', kind: 'output', fd: 2, target: target.word },
      next: target.next,
    };
  }

  if (ch === '<') {
    if (command[start + 1] === '<') {
      // `<<<` is a here-string: its target is DATA, never a path.
      if (command[start + 2] === '<') {
        const target = scanRedirectTarget(command, start + 3);
        if ('error' in target) return target;
        return {
          redirect: { operator: '<<<', kind: 'here-string', target: target.word },
          next: target.next,
        };
      }
      const stripTabs = command[start + 2] === '-';
      const target = scanRedirectTarget(command, start + (stripTabs ? 3 : 2));
      if ('error' in target) return target;
      return {
        redirect: { operator: stripTabs ? '<<-' : '<<', kind: 'here-doc', target: target.word },
        next: target.next,
        heredoc: { delimiter: target.word.text, stripTabs },
      };
    }
    if (command[start + 1] === '&') {
      const dup = scanFdDupTail(command, start + 1);
      if ('error' in dup) return dup;
      return { redirect: { operator: `${fd ?? ''}<${dup.tail}`, kind: 'fd-dup' }, next: dup.next };
    }
    if (command[start + 1] === '>') {
      // `<>` opens the target for reading AND writing — count it as a write.
      const target = scanRedirectTarget(command, start + 2);
      if ('error' in target) return target;
      return {
        redirect: { operator: `${fd ?? ''}<>`, kind: 'output', fd: fd ?? 0, target: target.word },
        next: target.next,
      };
    }
    const target = scanRedirectTarget(command, start + 1);
    if ('error' in target) return target;
    return {
      redirect: { operator: `${fd ?? ''}<`, kind: 'input', target: target.word },
      next: target.next,
    };
  }

  // `>`, `>>`, `>|`
  const append = command[start + 1] === '>';
  let cursor = start + (append ? 2 : 1);
  const clobber = !append && command[cursor] === '|';
  if (clobber) cursor += 1;
  const operator = `${fd ?? ''}${append ? '>>' : '>'}${clobber ? '|' : ''}`;
  if (command[cursor] === '&') {
    const dup = scanFdDupTail(command, cursor);
    if ('error' in dup) return dup;
    return { redirect: { operator: `${operator}${dup.tail}`, kind: 'fd-dup' }, next: dup.next };
  }
  const target = scanRedirectTarget(command, cursor);
  if ('error' in target) return target;
  return {
    redirect: { operator, kind: 'output', fd: fd ?? 1, target: target.word },
    next: target.next,
  };
}

/**
 * Skip heredoc bodies. A body starts on the line after the `<<` and runs until
 * a line that is exactly the delimiter (`<<-` strips leading tabs). Bodies are
 * data, never commands: skipping them keeps a `$(rm -rf /)` inside a quoted
 * heredoc from being read as a substitution.
 */
function consumeHeredocBodies(
  command: string,
  start: number,
  heredocs: PendingHeredoc[],
): number | undefined {
  let pos = start;
  for (const heredoc of heredocs) {
    let matched = false;
    while (pos < command.length) {
      const newline = command.indexOf('\n', pos);
      const lineEnd = newline === -1 ? command.length : newline;
      const raw = command.slice(pos, lineEnd);
      const line = heredoc.stripTabs ? raw.replace(/^\t+/, '') : raw;
      pos = lineEnd + 1;
      if (line === heredoc.delimiter) {
        matched = true;
        break;
      }
      if (newline === -1) break;
    }
    if (!matched) return undefined;
  }
  return pos;
}

/**
 * Lex a command line into segments (pipeline stages, `&&` / `;` branches) of
 * words and redirections. Everything it cannot finish is an error.
 */
export function tokenizeShellLite(command: string): ShellTokenizeResult {
  const n = command.length;
  const segments: ShellSegment[] = [];
  let tokens: ShellToken[] = [];
  let pendingHeredocs: PendingHeredoc[] = [];
  let i = 0;

  const endSegment = () => {
    if (tokens.length > 0) segments.push({ tokens });
    tokens = [];
  };

  /** Consume a redirection, remembering any heredoc body still to skip. */
  const takeRedirect = (redirectStart: number, fd?: number): ShellTokenizeResult | undefined => {
    const scanned = scanRedirect(command, redirectStart, fd);
    if ('error' in scanned) return { ok: false, error: scanned.error };
    tokens.push({ kind: 'redirect', redirect: scanned.redirect });
    if (scanned.heredoc) pendingHeredocs.push(scanned.heredoc);
    i = scanned.next;
    return undefined;
  };

  while (i < n) {
    const ch = command[i] as string;

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }

    // Line continuation: a backslash-newline is not a command boundary.
    if (ch === '\\' && command[i + 1] === '\n') {
      i += 2;
      continue;
    }

    if (ch === '\n') {
      endSegment();
      i += 1;
      if (pendingHeredocs.length > 0) {
        const after = consumeHeredocBodies(command, i, pendingHeredocs);
        if (after === undefined) return { ok: false, error: 'here-document without its terminator line' };
        i = after;
        pendingHeredocs = [];
      }
      continue;
    }

    // A `#` at the start of a word comments out the rest of the line.
    if (ch === '#') {
      while (i < n && command[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '|' || ch === ';' || ch === '&') {
      // `&>` / `&>>` are redirections; a bare `&` is a control operator.
      if (ch === '&' && command[i + 1] === '>') {
        const failed = takeRedirect(i);
        if (failed) return failed;
        continue;
      }
      i += 1;
      while (i < n && (command[i] === '|' || command[i] === ';' || command[i] === '&')) i += 1;
      endSegment();
      continue;
    }

    // `2>` / `2>>` / `2<`: leading digits are a file descriptor, not a word.
    const fdMatch = /^(\d+)(?=>>|>|<>|<)/.exec(command.slice(i, i + 24));
    const fd = fdMatch ? Number(fdMatch[1]) : undefined;
    const redirectStart = i + (fdMatch ? fdMatch[1].length : 0);
    const redirectChar = command[redirectStart];
    if (redirectChar === '<' || redirectChar === '>') {
      const failed = takeRedirect(redirectStart, fd);
      if (failed) return failed;
      continue;
    }

    const scanned = scanWordLite(command, i);
    if ('error' in scanned) return { ok: false, error: scanned.error };
    if (scanned.next === i) return { ok: false, error: `unexpected character "${ch}"` };
    tokens.push({ kind: 'word', word: scanned.word });
    i = scanned.next;
  }

  if (pendingHeredocs.length > 0) {
    return { ok: false, error: 'here-document without a body' };
  }
  endSegment();
  return { ok: true, segments };
}

/** What the redirections in a command line do, once target words are known. */
export interface RedirectionClassification {
  /**
   * Targets of `>` / `>>` / `&>` / `<>` that are REAL files: each one is a write
   * and has to be judged as a path. Discard targets and fd copies never appear.
   */
  writeTargets: string[];
  /** Targets of `< file`, judged with their segment's access (they only read). */
  readTargets: string[];
  /** File-descriptor duplications (`2>&1`, `>&2`): another fd, never a path. */
  duplicates: string[];
  /** Discard targets seen (`/dev/null` family): dropped from candidates. */
  discarded: string[];
  /** Set when an output target cannot be determined statically (a substitution). */
  unresolved?: string;
}

/**
 * Classify every redirection in a command line.
 *
 * The three cases that must not be confused:
 *
 *   - discard  — `/dev/null`, `/dev/stdout`, `/dev/stderr` (also via `&>`,
 *                `&>>`, `>>`): the diagnostics idiom. No candidate, no ask.
 *   - fd copy  — `2>&1`, `1>&2`, `>&2`, `N>&M`: retargets a descriptor to
 *                another descriptor. No path involved. No ask.
 *   - file     — anything else: a real write, judged as a path (and asked about
 *                even when it lands inside the workspace, because the shell
 *                would create/replace a file there).
 */
export function classifyRedirections(segments: ShellSegment[]): RedirectionClassification {
  const result: RedirectionClassification = {
    writeTargets: [],
    readTargets: [],
    duplicates: [],
    discarded: [],
  };

  for (const segment of segments) {
    for (const token of segment.tokens) {
      if (token.kind !== 'redirect') continue;
      const { redirect } = token;
      const target = redirect.target?.text;

      if (redirect.kind === 'fd-dup') {
        result.duplicates.push(redirect.operator);
        continue;
      }
      // Here-strings and heredoc delimiters are data, not paths.
      if (redirect.kind === 'here-string' || redirect.kind === 'here-doc') continue;
      if (target === undefined) continue;
      if (isDiscardRedirectTarget(target)) {
        result.discarded.push(target);
        continue;
      }
      if (redirect.kind === 'input') {
        if (target.includes(CMDSUBST_PLACEHOLDER)) {
          result.unresolved ??= `${redirect.operator} ${target}`;
          continue;
        }
        result.readTargets.push(target);
        continue;
      }
      // Output into a file. A substitution target (`> $(mktemp)`) is opaque.
      if (target.includes(CMDSUBST_PLACEHOLDER)) {
        result.unresolved ??= `${redirect.operator} ${target}`;
        continue;
      }
      result.writeTargets.push(target);
    }
  }

  return result;
}
