// Redirection classification: what every redirection in a command line does.

import { CMDSUBST_PLACEHOLDER, type ShellSegment } from './types';

/** Targets whose redirection discards the output instead of writing a file. */
const DISCARD_TARGETS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/** True for a redirection target that discards output (`/dev/null` family). */
export function isDiscardRedirectTarget(target: string | undefined): boolean {
  return target !== undefined && DISCARD_TARGETS.has(target);
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
