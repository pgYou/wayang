import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getLatestSessionForWorkspace,
  listSessions,
  getSession,
  pickMostRecentlyActive,
  readSessionLastActivity,
} from '@/infra/session-helpers';
import type { SessionMeta } from '@/infra/session-helpers';

// --- Helpers ---

let dataDir: string;

function writeSessionMeta(sessionId: string, meta: Partial<SessionMeta> & { workspace: string; createdAt: number }) {
  const dir = join(dataDir, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const full: SessionMeta = {
    sessionId,
    workspace: meta.workspace,
    firstInput: meta.firstInput ?? null,
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt ?? meta.createdAt,
    ...(meta.workspaces ? { workspaces: meta.workspaces } : {}),
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(full));
}

/** Write a meta.json verbatim — for legacy shapes that lack fields like lastActiveAt. */
function writeRawSessionMeta(sessionId: string, meta: Record<string, unknown>) {
  const dir = join(dataDir, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
}

/** Create `sessions/<id>/` without a meta.json (content-only session). */
function sessionDir(sessionId: string): string {
  const dir = join(dataDir, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append controller-conversation entries, one per timestamp (ISO strings). */
function writeConversation(dir: string, timestamps: string[], extra: Record<string, unknown> = {}) {
  const lines = timestamps.map(ts => JSON.stringify({ type: 'user', uuid: ts, timestamp: ts, ...extra }));
  writeFileSync(join(dir, 'conversation.jsonl'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wayang-sessions-test-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('session-helpers — getLatestSessionForWorkspace', () => {
  it('returns null when no sessions exist', () => {
    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')).toBeNull();
  });

  it('returns the newest session for the given workspace', () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });
    writeSessionMeta('20260102-000000', { workspace: '/repo-a', createdAt: 2000 });
    writeSessionMeta('20260103-000000', { workspace: '/repo-b', createdAt: 3000 });

    const result = getLatestSessionForWorkspace(dataDir, '/repo-a');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('20260102-000000');
    expect(result!.meta.workspace).toBe('/repo-a');
  });

  it('isolates workspaces: ignores sessions from other workspaces', () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });
    writeSessionMeta('20260102-000000', { workspace: '/repo-b', createdAt: 2000 });

    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('20260101-000000');
    expect(getLatestSessionForWorkspace(dataDir, '/repo-b')!.sessionId).toBe('20260102-000000');
    expect(getLatestSessionForWorkspace(dataDir, '/repo-c')).toBeNull();
  });

  it('returns a resolvable sessionDir that getSession can read', () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });
    const latest = getLatestSessionForWorkspace(dataDir, '/repo-a')!;
    expect(getSession(dataDir, latest.sessionId)?.sessionId).toBe(latest.sessionId);
  });
});

describe('session-helpers — listSessions ordering', () => {
  it('returns sessions sorted newest-first by createdAt', () => {
    writeSessionMeta('old', { workspace: '/r', createdAt: 1000 });
    writeSessionMeta('newest', { workspace: '/r', createdAt: 3000 });
    writeSessionMeta('mid', { workspace: '/r', createdAt: 2000 });
    const ordered = listSessions(dataDir).map(m => m.sessionId);
    expect(ordered).toEqual(['newest', 'mid', 'old']);
  });
});

describe('session-helpers — getLatestSessionForWorkspace (multi-workspace)', () => {
  it('matches a session through either of its workspaces entries', () => {
    writeSessionMeta('multi', {
      workspace: '/repo-a',
      workspaces: [
        { path: '/repo-a', slug: 'repo-a' },
        { path: '/repo-b', slug: 'repo-b' },
      ],
      createdAt: 1000,
    });
    writeSessionMeta('only-c', { workspace: '/repo-c', createdAt: 2000 });

    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('multi');
    expect(getLatestSessionForWorkspace(dataDir, '/repo-b')!.sessionId).toBe('multi');
    expect(getLatestSessionForWorkspace(dataDir, '/repo-c')!.sessionId).toBe('only-c');
    expect(getLatestSessionForWorkspace(dataDir, '/repo-d')).toBeNull();
  });

  it('matches a legacy session via a symlink spelling of its workspace', () => {
    const real = join(dataDir, 'real-repo');
    mkdirSync(real, { recursive: true });
    const alias = join(dataDir, 'alias-repo');
    symlinkSync(real, alias);

    writeSessionMeta('legacy', { workspace: `${real}/`, createdAt: 1000 });

    // Real path, symlink, and trailing-slash spellings all resolve to one session.
    expect(getLatestSessionForWorkspace(dataDir, real)!.sessionId).toBe('legacy');
    expect(getLatestSessionForWorkspace(dataDir, alias)!.sessionId).toBe('legacy');
    expect(getLatestSessionForWorkspace(dataDir, `${alias}/`)!.sessionId).toBe('legacy');
    expect(getLatestSessionForWorkspace(dataDir, join(dataDir, 'other'))).toBeNull();
  });

  it('picks the newest session when several matches exist', () => {
    writeSessionMeta('older', { workspace: '/repo-a', createdAt: 1000, lastActiveAt: 1000 });
    writeSessionMeta('newer', { workspace: '/repo-a', createdAt: 3000, lastActiveAt: 3000 });
    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('newer');
  });
});

