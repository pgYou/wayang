// Low-level word scanning: terminators, quote matching and command substitutions.

import { CMDSUBST_PLACEHOLDER, type ShellSubstitution, type ShellWord } from './types';

/** Characters that end a bare word. */
export function isWordTerminator(ch: string): boolean {
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
export function scanWordLite(
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
