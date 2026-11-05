// File-tool access: which tools are gated, which only read, and the evaluateFileAccess decision.

import type { AccessMode } from '@/infra/permission/policy';
import { decidePath, toToolDecision, withAskPaths } from './access-verdict';
import { expandHome } from './home-expansion';
import type { ToolAccessDecision, WorkerAccessScope } from './types';

/** File tools gated by the permission middleware for path access. */
export const FILE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'search_files', 'search_content'] as const;

/** File tools that only read. Every other file tool counts as a write. */
const READ_ONLY_FILE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'search_files', 'search_content']);

/**
 * Decide a file tool call. `read_file` / `search_files` / `search_content` are
 * reads; `write_file` / `edit_file` are writes. A call without a usable `path`
 * has nothing to judge and is allowed (the tool then uses its own cwd).
 *
 * NARROWER THAN THE POLICY ON PURPOSE: `read-within-home` is downgraded to
 * `ask`. The controller may read anywhere under home (its own read scope, 4b),
 * but a WORKER's silence-worthy scope is its workspace, its task allowedDirs
 * and the explicitly configured roots. The sensitive list only covers
 * credentials and tool config — `.env` files, SSH keys inside a project, other
 * projects' sources are all "inside home" and must not be readable without an
 * approval.
 */
export function evaluateFileAccess(
  scope: WorkerAccessScope,
  toolName: string,
  args: Record<string, unknown>,
): ToolAccessDecision {
  const rawPath = args.path;
  if (typeof rawPath !== 'string' || !rawPath) return { decision: 'allow', matchedRule: 'no-path' };

  const access: AccessMode = READ_ONLY_FILE_TOOLS.has(toolName) ? 'read' : 'write';
  const expanded = expandHome(rawPath);
  if (expanded.unresolvable) {
    // `~user`: another user's home. We do not guess it, so we cannot prove it
    // is inside any allowed scope — ask rather than silently allow.
    return {
      decision: 'ask',
      matchedRule: 'home-other-user',
      reason: "`~user` names another user's home directory, which cannot be resolved safely",
    };
  }

  const verdict = decidePath(scope, expanded.path, access);
  // Downgrade when — and only when — the allow rests SOLELY on the policy's
  // "read inside home" rule. Structured check (withinReadScope), not the
  // matchedRule string literal, so renaming the rule cannot widen access.
  if (verdict.decision === 'allow' && verdict.withinReadScope) {
    return {
      decision: 'ask',
      matchedRule: 'read-within-home',
      resolvedPath: verdict.resolvedPath,
      access,
      ...(verdict.resolvedPath !== undefined && { askPaths: [verdict.resolvedPath] }),
    };
  }
  return withAskPaths(toToolDecision(verdict, access));
}
