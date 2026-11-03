import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSessions, getSession } from '@/infra/session-helpers';
import { findWorkspace, normalizeWorkspacePath, workspaceSlugFromPath } from '@/infra/workspace-registry';
import { SessionManager } from '@/services/session/session-manager';

/** Read meta.json from disk for assertion. */
function readMeta(sessionDir: string) {
  return JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8'));
}

/**
 * Write a pre-workspaces (legacy) session: meta.json carrying only the
 * single-valued `workspace` field, as written before `workspaces` existed.
 */
function writeLegacySession(homeDir: string, sessionId: string, workspace: string): string {
  const sessionDir = join(homeDir, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify({ sessionId, workspace, firstInput: 'legacy input', createdAt: 1000, lastActiveAt: 2000 }),
  );
  return sessionDir;
}

describe('session-helpers', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'wayang-session-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('should create a new session via SessionManager.create', () => {
    const mgr = SessionManager.create(homeDir, '/workspace');
    expect(mgr.sessionId).toBeTruthy();
    expect(mgr.sessionDir).toContain(mgr.sessionId);
    expect(existsSync(join(mgr.sessionDir, 'meta.json'))).toBe(true);
  });

  it('should create meta.json with correct fields', () => {
    const mgr = SessionManager.create(homeDir, '/workspace');
    const meta = readMeta(mgr.sessionDir);
    expect(meta.workspace).toBe('/workspace');
    expect(meta.firstInput).toBeNull();
    expect(meta.createdAt).toBeGreaterThan(0);
  });

  it('should list sessions', () => {
    SessionManager.create(homeDir, '/ws1');
    SessionManager.create(homeDir, '/ws2');
    const sessions = listSessions(homeDir);
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.workspace)).toEqual(expect.arrayContaining(['/ws1', '/ws2']));
  });

  it('should list empty when no sessions', () => {
    expect(listSessions(homeDir)).toHaveLength(0);
  });

  it('should get a session by id', () => {
    const mgr = SessionManager.create(homeDir, '/workspace');
    const result = getSession(homeDir, mgr.sessionId);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(mgr.sessionId);
    expect(result!.meta.workspace).toBe('/workspace');
  });

  it('should return null for nonexistent session', () => {
    expect(getSession(homeDir, 'nonexistent')).toBeNull();
  });
});

describe('SessionManager', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'wayang-meta-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('should have isResume=false for new sessions', () => {
    const mgr = SessionManager.create(homeDir, '/workspace');
    expect(mgr.isResume).toBe(false);
  });

  it('should have isResume=true for resumed sessions', () => {
    const created = SessionManager.create(homeDir, '/workspace');
    const resumed = SessionManager.resume(created.sessionId, created.sessionDir);
    expect(resumed.isResume).toBe(true);
  });

  it('should restore from meta.json on resume', async () => {
    const created = SessionManager.create(homeDir, '/workspace');
    const resumed = SessionManager.resume(created.sessionId, created.sessionDir);
    await resumed.restore();

    expect(resumed.hasFirstInput).toBe(false);
    expect(resumed.workspace).toBe('/workspace');
  });

  it('should record first input', () => {
    const mgr = SessionManager.create(homeDir, '/workspace');

    mgr.onUserInput('hello');
    expect(mgr.hasFirstInput).toBe(true);
    expect(readMeta(mgr.sessionDir).firstInput).toBe('hello');
  });

  it('should not overwrite first input', () => {
    const mgr = SessionManager.create(homeDir, '/workspace');

    mgr.onUserInput('first');
    mgr.onUserInput('second');
    expect(readMeta(mgr.sessionDir).firstInput).toBe('first');
  });

  it('should update lastActiveAt on every input', () => {
    const mgr = SessionManager.create(homeDir, '/workspace');

    const before = readMeta(mgr.sessionDir).lastActiveAt;
    mgr.onUserInput('hello');
    const after = readMeta(mgr.sessionDir).lastActiveAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('should persist across restore', async () => {
    const created = SessionManager.create(homeDir, '/workspace');
    created.onUserInput('persisted');

    const resumed = SessionManager.resume(created.sessionId, created.sessionDir);
    await resumed.restore();
    expect(resumed.hasFirstInput).toBe(true);
    expect(readMeta(created.sessionDir).firstInput).toBe('persisted');
  });
});

