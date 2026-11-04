/**
 * Workspace identity formatting for the TUI.
 *
 * Three shapes the display layer needs:
 *  - a single task workspace (`{ path, slug }`) — the compact slug the task
 *    list flags a non-default task with;
 *  - a session's workspace list — the same "first + N" expression the CLI
 *    uses, so the TUI never invents a second convention for multi-workspace
 *    sessions;
 *  - the `/projects` list — every workspace the session knows, slug next to
 *    its absolute path.
 *
 * Everything here is pure and tolerates missing/blank fields: a task or
 * session written before workspaces existed carries no identity, and the UI
 * must render nothing for it (never the string "undefined").
 */

import { normalizeWorkspacePath, workspaceSlugFromPath } from '@/infra/workspace-registry';
import { stringWidth, truncateMiddleToWidth } from '@/tui/utils/text-width';

/** Minimal workspace shape — a subset of `WorkspaceRef` / `TaskDetail.workspace`. */
export interface WorkspaceLike {
  path?: string | null;
  slug?: string | null;
}

/**
 * Workspace context available to the chat area and the slash commands: the
 * session default (compare against it to tell "explicit" from "default") and
 * the identities the session knows about (to resolve a registry slug).
 * Display-only — mirrored from `RemoteSupervisor.ctx`, never persisted.
 */
export interface WorkspaceDisplayContext {
  /** The session's default workspace (`RemoteSupervisor.ctx.workspaceDir`). */
  defaultWorkspacePath?: string;
  /** Known identities, e.g. `RemoteSupervisor.ctx.workspaces`. */
  workspaces: ReadonlyArray<WorkspaceLike>;
}

/** Empty context — nothing known, so no default and no slug hints. */
export const EMPTY_WORKSPACE_CONTEXT: WorkspaceDisplayContext = { workspaces: [] };

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
 * Do two workspace spellings name the same directory?
 *
 * Both sides go through `normalizeWorkspacePath` (realpath when it exists,
 * resolve otherwise), so `~/repo`, `~/repo/` and a symlink to it compare equal.
 * Missing/blank input is never "the same" — an unstamped task cannot claim the
 * default workspace.
 */
