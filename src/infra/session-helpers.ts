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
