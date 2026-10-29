/**
 * Permission rules deciding when a worker tool call needs controller approval.
 *
 * Two tiers:
 *  1. Dangerous bash commands (destructive / privilege-escalating patterns)
 *  2. File or bash access targeting paths outside the workspace
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isInsideWorkspace } from '@/services/tools/common';

/** File tools gated by the permission middleware for out-of-workspace paths. */
export const FILE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'search_files', 'search_content'] as const;

/**
 * Bash commands matching these patterns always require controller approval.
 * Matches at command start or after shell operators (|, ;, &&) to reduce
 * false positives from quoted strings.
 */
const DANGEROUS_BASH_PATTERN = /(?:^|\||;|&&)\s*(?:rm\s|sudo\b|chmod\b|chown\b|mkfs\b|dd\s|shutdown\b|reboot\b|kill\s+-9)/;

/** URLs (scheme://...) — their path components are not local filesystem paths. */
const URL_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g;

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Extract path candidates from a shell command: whole shell words that START
 * with `/` or `~` (after stripping quotes and operator fragments). Only whole
 * words count — `src/cli.ts` must not be mistaken for the absolute path
 * `/cli.ts`, and URLs are stripped beforehand.
 */
function extractPathCandidates(command: string): string[] {
  const withoutUrls = command.replace(URL_RE, ' ');
  const candidates: string[] = [];
  for (const raw of withoutUrls.split(/[\s=;|&]+/)) {
    const word = raw.replace(/^['"]+/, '').replace(/['",;|&()<>'`]+$/, '');
    if (word.startsWith('/') || word.startsWith('~')) candidates.push(word);
  }
  return candidates;
}

/** Check whether a file tool call targets a path outside the workspace. */
export function needsFilePermission(workspace: string, args: Record<string, unknown>): boolean {
  const rawPath = args.path;
  if (typeof rawPath !== 'string' || !rawPath) return false;
  return !isInsideWorkspace(resolve(workspace, expandHome(rawPath)), workspace);
}

/** Check whether a bash command needs controller approval. */
export function needsBashPermission(workspace: string, command: string): boolean {
  // Tier 1: dangerous commands always need permission
  if (DANGEROUS_BASH_PATTERN.test(command)) return true;

  // Tier 2: commands referencing paths outside the workspace
  return extractPathCandidates(command).some(
    (p) => !isInsideWorkspace(expandHome(p), workspace),
  );
}
