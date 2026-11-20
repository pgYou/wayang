// Path candidate extraction from a lexed command line, plus the strictest-access reduction for whole-line reporting.

import type { AccessMode } from '@/infra/permission/policy';
import { CMDSUBST_PLACEHOLDER, isDiscardRedirectTarget, type ShellSegment } from '@/services/tools/shell-lexer';
import { segmentAccess } from './bash-classification';

/** A path candidate plus how the policy should judge it. */
export interface BashCandidate {
  path: string;
  /** The access its own segment justifies — see `segmentAccess`. */
  access: AccessMode;
  /** Present for redirection targets — surfaced on `ask` so the reason is clear. */
  reason?: string;
}

/**
 * Split one unquoted shell word into path candidates. A word only yields a
 * candidate when a piece of it STARTS with `/` or `~`: `src/cli.ts` must not be
 * mistaken for the absolute path `/cli.ts`, and a URL (`https://…`) is not a
 * filesystem path. `--prefix=/usr/local` and `of=$HOME/x` do carry one, so the
 * word is split on `=` as before.
 */
function pathPieces(text: string, access: BashCandidate['access']): BashCandidate[] {
  const candidates: BashCandidate[] = [];
  for (const piece of text.split('=')) {
    if (!piece.startsWith('/') && !piece.startsWith('~')) continue;
    // The discard family is never a file to judge: `tee /dev/null` is not a
    // write outside the workspace.
    if (isDiscardRedirectTarget(piece)) continue;
    candidates.push({ path: piece, access });
  }
  return candidates;
}

/**
 * Extract path candidates from a lexed command line: absolute / `~` words plus
 * the targets of redirections into real files.
 *
 * Relative spellings are deliberately NOT extracted (historic behaviour: a
 * relative word is not a path candidate, so it never triggers a prompt). Bash
 * resolves those against the task workspace, which is also the tool's cwd.
 *
 * Candidates are collected segment by segment so each one carries the strongest
 * access its OWN segment can justify: a `cat` in one segment cannot downgrade
 * the `tee` next to it. A redirection target is always a write, whatever the
 * rest of the segment does.
 */
export function extractPathCandidates(segments: ShellSegment[]): BashCandidate[] {
  const candidates: BashCandidate[] = [];
  for (const segment of segments) {
    const segmentLevel = segmentAccess(segment);
    for (const token of segment.tokens) {
      if (token.kind === 'word') {
        candidates.push(...pathPieces(token.word.text, segmentLevel));
        continue;
      }
      const { redirect } = token;
      if (redirect.kind === 'fd-dup' || redirect.kind === 'here-doc' || redirect.kind === 'here-string') continue;
      const target = redirect.target?.text;
      if (target === undefined || isDiscardRedirectTarget(target)) continue;
      // A substitution target is judged through evaluateSubstitutions instead.
      if (target.includes(CMDSUBST_PLACEHOLDER)) continue;
      const access: AccessMode = redirect.kind === 'output' ? 'write' : segmentLevel;
      for (const candidate of pathPieces(target, access)) {
        candidates.push(
          redirect.kind === 'output'
            ? { ...candidate, reason: `output redirection to "${target}"` }
            : candidate,
        );
      }
    }
  }
  return candidates;
}

/**
 * The access a whole command line is audited under: the STRICTEST access any of
 * its candidates justifies, ordered `write` > `read` > `unknown`. A command line
 * is one unit of execution, so a single write-capable candidate makes the line a
 * write even when every other candidate is a read.
 *
 * This is a REPORTING value only — each candidate was still judged on its own
 * access above, so a `cat` next to a `tee` is not treated as a write. The audit
 * trail records it as its own `access` field, apart from the tool-category
 * `operation` (bash → `exec`).
 */
export function commandAccess(candidates: readonly BashCandidate[]): AccessMode {
  let access: AccessMode = 'unknown';
  for (const candidate of candidates) {
    if (candidate.access === 'write') return 'write';
    if (candidate.access === 'read') access = 'read';
  }
  return access;
}