describe('SessionManager — workspace identity', () => {
  let homeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'wayang-ws-meta-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'wayang-ws-dir-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('writes workspace and workspaces together for a new session', () => {
    const mgr = SessionManager.create(homeDir, workspaceDir);
    const meta = readMeta(mgr.sessionDir);

    // Legacy field untouched, array mirrors it.
    expect(meta.workspace).toBe(workspaceDir);
    expect(meta.workspaces).toHaveLength(1);
    expect(meta.workspaces[0]).toEqual({
      path: normalizeWorkspacePath(workspaceDir),
      slug: workspaceSlugFromPath(normalizeWorkspacePath(workspaceDir)),
    });
    expect(mgr.workspaces).toEqual(meta.workspaces);
  });

  it('synthesizes workspaces from a legacy single-workspace meta', async () => {
    const sessionDir = writeLegacySession(homeDir, 'legacy-a', workspaceDir);
    const mgr = SessionManager.resume('legacy-a', sessionDir, homeDir);
    await mgr.restore();

    const workspaces = mgr.workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].path).toBe(normalizeWorkspacePath(workspaceDir));
    // Slug comes from the registry, so it is the one every other record uses.
    expect(workspaces[0].slug).toBe(findWorkspace(homeDir, workspaceDir)!.slug);
    // Legacy fields are preserved, not replaced.
    expect(mgr.workspace).toBe(workspaceDir);
    expect(mgr.hasFirstInput).toBe(true);
  });

  it('leaves the legacy meta.json on disk untouched while reading', async () => {
    const sessionDir = writeLegacySession(homeDir, 'legacy-b', workspaceDir);
    await SessionManager.resume('legacy-b', sessionDir, homeDir).restore();
    expect(readMeta(sessionDir).workspaces).toBeUndefined();
  });

  it('is idempotent: repeated reads of one legacy session agree', async () => {
    const sessionDir = writeLegacySession(homeDir, 'legacy-c', workspaceDir);

    const first = SessionManager.resume('legacy-c', sessionDir, homeDir);
    await first.restore();
    const firstRead = first.workspaces;
    // Second read on the same instance, then a fresh resume of the same file.
    expect(first.workspaces).toEqual(firstRead);
    const second = SessionManager.resume('legacy-c', sessionDir, homeDir);
    await second.restore();
    expect(second.workspaces).toEqual(firstRead);
  });

  it('keeps an existing multi-workspace list intact across writes', async () => {
    const sessionDir = writeLegacySession(homeDir, 'legacy-d', workspaceDir);
    const other = mkdtempSync(join(tmpdir(), 'wayang-ws-other-'));
    try {
      const existing = [
        { path: normalizeWorkspacePath(workspaceDir), slug: workspaceSlugFromPath(normalizeWorkspacePath(workspaceDir)) },
        { path: normalizeWorkspacePath(other), slug: workspaceSlugFromPath(normalizeWorkspacePath(other)) },
      ];
      const meta = readMeta(sessionDir);
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({ ...meta, workspaces: existing }));

      const mgr = SessionManager.resume('legacy-d', sessionDir, homeDir);
      await mgr.restore();
      expect(mgr.workspaces).toEqual(existing);

      mgr.onUserInput('after');
      const persisted = readMeta(sessionDir);
      expect(persisted.workspaces).toEqual(existing);
      expect(persisted.workspace).toBe(workspaceDir);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('persists the synthesized workspaces on the next normal write', async () => {
    const sessionDir = writeLegacySession(homeDir, 'legacy-e', workspaceDir);
    const mgr = SessionManager.resume('legacy-e', sessionDir, homeDir);
    await mgr.restore();
    const synthesized = mgr.workspaces;

    mgr.onUserInput('hello again');
    const persisted = readMeta(sessionDir);
    expect(persisted.workspaces).toEqual(synthesized);
    expect(persisted.workspace).toBe(workspaceDir);
    // Nothing else was lost.
    expect(persisted.firstInput).toBe('legacy input');
    expect(persisted.createdAt).toBe(1000);
  });

  it('reads path and slug without throwing when the workspace dir is gone', async () => {
    const missing = join(homeDir, 'gone', 'my-repo');
    const sessionDir = writeLegacySession(homeDir, 'legacy-f', missing);

    const mgr = SessionManager.resume('legacy-f', sessionDir, homeDir);
    await mgr.restore();

    expect(mgr.workspaces).toHaveLength(1);
    // path.resolve fallback keeps it absolute; the slug needs no directory.
    expect(mgr.workspaces[0].path).toBe(normalizeWorkspacePath(missing));
    expect(mgr.workspaces[0].slug).toBe('my-repo');
    // Reading is still a pure read: the legacy file was not rewritten.
    expect(readMeta(sessionDir).workspaces).toBeUndefined();
  });
});
