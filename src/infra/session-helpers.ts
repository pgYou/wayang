/**
 * Session utilities — stateless helpers for cross-session operations (pre-startup).
 */

import * as fs from 'node:fs';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceRef } from './workspace-registry';
import { createSessionIndex } from './session-index';
import type { ListSessionsQuery, SessionEntry } from './session-index';

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

/** List all sessions under dataDir, sorted by creation date (newest first). */
export function listSessions(dataDir: string, query: ListSessionsQuery = {}): SessionMeta[] {
  return createSessionIndex(dataDir)
    .list(query)
    .map(e => e.meta);
}

/** Get a specific session by ID. Returns null if not found. */
export function getSession(dataDir: string, sessionId: string): { sessionId: string; sessionDir: string; meta: SessionMeta } | null {
  return createSessionIndex(dataDir).get(sessionId);
}

// ---------------------------------------------------------------------------
// Last-activity resolution (issue #40)
// ---------------------------------------------------------------------------

/** File holding a session's controller conversation (mirrors ControllerAgentState). */
const CONVERSATION_FILENAME = 'conversation.jsonl';

/** First tail window read when resolving activity; doubled up to the cap. */
const ACTIVITY_WINDOW_BYTES = 64 * 1024;

/** Hard cap on bytes pulled from the tail of `conversation.jsonl`. */
const MAX_ACTIVITY_WINDOW_BYTES = 2 * 1024 * 1024;

/** Which signal produced an activity timestamp. */
export type SessionActivitySource = 'conversation' | 'meta.lastActiveAt' | 'meta.createdAt';

export interface SessionActivity {
  /** Epoch milliseconds of the session's most recent activity. */
  at: number;
  /** Signal `at` came from. */
  source: SessionActivitySource;
}

/**
 * Parse a conversation entry's write time to epoch ms.
 *
 * `timestamp` (ISO string) is the canonical field every entry is written with;
 * `endedAt` / `startedAt` are consulted only when it is missing or unparsable,
 * mirroring how worker transcripts are read elsewhere.
 */
