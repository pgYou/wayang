// The segment lexer itself: a command line into words, redirections and segments.

import { consumeHeredocBodies, scanRedirect } from './redirects';
import { scanWordLite } from './scanners';
import type { PendingHeredoc, ShellSegment, ShellToken, ShellTokenizeResult } from './types';

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
