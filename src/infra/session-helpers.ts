/**
 * Session utilities — stateless helpers for cross-session operations (pre-startup).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
}

/** Effective display label for a session: explicit title wins, else first input. */
export function sessionDisplayTitle(meta: SessionMeta): string | null {
  if (meta.title && meta.title.trim().length > 0) return meta.title;
  return meta.firstInput;
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
    const data = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')) as {
      tasks?: { pending?: any[]; running?: any[] };
    };
    const pending = data.tasks?.pending ?? [];
    const running = data.tasks?.running ?? [];
    const pick = (status: 'pending' | 'running') => (t: any) => ({
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