// --- Last-activity ranking (issue #40) ---

describe('session-helpers — readSessionLastActivity', () => {
  it('uses the newest conversation entry timestamp', () => {
    const dir = sessionDir('s1');
    writeConversation(dir, ['2026-01-01T10:00:00.000Z', '2026-01-01T12:30:00.000Z']);

    expect(readSessionLastActivity(dir)).toEqual({
      at: Date.parse('2026-01-01T12:30:00.000Z'),
      source: 'conversation',
    });
  });

  it('reports the newer of conversation and meta.lastActiveAt', () => {
    const dir = sessionDir('s1');
    writeConversation(dir, ['2026-01-01T10:00:00.000Z']);
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        sessionId: 's1',
        workspace: '/repo-a',
        firstInput: null,
        createdAt: 1000,
        lastActiveAt: Date.parse('2026-01-02T09:00:00.000Z'),
      }),
    );

    expect(readSessionLastActivity(dir)).toEqual({
      at: Date.parse('2026-01-02T09:00:00.000Z'),
      source: 'meta.lastActiveAt',
    });
  });

  it('falls back to meta.lastActiveAt when the conversation is missing', () => {
    const dir = sessionDir('s1');
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ sessionId: 's1', workspace: '/repo-a', firstInput: null, createdAt: 1000, lastActiveAt: 5000 }),
    );

    expect(readSessionLastActivity(dir)).toEqual({ at: 5000, source: 'meta.lastActiveAt' });
  });

  it('falls back to meta.createdAt for sessions written before lastActiveAt existed', () => {
    const dir = sessionDir('s1');
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ sessionId: 's1', workspace: '/repo-a', firstInput: null, createdAt: 1000 }),
    );

    expect(readSessionLastActivity(dir)).toEqual({ at: 1000, source: 'meta.createdAt' });
  });

  it('returns null when nothing in the directory carries a timestamp', () => {
    expect(readSessionLastActivity(sessionDir('empty'))).toBeNull();
  });

  it('skips a torn trailing line and uses the last complete entry', () => {
    const dir = sessionDir('s1');
    writeConversation(dir, ['2026-01-01T10:00:00.000Z']);
    writeFileSync(
      join(dir, 'conversation.jsonl'),
      `{"type":"user","timestamp":"${'2026-01-01T10:00:00.000Z'}"}\n{"type":"assistant","timestamp":"2026-01-01T11`,
    );

    expect(readSessionLastActivity(dir)).toEqual({
      at: Date.parse('2026-01-01T10:00:00.000Z'),
      source: 'conversation',
    });
  });

  it('reads past a single entry larger than the first tail window', () => {
    const dir = sessionDir('s1');
    const bigEntry = { type: 'assistant', timestamp: '2026-01-01T08:00:00.000Z', text: 'x'.repeat(300_000) };
    writeFileSync(
      join(dir, 'conversation.jsonl'),
      `${JSON.stringify(bigEntry)}\n${JSON.stringify({ type: 'user', timestamp: '2026-01-01T09:00:00.000Z' })}\n`,
    );

    expect(readSessionLastActivity(dir)).toEqual({
      at: Date.parse('2026-01-01T09:00:00.000Z'),
      source: 'conversation',
    });
  });
});