function entryTimestamp(entry: unknown): number | null {
  if (entry === null || typeof entry !== 'object') return null;
  const e = entry as { timestamp?: unknown; endedAt?: unknown; startedAt?: unknown };
  for (const raw of [e.timestamp, e.endedAt, e.startedAt]) {
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

/**
 * Newest entry timestamp in the tail of a JSONL file, or null.
 *
 * Reads from the end in doubling windows (64 KB up to 2 MB): a single
 * assistant entry (big tool output) can exceed one window, and a long-lived
 * session's transcript reaches tens of MB, so the whole file is never loaded.
 * The first line of a partial window is the tail of an older entry and is
 * dropped; unparsable lines (torn append, corrupt record) are skipped the same
 * way `JSONLFileHelper.read()` skips them. The maximum timestamp seen wins —
 * entries are appended in write order, so that is the session's last activity.
 */
function readTailEntryTimestamp(filePath: string): number | null {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return null;
  }
  if (size === 0) return null;

  let windowBytes = Math.min(size, ACTIVITY_WINDOW_BYTES);
  for (;;) {
    const start = size - windowBytes;
    const chunk = Buffer.alloc(windowBytes);
    let fd: number | null = null;
    try {
      fd = openSync(filePath, 'r');
      readSync(fd, chunk, 0, windowBytes, start);
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }

    let body = chunk.toString('utf-8');
    if (start > 0) {
      // Partial window: everything up to the first newline is the tail of an
      // entry that started before the window — never parse it.
      const nl = body.indexOf('\n');
      if (nl === -1) {
        // A single entry is larger than the whole window. Grow, or give up.
        if (windowBytes >= MAX_ACTIVITY_WINDOW_BYTES) return null;
        windowBytes = Math.min(size, windowBytes * 2);
        continue;
      }
      body = body.slice(nl + 1);
    }

    let latest: number | null = null;
    for (const line of body.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = entryTimestamp(parsed);
      if (ts !== null && (latest === null || ts > latest)) latest = ts;
    }
    if (latest !== null) return latest;

    // Nothing parseable in this window — older entries may still carry a
    // timestamp, so keep growing until the file head or the byte cap.
    if (start === 0 || windowBytes >= MAX_ACTIVITY_WINDOW_BYTES) return null;
    windowBytes = Math.min(size, windowBytes * 2);
  }
}

/** Read `meta.json` for activity fields; null when missing or malformed. */
function readMetaForActivity(sessionDir: string): Partial<SessionMeta> | null {
  try {
    const raw = fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw) as Partial<SessionMeta> | null;
    return meta !== null && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/** Epoch ms when `value` is a usable timestamp, else null. */
function usableTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Last-activity timestamp of a session directory — the ranking key for the
 * sessionless default resume (`getLatestSessionForWorkspace`, issue #40).
 *
 * Signals, most authoritative first:
 *  1. `conversation.jsonl` — the newest entry's `timestamp`, i.e. when the
 *     session last actually did something (a message was written).
 *  2. `meta.lastActiveAt` — bumped on every user input; covers sessions whose
 *     transcript is missing, and any input not yet reflected in content.
 *  3. `meta.createdAt` — creation time, as the documented last resort for
 *     sessions that carry no activity information at all (e.g. a meta.json
 *     written before `lastActiveAt` existed, or an empty session).
 *
 * The newest of (1) and (2) wins rather than a strict priority: metadata can
 * be ahead of the transcript (input recorded, turn not written yet) and the
 * transcript can be ahead of metadata (activity after the last user input).
 * Ties prefer the earlier signal in the list above. Returns null only when the
 * directory yields no timestamp at all — callers then fall back to
 * `meta.createdAt` from their own snapshot, or treat the session as oldest.
 *
 * @param sessionDir  One `sessions/<id>` directory.
 */
export function readSessionLastActivity(sessionDir: string): SessionActivity | null {
  const meta = readMetaForActivity(sessionDir);
  const candidates: SessionActivity[] = [];

  const conversationAt = readTailEntryTimestamp(path.join(sessionDir, CONVERSATION_FILENAME));
  if (conversationAt !== null) candidates.push({ at: conversationAt, source: 'conversation' });

  const lastActiveAt = usableTimestamp(meta?.lastActiveAt);
  if (lastActiveAt !== null) candidates.push({ at: lastActiveAt, source: 'meta.lastActiveAt' });

  const createdAt = usableTimestamp(meta?.createdAt);
  if (createdAt !== null) candidates.push({ at: createdAt, source: 'meta.createdAt' });

  if (candidates.length === 0) return null;
  // Strictly-greater keeps the earlier (more authoritative) signal on a tie.
  return candidates.reduce((best, candidate) => (candidate.at > best.at ? candidate : best));
}

/** Minimal shape the activity-based selector needs from a session entry. */
export interface SessionActivityCandidate {
  sessionId: string;
}

/**
 * Pick the most recently active candidate; null when there are none.
 *
 * Tie-break (equal activity timestamps): the greater `sessionId` wins, compared
 * with plain `>` — byte-wise, locale-independent, descending. Session ids are
 * `<timestamp>-<random>` directory names, so this settles ties on "the newer
 * directory", and — more importantly — makes the result a pure function of the
 * candidate set: input order never matters and repeated runs agree.
 */
export function pickMostRecentlyActive<T extends SessionActivityCandidate>(
  candidates: readonly T[],
  activityOf: (candidate: T) => number,
): T | null {
  let best: T | null = null;
  let bestAt = 0;
  for (const candidate of candidates) {
    const at = activityOf(candidate);
    if (best === null || at > bestAt || (at === bestAt && candidate.sessionId > best.sessionId)) {
      best = candidate;
      bestAt = at;
    }
  }
  return best;
}

/** Ranking key for one indexed session: last activity, else creation time. */
function activityAtForEntry(entry: SessionEntry): number {
  const activity = readSessionLastActivity(entry.sessionDir);
  if (activity) return activity.at;
  // The index already required a readable meta.json; a missing/odd createdAt
  // means "oldest" rather than an exception.
  return usableTimestamp(entry.meta.createdAt) ?? 0;
}

/**
 * Find the most recently *active* session for a given workspace.
 * Used by the sessionless default: `wayang` (no flags) resumes the session the
 * user was last working in, if one exists.
 *
 * Ranking key is last activity — the newest `conversation.jsonl` entry
 * timestamp, then `meta.lastActiveAt`, then `meta.createdAt` (full fallback
 * rules in `readSessionLastActivity`). Creation order is deliberately *not*
 * the key: a session created later but used only once must not displace the
 * one the user kept working in (issue #40). Equal activity timestamps are
 * settled deterministically by session id descending — see
 * `pickMostRecentlyActive`.
 *
 * Multi-workspace aware: a session matches when any of its `workspaces`
 * entries resolves to the same canonical path as `workspaceDir`, falling back
 * to the single-valued `workspace` for legacy meta. Path spellings
 * (symlink/relative/trailing slash) are normalized before comparison — see
 * `SessionIndex.list`. Archived sessions are skipped unless asked for.
 *
 * Only this default path changes: an explicit `--resume <id>` and the
 * interactive picker keep their own semantics (`listSessions` is still
 * newest-created first).
 *
 * @param dataDir  Wayang home directory (contains sessions/)
 * @param workspaceDir  Workspace directory to match against
 * @param opts.includeArchived  Also rank archived sessions (default false).
 * @returns The most recently active matching session, or null if none exists.
 */
export function getLatestSessionForWorkspace(
  dataDir: string,
  workspaceDir: string,
  opts: { includeArchived?: boolean } = {},
): { sessionId: string; sessionDir: string; meta: SessionMeta } | null {
  const candidates = createSessionIndex(dataDir).list({
    workspace: workspaceDir,
    includeArchived: opts.includeArchived,
  });
  return pickMostRecentlyActive(candidates, activityAtForEntry);
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
