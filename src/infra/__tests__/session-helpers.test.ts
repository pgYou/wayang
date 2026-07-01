import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getLatestSessionForWorkspace, listSessions, getSession } from '@/infra/session-helpers';
import type { SessionMeta } from '@/infra/session-helpers';

// --- Helpers ---

let homeDir: string;

function writeSessionMeta(sessionId: string, meta: Partial<SessionMeta> & { workspace: string; createdAt: number }) {
  const dir = join(homeDir, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const full: SessionMeta = {
    sessionId,
    workspace: meta.workspace,
    firstInput: meta.firstInput ?? null,
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt ?? meta.createdAt,
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(full));
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'wayang-sessions-test-'));
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('session-helpers — getLatestSessionForWorkspace', () => {
  it('returns null when no sessions exist', () => {
    expect(getLatestSessionForWorkspace(homeDir, '/repo-a')).toBeNull();
  });

  it('returns the newest session for the given workspace', () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });
    writeSessionMeta('20260102-000000', { workspace: '/repo-a', createdAt: 2000 });
    writeSessionMeta('20260103-000000', { workspace: '/repo-b', createdAt: 3000 });

    const result = getLatestSessionForWorkspace(homeDir, '/repo-a');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('20260102-000000');
    expect(result!.meta.workspace).toBe('/repo-a');
  });

  it('isolates workspaces: ignores sessions from other workspaces', () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });
    writeSessionMeta('20260102-000000', { workspace: '/repo-b', createdAt: 2000 });

    expect(getLatestSessionForWorkspace(homeDir, '/repo-a')!.sessionId).toBe('20260101-000000');
    expect(getLatestSessionForWorkspace(homeDir, '/repo-b')!.sessionId).toBe('20260102-000000');
    expect(getLatestSessionForWorkspace(homeDir, '/repo-c')).toBeNull();
  });

  it('returns a resolvable sessionDir that getSession can read', () => {
    writeSessionMeta('20260101-000000', { workspace: '/repo-a', createdAt: 1000 });
    const latest = getLatestSessionForWorkspace(homeDir, '/repo-a')!;
    expect(getSession(homeDir, latest.sessionId)?.sessionId).toBe(latest.sessionId);
  });
});

describe('session-helpers — listSessions ordering', () => {
  it('returns sessions sorted newest-first by createdAt', () => {
    writeSessionMeta('old', { workspace: '/r', createdAt: 1000 });
    writeSessionMeta('newest', { workspace: '/r', createdAt: 3000 });
    writeSessionMeta('mid', { workspace: '/r', createdAt: 2000 });
    const ordered = listSessions(homeDir).map(m => m.sessionId);
    expect(ordered).toEqual(['newest', 'mid', 'old']);
  });
});
