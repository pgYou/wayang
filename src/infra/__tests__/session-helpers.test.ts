import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
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
    ...(meta.workspaces ? { workspaces: meta.workspaces } : {}),
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

    expect(getLatestSessionForWorkspace(homeDir, '/repo-a')!.sessionId).toBe('multi');
    expect(getLatestSessionForWorkspace(homeDir, '/repo-b')!.sessionId).toBe('multi');
    expect(getLatestSessionForWorkspace(homeDir, '/repo-c')!.sessionId).toBe('only-c');
    expect(getLatestSessionForWorkspace(homeDir, '/repo-d')).toBeNull();
  });

  it('matches a legacy session via a symlink spelling of its workspace', () => {
    const real = join(homeDir, 'real-repo');
    mkdirSync(real, { recursive: true });
    const alias = join(homeDir, 'alias-repo');
    symlinkSync(real, alias);

    writeSessionMeta('legacy', { workspace: `${real}/`, createdAt: 1000 });

    // Real path, symlink, and trailing-slash spellings all resolve to one session.
    expect(getLatestSessionForWorkspace(homeDir, real)!.sessionId).toBe('legacy');
    expect(getLatestSessionForWorkspace(homeDir, alias)!.sessionId).toBe('legacy');
    expect(getLatestSessionForWorkspace(homeDir, `${alias}/`)!.sessionId).toBe('legacy');
    expect(getLatestSessionForWorkspace(homeDir, join(homeDir, 'other'))).toBeNull();
  });

  it('picks the newest session when several matches exist', () => {
    writeSessionMeta('older', { workspace: '/repo-a', createdAt: 1000, lastActiveAt: 1000 });
    writeSessionMeta('newer', { workspace: '/repo-a', createdAt: 3000, lastActiveAt: 3000 });
    expect(getLatestSessionForWorkspace(homeDir, '/repo-a')!.sessionId).toBe('newer');
  });
});
