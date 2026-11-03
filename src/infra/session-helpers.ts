/**
 * Session utilities — stateless helpers for cross-session operations (pre-startup).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceRef } from './workspace-registry';
import { createSessionIndex } from './session-index';
import type { ListSessionsQuery } from './session-index';

export interface SessionMeta {
  sessionId: string;
  workspace: string;
  firstInput: string | null;
  createdAt: number;
  lastActiveAt: number;
  /**
   * User-assigned session name. When absent (legacy sessions, or never renamed),
   * consumers fall back to `firstInput`. Persisted so renames survive restarts.
   */
  title?: string;
  /**
   * Hidden from the default session list without deleting the transcript.
   * Absent means not archived (kept optional for backward compatibility with
   * meta.json files written before archiving existed).
   */
  archived?: boolean;
  /** Timestamp of the most recent archive/unarchive toggle, if ever archived. */
  archivedAt?: number;
  /**
   * Workspace identities this session has touched. Optional and additive:
   * sessions written before workspaces existed carry only the single-valued
   * `workspace` above, and readers synthesize this array from it (see
   * SessionManager.restore) — they must never require it to be present.
   *
   * `workspace` stays authoritative for "the directory this session was
   * started in"; `workspaces` is the multi-workspace view (always contains at
   * least the entry matching `workspace`).
   */
  workspaces?: WorkspaceRef[];
}

/** Effective display label for a session: explicit title wins, else first input. */
export function sessionDisplayTitle(meta: SessionMeta): string | null {
  if (meta.title && meta.title.trim().length > 0) return meta.title;
  return meta.firstInput;
}

/** Name of the directory that holds all sessions inside the Wayang home dir. */
const SESSIONS_DIRNAME = 'sessions';

/**
 * Wayang home dir (the parent of `sessions/`) for a session directory.
 *
 * Returns null when `sessionDir` does not follow the documented
 * `<wayangDir>/sessions/<sessionId>` layout — e.g. a hand-built temp dir in a
 * test. Callers use null to mean "no registry to consult", which keeps ad-hoc
 * directories from creating a stray registry file one level up.
 */
export function wayangDirForSessionDir(sessionDir: string): string | null {
  const sessionsDir = path.dirname(path.resolve(sessionDir));
  return path.basename(sessionsDir) === SESSIONS_DIRNAME ? path.dirname(sessionsDir) : null;
}

/** List all sessions under homeDir, sorted by creation date (newest first). */
export function listSessions(homeDir: string, query: ListSessionsQuery = {}): SessionMeta[] {
  return createSessionIndex(homeDir)
    .list(query)
    .map(e => e.meta);
}

/** Get a specific session by ID. Returns null if not found. */
export function getSession(homeDir: string, sessionId: string): { sessionId: string; sessionDir: string; meta: SessionMeta } | null {
  return createSessionIndex(homeDir).get(sessionId);
}

/**
 * Find the most recently created session for a given workspace.
 * Used by the sessionless default: `wayang` (no flags) resumes the latest
 * session belonging to the current workspace, if one exists.
 *
 * @param homeDir  Wayang home directory (contains sessions/)
 * @param workspaceDir  Workspace directory to match against
 * @returns The newest matching session, or null if none exists.
 */
export function getLatestSessionForWorkspace(
  homeDir: string,
  workspaceDir: string,
): { sessionId: string; sessionDir: string; meta: SessionMeta } | null {
  return createSessionIndex(homeDir).latestForWorkspace(workspaceDir);
}

/** Task snapshot fields read from a session's tasks.json. */
interface UnfinishedTaskSnapshot {
  id: string;
  title: string;
  description: string;
}

/**
 * Read a session's tasks.json and return the pending + running tasks.
 * Used at sessionless resume to surface unfinished work to the controller
 * as a `previous_session_tasks` signal.
 *
 * @param sessionDir  Directory of the session to inspect.
 * @returns Array of pending/running task snapshots, or null if unreadable.
 */
export function readSessionUnfinishedTasks(
  sessionDir: string,
): { id: string; title: string; description: string; status: 'pending' | 'running' }[] | null {
  const tasksPath = path.join(sessionDir, 'tasks.json');
  if (!fs.existsSync(tasksPath)) return null;
  try {
    // Shape assumed from the writer side (tasks.json); malformed files are
    // filtered out below, and missing fields surface as undefined just as
    // they did when this was read through `any`.
    const data = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')) as {
      tasks?: { pending?: UnfinishedTaskSnapshot[]; running?: UnfinishedTaskSnapshot[] };
    };
    const pending = data.tasks?.pending ?? [];
    const running = data.tasks?.running ?? [];
    const pick = (status: 'pending' | 'running') => (t: UnfinishedTaskSnapshot) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status,
    });
    // Tag by the bucket each task came from (defensive: ignore malformed entries)
    const tagged = [
      ...running.filter(Boolean).map(pick('running')),
      ...pending.filter(Boolean).map(pick('pending')),
    ];
    return tagged.filter(t => typeof t.id === 'string' && typeof t.title === 'string');
  } catch {
    return null;
  }
}
