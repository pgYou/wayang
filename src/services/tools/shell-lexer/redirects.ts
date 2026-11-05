// Redirection scanning: operators, targets, fd duplication and heredoc bodies.

import { isWordTerminator, scanWordLite } from './scanners';
import type { PendingHeredoc, ShellRedirect, ShellWord } from './types';

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
export function scanRedirect(
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
export function consumeHeredocBodies(
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
