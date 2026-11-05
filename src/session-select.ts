/**
 * Wayang — interactive session selection
 *
 * Runs before Ink render for --resume without session ID.
 * Uses prompts library for terminal interaction.
 */

import prompts from 'prompts';
import { listSessions, getSession, sessionDisplayTitle } from './infra/session-helpers';
import type { SessionMeta } from './infra/session-helpers';
import { sessionWorkspacePaths } from './infra/session-index';
import { normalizeWorkspacePath, workspaceSlugFromPath } from './infra/workspace-registry';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Workspace identities as the picker displays them.
 *
 * `workspaces` is the multi-workspace view and wins when present; legacy meta
 * (single-valued `workspace` only) is synthesized here so both shapes render
 * the same way.
 */
function sessionWorkspaceRefs(meta: SessionMeta): { path: string; slug?: string }[] {
  if (meta.workspaces && meta.workspaces.length > 0) {
    return meta.workspaces.filter(w => typeof w.path === 'string' && w.path.length > 0);
  }
  return meta.workspace ? [{ path: meta.workspace }] : [];
}

/** Registry slug when recorded, else the rule-based slug of the path. */
function workspaceHandle(ref: { path: string; slug?: string }): string {
  return ref.slug && ref.slug.length > 0 ? ref.slug : workspaceSlugFromPath(ref.path);
}

/**
 * Compact workspace fragment for one session row.
 *
 * Single workspace → its slug (e.g. `repo-a`); several → the first slug plus
 * how many others follow (e.g. `repo-a (+2)`), mirroring how the session meta
 * accumulates workspaces over time.
 */
export function formatSessionWorkspaces(meta: SessionMeta): string {
  const refs = sessionWorkspaceRefs(meta);
  if (refs.length === 0) return '(no workspace)';
  const first = workspaceHandle(refs[0]);
  return refs.length > 1 ? `${first} (+${refs.length - 1})` : first;
}

/**
 * Relative description of the last activity, e.g. `just now`, `5m ago`,
 * `3h ago`, `2d ago`. `now` is injectable so tests stay time-independent.
 */
export function formatRelativeLastActive(lastActiveAt: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - lastActiveAt);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * One row of the picker: id, creation time, label, workspace(s), last active.
 *
 * Workspace and last-active fragments are always shown — a session may span
 * several workspaces, so which one(s) it covers is no longer inferable from
 * the directory the picker was launched in.
 */
export function formatSessionChoice(meta: SessionMeta, now: number = Date.now()): string {
  const date = new Date(meta.createdAt).toLocaleString();
  const display = sessionDisplayTitle(meta);
  const label = display ? `"${display}"` : '(no input yet)';
  const workspaces = formatSessionWorkspaces(meta);
  const lastActive = formatRelativeLastActive(meta.lastActiveAt, now);
  return `${meta.sessionId}  ${date}  ${label}  [${workspaces}]  active ${lastActive}`;
}

/**
 * Whether `workspaceDir` is outside every workspace the session has touched.
 *
 * Both sides are canonicalized through `normalizeWorkspacePath`, so symlinked,
 * relative and trailing-slash spellings of the same directory compare equal —
 * the raw `meta.workspace !== workspaceDir` check this replaces warned falsely
 * whenever the user entered through a symlink. The target counts as a match
 * when it hits ANY of the session's workspaces, not only the single-valued
 * `meta.workspace` the session was started in.
 */
export function isWorkspaceMismatch(meta: SessionMeta, workspaceDir: string): boolean {
  const target = normalizeWorkspacePath(workspaceDir);
  return !sessionWorkspacePaths(meta).some(p => normalizeWorkspacePath(p) === target);
}

/**
 * Show an interactive session picker.
 *
 * @param dataDir  Wayang home directory (contains sessions/)
 * @param workspaceDir  Current workspace directory (for filtering)
 * @param showAll  If true, show sessions from all workspaces
 * @returns Selected session info, or exits process on cancel/empty
 */
export async function selectSessionInteractive(
  dataDir: string,
  workspaceDir: string,
  showAll: boolean,
): Promise<{ sessionId: string; sessionDir: string; meta: SessionMeta }> {
  const sessions = listSessions(dataDir, showAll ? {} : { workspace: workspaceDir });

  if (sessions.length === 0) {
    const scope = showAll ? 'any workspace' : `workspace ${workspaceDir}`;
    console.error(`Error: No sessions found for ${scope}. Start a new session first.`);
    process.exit(1);
  }

  const { selected } = await prompts({
    type: 'select',
    name: 'selected',
    message: 'Select a session to resume',
    choices: sessions.map(m => ({
      title: formatSessionChoice(m),
      value: m.sessionId,
    })),
  });

  if (!selected) {
    // User cancelled (Ctrl+C)
    process.exit(0);
  }

  const result = getSession(dataDir, selected);
  if (!result) {
    console.error(`Error: Session "${selected}" not found.`);
    process.exit(1);
  }

  // Workspace mismatch warning: only when the current directory matches none
  // of the session's workspaces (after canonicalization).
  if (isWorkspaceMismatch(result.meta, workspaceDir)) {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: `Session workspace is ${formatSessionWorkspaces(result.meta)}, current dir is ${workspaceDir}. Switch?`,
      initial: true,
    });
    if (!confirm) {
      process.exit(0);
    }
  }

  return result;
}