export function isSameWorkspacePath(
  a?: string | null,
  b?: string | null,
): boolean {
  const left = a?.trim();
  const right = b?.trim();
  if (!left || !right) return false;
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

/**
 * Display slug for one workspace: the registry slug when the record carries
 * one, else the registry's own rule-based slug of the path's last segment.
 *
 * Reusing `workspaceSlugFromPath` (rather than the raw directory name) keeps a
 * single naming rule across `/tasks`, `add_task` rows and `/projects` — an
 * unregistered path degrades exactly the way the registry itself degrades, so
 * the UI never invents a second label for one directory.
 */
export function resolveWorkspaceSlug(workspace?: WorkspaceLike | null): string | null {
  const slug = workspace?.slug?.trim();
  if (slug) return slug;
  const path = workspace?.path?.trim();
  return path ? workspaceSlugFromPath(path) : null;
}

/**
 * Row marker for a task's workspace in the `/tasks` list: " — <slug>" for a
 * task running outside the session's default workspace, '' otherwise.
 *
 * The default workspace is what the session already implies, so marking it
 * would add a column of noise to every row; only a task that went somewhere
 * else needs the flag. Without a known default nothing can be compared, so the
 * slug is shown rather than silently dropped (never hide attribution).
 */
export function formatTaskWorkspaceMark(
  workspace?: WorkspaceLike | null,
  defaultWorkspacePath?: string | null,
): string {
  const slug = resolveWorkspaceSlug(workspace);
  if (!slug) return '';
  if (defaultWorkspacePath && isSameWorkspacePath(workspace?.path, defaultWorkspacePath)) {
    return '';
  }
  return ` — ${slug}`;
}

/**
 * Slug for the workspace an `add_task` call *declared* (`args.workspace`, a
 * bare path — the tool stamps the slug later, server-side).
 *
 * Returns null when the call declared nothing (it runs in the default
 * workspace) and when the declared path canonicalizes to that same default:
 * in both cases the row looks exactly as before. Otherwise the slug comes from
 * a known identity (so it matches the registry slug `/tasks` shows), falling
 * back to the registry's rule-based slug of the path's last segment.
 */
export function resolveDeclaredWorkspaceSlug(
  declaredPath?: string | null,
  options: { defaultWorkspacePath?: string | null; workspaces?: ReadonlyArray<WorkspaceLike> | null } = {},
): string | null {
  const raw = declaredPath?.trim();
  if (!raw) return null;
  if (options.defaultWorkspacePath && isSameWorkspacePath(raw, options.defaultWorkspacePath)) {
    return null;
  }
  const known = (options.workspaces ?? []).find(
    workspace => workspace?.path && isSameWorkspacePath(workspace.path, raw),
  );
  if (known) return resolveWorkspaceSlug(known);
  return resolveWorkspaceSlug({ path: normalizeWorkspacePath(raw) });
}

// ---------------------------------------------------------------------------
// /projects
// ---------------------------------------------------------------------------

/** Max display columns for one `/projects` line. */
export const PROJECT_LIST_MAX_WIDTH = 80;

/** Marker appended to the default workspace's row (explained by the legend). */
export const PROJECT_DEFAULT_MARKER = '*';

/** One-line legend emitted under the list so the marker is never a mystery. */
export const PROJECT_DEFAULT_LEGEND = '* = default workspace';

/** One `/projects` row, after dedup and default resolution. */
export interface ProjectEntry {
  slug: string;
  /** Absolute path as known to the session (canonical when it was resolved). */
  path: string;
  isDefault: boolean;
}

/**
 * Build the `/projects` rows from what the session knows about workspaces.
 *
 * Sources are combined, not replaced: the session's workspace list
 * (`ctx.workspaces`) plus the workspaces stamped on its tasks — a session that
 * dispatched into a new workspace mid-run only learns about it from the task.
 * Entries are deduped by canonical path (first spelling wins), the default
 * workspace is hoisted to the top, everything else keeps discovery order so
 * repeated calls print the same list.
 */
export function collectProjectEntries(input: {
  workspaces?: ReadonlyArray<WorkspaceLike> | null;
  taskWorkspaces?: ReadonlyArray<WorkspaceLike> | null;
  defaultWorkspacePath?: string | null;
}): ProjectEntry[] {
  const defaultPath = input.defaultWorkspacePath?.trim();
  const seen = new Set<string>();
  const entries: ProjectEntry[] = [];

  // The default workspace always belongs in the list, even before any
  // workspace identity was recorded for it.
  const candidates: WorkspaceLike[] = [
    ...(input.workspaces ?? []),
    ...(input.taskWorkspaces ?? []),
    ...(defaultPath ? [{ path: defaultPath }] : []),
  ];

  for (const candidate of candidates) {
    const rawPath = candidate?.path?.trim();
    if (!rawPath) continue;
    const canonical = normalizeWorkspacePath(rawPath);
    if (seen.has(canonical)) continue;
    const slug = resolveWorkspaceSlug({ ...candidate, path: rawPath });
    if (!slug) continue;
    seen.add(canonical);
    entries.push({
      slug,
      path: rawPath,
      isDefault: defaultPath !== undefined && isSameWorkspacePath(rawPath, defaultPath),
    });
  }

  // Stable, useful order: the default workspace first, the rest untouched.
  const defaultEntry = entries.find(entry => entry.isDefault);
  return defaultEntry
    ? [defaultEntry, ...entries.filter(entry => entry !== defaultEntry)]
    : entries;
}

/** Render the `/projects` output: "<slug>  <path>" rows, or "No projects". */
export function formatProjectList(
  input: {
    workspaces?: ReadonlyArray<WorkspaceLike> | null;
    taskWorkspaces?: ReadonlyArray<WorkspaceLike> | null;
    defaultWorkspacePath?: string | null;
  },
  options: { maxWidth?: number } = {},
): string {
  const maxWidth = options.maxWidth ?? PROJECT_LIST_MAX_WIDTH;
  const entries = collectProjectEntries(input);
  if (entries.length === 0) return 'No projects';

  const lines = entries.map((entry) => {
    // The marker trails the path so the row still starts with "<slug>  <path>"
    // and survives middle-ellipsis truncation of the path.
    const suffix = entry.isDefault ? `  ${PROJECT_DEFAULT_MARKER}` : '';
    const prefix = `${entry.slug}  `;
    const pathBudget = Math.max(1, maxWidth - stringWidth(prefix) - stringWidth(suffix));
    return prefix + truncateMiddleToWidth(entry.path, pathBudget) + suffix;
  });
  if (entries.some(entry => entry.isDefault)) lines.push(PROJECT_DEFAULT_LEGEND);
  return lines.join('\n');
}
