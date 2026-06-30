/**
 * Session utilities — stateless helpers for cross-session operations (pre-startup).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SessionMeta {
  sessionId: string;
  workspace: string;
  firstInput: string | null;
  createdAt: number;
  lastActiveAt: number;
}

/** List all sessions under homeDir, sorted by creation date (newest first). */
export function listSessions(homeDir: string): SessionMeta[] {
  const sessionsDir = path.join(homeDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  return fs.readdirSync(sessionsDir)
    .filter(name => fs.existsSync(path.join(sessionsDir, name, 'meta.json')))
    .map(name => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir, name, 'meta.json'), 'utf-8')) as SessionMeta;
      } catch {
        return null;
      }
    })
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Get a specific session by ID. Returns null if not found. */
export function getSession(homeDir: string, sessionId: string): { sessionId: string; sessionDir: string; meta: SessionMeta } | null {
  const sessionDir = path.join(homeDir, 'sessions', sessionId);
  const metaPath = path.join(sessionDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta;
    return { sessionId, sessionDir, meta };
  } catch {
    return null;
  }
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
  const sessions = listSessions(homeDir).filter(m => m.workspace === workspaceDir);
  if (sessions.length === 0) return null;
  // listSessions returns newest-first already
  const meta = sessions[0];
  const sessionDir = path.join(homeDir, 'sessions', meta.sessionId);
  return { sessionId: meta.sessionId, sessionDir, meta };
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