describe('session-helpers — getLatestSessionForWorkspace ranks by last activity', () => {
  it('prefers the most recently active session over the newest created (issue #40)', () => {
    // A: created first, but the user kept working in it.
    const a = sessionDir('20260101-090000-aaaa');
    writeSessionMeta('20260101-090000-aaaa', { workspace: '/repo-a', createdAt: 1000 });
    writeConversation(a, ['2026-01-01T09:00:00.000Z', '2026-01-05T18:00:00.000Z']);

    // B: created later, used once.
    const b = sessionDir('20260102-090000-bbbb');
    writeSessionMeta('20260102-090000-bbbb', { workspace: '/repo-a', createdAt: 3000 });
    writeConversation(b, ['2026-01-02T09:30:00.000Z']);

    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('20260101-090000-aaaa');
  });

  it('uses meta.lastActiveAt when a session has no transcript', () => {
    writeSessionMeta('20260101-090000-aaaa', {
      workspace: '/repo-a',
      createdAt: 1000,
      lastActiveAt: Date.parse('2026-01-06T00:00:00.000Z'),
    });
    writeSessionMeta('20260102-090000-bbbb', {
      workspace: '/repo-a',
      createdAt: 3000,
      lastActiveAt: Date.parse('2026-01-03T00:00:00.000Z'),
    });

    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('20260101-090000-aaaa');
  });

  it('falls back to createdAt when no session carries activity information', () => {
    writeRawSessionMeta('20260101-090000-aaaa', { sessionId: '20260101-090000-aaaa', workspace: '/repo-a', createdAt: 1000 });
    writeRawSessionMeta('20260102-090000-bbbb', { sessionId: '20260102-090000-bbbb', workspace: '/repo-a', createdAt: 3000 });

    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('20260102-090000-bbbb');
  });

  it('breaks ties deterministically by session id, descending', () => {
    const ts = '2026-01-04T00:00:00.000Z';
    writeConversation(sessionDir('20260101-090000-aaaa'), [ts]);
    writeSessionMeta('20260101-090000-aaaa', { workspace: '/repo-a', createdAt: 1000 });
    writeConversation(sessionDir('20260102-090000-bbbb'), [ts]);
    writeSessionMeta('20260102-090000-bbbb', { workspace: '/repo-a', createdAt: 3000 });

    const picked = Array.from({ length: 5 }, () => getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId);
    expect(picked).toEqual(Array(5).fill('20260102-090000-bbbb'));
  });

  it('still skips archived sessions unless asked for them', () => {
    const a = sessionDir('20260101-090000-aaaa');
    writeRawSessionMeta('20260101-090000-aaaa', {
      sessionId: '20260101-090000-aaaa',
      workspace: '/repo-a',
      createdAt: 1000,
      lastActiveAt: 1000,
      archived: true,
    });
    writeConversation(a, ['2026-01-09T00:00:00.000Z']);
    const b = sessionDir('20260102-090000-bbbb');
    writeSessionMeta('20260102-090000-bbbb', { workspace: '/repo-a', createdAt: 3000 });
    writeConversation(b, ['2026-01-02T09:30:00.000Z']);

    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('20260102-090000-bbbb');
    expect(getLatestSessionForWorkspace(dataDir, '/repo-a', { includeArchived: true })!.sessionId).toBe(
      '20260101-090000-aaaa',
    );
  });

  it('keeps explicit id lookup independent of activity ranking', () => {
    const a = sessionDir('20260101-090000-aaaa');
    writeSessionMeta('20260101-090000-aaaa', { workspace: '/repo-a', createdAt: 1000 });
    writeConversation(a, ['2026-01-01T09:00:00.000Z']);
    const b = sessionDir('20260102-090000-bbbb');
    writeSessionMeta('20260102-090000-bbbb', { workspace: '/repo-a', createdAt: 3000 });
    writeConversation(b, ['2026-01-05T00:00:00.000Z']);

    // Auto-resume picks the active one...
    expect(getLatestSessionForWorkspace(dataDir, '/repo-a')!.sessionId).toBe('20260102-090000-bbbb');
    // ...but `--resume <id>` still resolves whatever the user named.
    expect(getSession(dataDir, '20260101-090000-aaaa')?.sessionId).toBe('20260101-090000-aaaa');
  });
});

describe('session-helpers — pickMostRecentlyActive', () => {
  const candidates = [
    { sessionId: '20260101-000000', activityAt: 5000 },
    { sessionId: '20260102-000000', activityAt: 9000 },
    { sessionId: '20260103-000000', activityAt: 1000 },
  ];
  const activityOf = (c: { activityAt: number }) => c.activityAt;

  it('returns null for an empty candidate set', () => {
    expect(pickMostRecentlyActive([], activityOf)).toBeNull();
  });

  it('picks the greatest activity timestamp regardless of input order', () => {
    expect(pickMostRecentlyActive(candidates, activityOf)?.sessionId).toBe('20260102-000000');
    expect(pickMostRecentlyActive([...candidates].reverse(), activityOf)?.sessionId).toBe('20260102-000000');
  });

  it('breaks ties by session id descending, independent of input order', () => {
    const tied = candidates.map(c => ({ ...c, activityAt: 7000 }));
    expect(pickMostRecentlyActive(tied, activityOf)?.sessionId).toBe('20260103-000000');
    expect(pickMostRecentlyActive([...tied].reverse(), activityOf)?.sessionId).toBe('20260103-000000');
    expect(pickMostRecentlyActive([tied[1], tied[2], tied[0]], activityOf)?.sessionId).toBe('20260103-000000');
  });
});
