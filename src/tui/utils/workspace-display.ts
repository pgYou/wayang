/**
 * Workspace identity formatting for the TUI.
 *
 * Two shapes the display layer needs:
 *  - a single task workspace (`{ path, slug }`) — compact slug for the status
 *    bar, and "slug (path)" for the task list;
 *  - a session's workspace list — the same "first + N" expression the CLI
 *    uses, so the TUI never invents a second convention for multi-workspace
 *    sessions.
 *
 * Everything here is pure and tolerates missing/blank fields: a task or
 * session written before workspaces existed carries no identity, and the UI
 * must render nothing for it (never the string "undefined").
 */

/** Minimal workspace shape — a subset of `WorkspaceRef` / `TaskDetail.workspace`. */
export interface WorkspaceLike {
  path?: string | null;
  slug?: string | null;
}

/** Compact slug for a single workspace, or null when there is none to show. */
export function formatWorkspaceSlug(workspace?: WorkspaceLike | null): string | null {
  const slug = workspace?.slug?.trim();
  return slug ? slug : null;
}

/**
 * Session workspace summary, matching the CLI's "first + N" convention:
 *  - no workspace  → null (render nothing);
 *  - one workspace → its slug (equivalent to the single-workspace display);
 *  - many          → "<first slug> +<remaining count>".
 *
 * Blank slugs are skipped; the remaining count is the number of *other*
 * workspaces, so a session with three workspaces renders "+2".
 */
export function formatWorkspaceSummary(
  workspaces?: ReadonlyArray<WorkspaceLike> | null,
): string | null {
  if (!workspaces || workspaces.length === 0) return null;
  const slugs = workspaces
    .map((workspace) => workspace?.slug?.trim())
    .filter((slug): slug is string => !!slug);
  if (slugs.length === 0) return null;
  if (slugs.length === 1) return slugs[0];
  return `${slugs[0]} +${slugs.length - 1}`;
}

/**
 * Full identity for the task list/detail view: "slug (path)". Falls back to
 * whichever half is present, and returns null when neither is — so callers
 * append nothing for an unattributed task.
 */
export function formatWorkspaceDetail(workspace?: WorkspaceLike | null): string | null {
  const path = workspace?.path?.trim();
  const slug = workspace?.slug?.trim();
  if (path && slug) return `${slug} (${path})`;
  return path || slug || null;
}
