/**
 * Workspace rules summary — how the controller learns a project's conventions
 * at dispatch time.
 *
 * The controller's system prompt is built once and shared by every task, so a
 * project's rules file must never be baked into it: with several workspaces
 * that would leak one project's conventions into another project's work. The
 * rules therefore travel WITH the task: add_task appends a short summary of the
 * TARGET workspace's rules file to its own result. Nothing is cached — each
 * call reads the workspace it is about to use, so two tasks in two workspaces
 * see two different rule sets.
 *
 * Lookup is deliberately shallow (workspace directory only, AGENTS.md before
 * CLAUDE.md). Walking up to a parent directory would hand a task the rules of
 * a repository it does not run in — the very cross-workspace mixing this module
 * exists to avoid.
 *
 * Reading goes through the shared access policy (read, anchored at the user's
 * home, cwd = the target workspace). A denied or unapproved read is reported
 * as "unavailable" rather than dropped: the controller must be able to tell
 * "this project has no rules file" from "the rules file exists but I may not
 * read it".
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionConfig } from '@/types/config';
import { decideAccess } from '@/infra/permission/policy';
import { mergeSensitiveDirs, resolveSensitiveMode } from '@/infra/permission/permission-config';

/** Candidate file names, in priority order — AGENTS.md wins over CLAUDE.md. */
const RULE_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Hard cap on summarized lines. */
export const WORKSPACE_RULES_MAX_LINES = 40;

/** Hard cap on summarized characters (applied on top of the line cap). */
export const WORKSPACE_RULES_MAX_CHARS = 2000;

export interface WorkspaceRulesInput {
  /** The workspace the task will execute in (canonical path). */
  workspacePath?: string;
  /** The user's home directory — the anchor of the access policy. */
  userHome?: string;
  /** User-config permission section; its `sensitiveDirs` extend the sensitive list. */
  permissionConfig?: PermissionConfig;
}

/**
 * Build the rules block appended to an add_task result.
 *
 * Returns an empty string when there is nothing to say — no workspace, no rules
 * file, or an empty rules file — so callers append nothing instead of emitting
 * "no rules" noise.
 */
export function buildWorkspaceRulesSummary(input: WorkspaceRulesInput): string {
  const workspacePath = input.workspacePath;
  if (!workspacePath) return '';

  for (const name of RULE_FILE_NAMES) {
    const rulesPath = join(workspacePath, name);
    if (!isRegularFile(rulesPath)) continue;

    const header = `Workspace rules (from ${rulesPath}):`;

    // Existence is a fact; readability is a policy question. Both are reported
    // — an unapproved file is never silently treated as a missing one.
    const refusal = describeRefusal(rulesPath, workspacePath, input);
    if (refusal !== null) return `${header}\n${refusal}`;

    const content = readTextFile(rulesPath);
    if (content === null) {
      return `${header}\nunavailable — the file exists but could not be read.`;
    }
    // Whitespace-only rules carry no instruction: treat as absent and let the
    // next candidate (CLAUDE.md) have a turn.
    if (content.trim() === '') continue;

    return `${header}\n${summarizeRules(content)}`;
  }

  return '';
}

/**
 * Ask the shared policy whether this read is allowed. Returns the
 * "unavailable" reason to report, or null when the file may be read.
 *
 * The reported path is always the workspace-relative candidate, never the
 * policy's canonical target: a denial must not disclose where a symlink points.
 */
function describeRefusal(
  rulesPath: string,
  workspacePath: string,
  input: WorkspaceRulesInput,
): string | null {
  const userHome = input.userHome;
  if (!userHome) {
    // Without a home anchor the decision cannot be made. That is NOT the same
    // as "no rules file", so say so instead of reading the file unguarded.
    return 'unavailable — the permission policy cannot be evaluated here (no home directory in this context), so the file was not read.';
  }

  const { decision, matchedEntry } = decideAccess({
    access: 'read',
    path: rulesPath,
    cwd: workspacePath,
    userHome: userHome,
    taskWorkspace: workspacePath,
    extraSensitiveDirs: mergeSensitiveDirs(input.permissionConfig),
    sensitiveMode: resolveSensitiveMode(input.permissionConfig),
  });

  // A sensitive hit (read → `ask`, or `deny` under sensitiveMode: 'deny') is
  // reported as such: this reader has no approval channel, so the entry is
  // never read, and the note says why without naming the entry.
  if (matchedEntry !== undefined || decision === 'deny') {
    return 'unavailable — the file resolves to a sensitive location (a protected path such as credentials or tool config), so its content was not read.';
  }
  if (decision === 'ask') {
    return 'unavailable — reading it was not approved by the permission policy (the path is outside the readable scope), so its content was not read.';
  }
  return null;
}

/**
 * Truncate rules content to a short, readable summary.
 *
 * Both caps apply: at most WORKSPACE_RULES_MAX_LINES lines and at most
 * WORKSPACE_RULES_MAX_CHARS characters — whichever is hit first wins. Line and
 * character limits guard different failure modes: a long-but-tidy file still
 * floods the context by line count, while a minified one-line file floods it by
 * character count.
 *
 * Truncation is always marked, so the controller knows the summary is partial
 * and can read the file itself for the rest.
 */
function summarizeRules(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').trimEnd().split('\n');
  let body = lines.slice(0, WORKSPACE_RULES_MAX_LINES).join('\n');

  const cutByChars = body.length > WORKSPACE_RULES_MAX_CHARS;
  if (cutByChars) body = body.slice(0, WORKSPACE_RULES_MAX_CHARS).trimEnd();

  // A mid-line cut still shows part of that line, so it counts as shown.
  const shownLines = body === '' ? 0 : body.split('\n').length;
  const remainingLines = lines.length - shownLines;

  if (remainingLines > 0) {
    const unit = remainingLines === 1 ? 'line' : 'lines';
    return `${body}\n... truncated (${remainingLines} more ${unit})`;
  }
  if (cutByChars) {
    return `${body}\n... truncated (content exceeded ${WORKSPACE_RULES_MAX_CHARS} characters)`;
  }
  return body;
}

/** Is `p` an existing regular file? (Directories named AGENTS.md are not.) */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read a text file, or null when it is missing/unreadable. */
function readTextFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
