/**
 * SessionIndex — queryable view over `sessions/<id>/meta.json`.
 *
 * Design constraints (see 0.5 decisions):
 * - No on-disk shared index file. CLI supports multiple concurrent instances
 *   without any cross-process lock, so a shared writable index file would be
 *   silently clobbered by concurrent writers. meta.json is per-session and
 *   therefore naturally isolated; it stays the single source of truth.
 * - The index is therefore a pure in-process cache: `readdirSync` + parse each
 *   meta.json once, then serve repeat queries from memory.
 * - Correctness is guaranteed by "rebuild on first use per process", not by
 *   incremental cross-process maintenance. External writes made after this
 *   process built its cache are invisible until `invalidate()` is called.
 *
 * The interface intentionally leaves room for pagination (limit/cursor) and
 * filtering (workspace/archived) so a future SQLite-backed implementation can
 * be swapped in without touching call sites.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionMeta } from './session-helpers';

/** A session entry as exposed by the index: metadata plus resolved paths. */
export interface SessionEntry {
  sessionId: string;
  sessionDir: string;
  meta: SessionMeta;
}

export interface ListSessionsQuery {
  /** Only return sessions belonging to this workspace directory. */
  workspace?: string;
  /** Include archived sessions. Defaults to false. */
  includeArchived?: boolean;
  /** Maximum number of entries to return. Omitted means unlimited. */
  limit?: number;
  /** Opaque cursor from a previous `list()` call; skips entries before it. */
  cursor?: string;
}

export interface SessionIndex {
  /** List sessions, newest-created first, optionally filtered. */
  list(query?: ListSessionsQuery): SessionEntry[];
  /** Look up a single session by ID. */
  get(sessionId: string): SessionEntry | null;
  /** Most recently created session for a workspace, or null. */
  latestForWorkspace(workspace: string, opts?: { includeArchived?: boolean }): SessionEntry | null;
  /** Record a session that was just created/updated in this process. */
  upsert(entry: SessionEntry): void;
  /** Drop the cache so the next query re-reads the filesystem. */
  invalidate(): void;
}

/** Internal cache shape: ordered entries plus an id lookup map. */
interface CacheState {
  /** Newest-created first. */
  entries: SessionEntry[];
  byId: Map<string, SessionEntry>;
}

function sortNewestFirst(entries: SessionEntry[]): SessionEntry[] {
  return entries.sort((a, b) => b.meta.createdAt - a.meta.createdAt);
}

/**
 * Read every `sessions/<id>/meta.json` under `homeDir`.
 *
 * Unreadable or malformed meta files are skipped rather than throwing: a
 * single corrupt session must not make the whole list unusable. Corrupt
 * session *content* is surfaced elsewhere; here we only need a browsable list.
 */
function readEntriesFromDisk(homeDir: string): SessionEntry[] {
  const sessionsDir = path.join(homeDir, 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const entries: SessionEntry[] = [];
  for (const name of names) {
    const sessionDir = path.join(sessionsDir, name);
    const metaPath = path.join(sessionDir, 'meta.json');
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as SessionMeta;
      if (!meta || typeof meta.sessionId !== 'string') continue;
      entries.push({ sessionId: meta.sessionId, sessionDir, meta });
    } catch {
      // Missing or malformed meta.json — skip this session.
    }
  }
  return sortNewestFirst(entries);
}

function buildCache(homeDir: string): CacheState {
  const entries = readEntriesFromDisk(homeDir);
  return {
    entries,
    byId: new Map(entries.map(e => [e.sessionId, e])),
  };
}

/** Default in-memory implementation of SessionIndex. */
class InMemorySessionIndex implements SessionIndex {
  private cache: CacheState | null = null;

  constructor(private readonly homeDir: string) {}

  private ensureCache(): CacheState {
    if (!this.cache) {
      this.cache = buildCache(this.homeDir);
    }
    return this.cache;
  }

  list(query: ListSessionsQuery = {}): SessionEntry[] {
    const { entries } = this.ensureCache();
    const includeArchived = query.includeArchived ?? false;

    let result = entries;
    if (query.workspace !== undefined) {
      result = result.filter(e => e.meta.workspace === query.workspace);
    }
    if (!includeArchived) {
      result = result.filter(e => !e.meta.archived);
    }

    // Cursor semantics: skip everything up to and including the cursor entry.
    // Entries are newest-first, so the cursor is a sessionId from a previous page.
    if (query.cursor) {
      const idx = result.findIndex(e => e.sessionId === query.cursor);
      if (idx >= 0) {
        result = result.slice(idx + 1);
      }
    }

    if (query.limit !== undefined && query.limit >= 0) {
      result = result.slice(0, query.limit);
    }
    return result;
  }

  get(sessionId: string): SessionEntry | null {
    return this.ensureCache().byId.get(sessionId) ?? null;
  }

  latestForWorkspace(workspace: string, opts: { includeArchived?: boolean } = {}): SessionEntry | null {
    const matches = this.list({ workspace, includeArchived: opts.includeArchived });
    return matches[0] ?? null;
  }

  upsert(entry: SessionEntry): void {
    const cache = this.ensureCache();
    const existingIndex = cache.entries.findIndex(e => e.sessionId === entry.sessionId);
    if (existingIndex >= 0) {
      cache.entries[existingIndex] = entry;
    } else {
      cache.entries.push(entry);
    }
    sortNewestFirst(cache.entries);
    cache.byId.set(entry.sessionId, entry);
  }

  invalidate(): void {
    this.cache = null;
  }
}

/**
 * Create a SessionIndex rooted at `homeDir` (the directory containing
 * `sessions/`). The cache is populated lazily on first query.
 */
export function createSessionIndex(homeDir: string): SessionIndex {
  return new InMemorySessionIndex(homeDir);
}
