import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
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
function writeLegacySession(dataDir: string, sessionId: string, workspace: string): string {
  const sessionDir = join(dataDir, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify({ sessionId, workspace, firstInput: 'legacy input', createdAt: 1000, lastActiveAt: 2000 }),
  );
  return sessionDir;
}

/**
 * Write a session whose meta already carries an accumulated `workspaces` list,
 * as a session that ran in more than one directory would.
 */
function writeMultiWorkspaceSession(
  dataDir: string,
  sessionId: string,
  workspace: string,
  workspaces: { path: string; slug: string }[],
): string {
  const sessionDir = join(dataDir, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify({ sessionId, workspace, workspaces, firstInput: 'multi', createdAt: 1000, lastActiveAt: 2000 }),
  );
  return sessionDir;
}

describe('session-helpers', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wayang-session-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('should create a new session via SessionManager.create', () => {
    const mgr = SessionManager.create(dataDir, '/workspace');
    expect(mgr.sessionId).toBeTruthy();
    expect(mgr.sessionDir).toContain(mgr.sessionId);
    expect(existsSync(join(mgr.sessionDir, 'meta.json'))).toBe(true);
  });

  it('should create meta.json with correct fields', () => {
    const mgr = SessionManager.create(dataDir, '/workspace');
    const meta = readMeta(mgr.sessionDir);
    expect(meta.workspace).toBe('/workspace');
    expect(meta.firstInput).toBeNull();
    expect(meta.createdAt).toBeGreaterThan(0);
  });

  it('should list sessions', () => {
    SessionManager.create(dataDir, '/ws1');
    SessionManager.create(dataDir, '/ws2');
    const sessions = listSessions(dataDir);
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.workspace)).toEqual(expect.arrayContaining(['/ws1', '/ws2']));
  });

  it('should list empty when no sessions', () => {
    expect(listSessions(dataDir)).toHaveLength(0);
  });

  it('should get a session by id', () => {
    const mgr = SessionManager.create(dataDir, '/workspace');
    const result = getSession(dataDir, mgr.sessionId);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(mgr.sessionId);
    expect(result!.meta.workspace).toBe('/workspace');
  });

  it('should return null for nonexistent session', () => {
    expect(getSession(dataDir, 'nonexistent')).toBeNull();
  });
});

describe('SessionManager', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wayang-meta-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('should have isResume=false for new sessions', () => {
    const mgr = SessionManager.create(dataDir, '/workspace');
    expect(mgr.isResume).toBe(false);
  });

  it('should have isResume=true for resumed sessions', () => {
    const created = SessionManager.create(dataDir, '/workspace');
    const resumed = SessionManager.resume(created.sessionId, created.sessionDir);
    expect(resumed.isResume).toBe(true);
  });

  it('should restore from meta.json on resume', async () => {
    const created = SessionManager.create(dataDir, '/workspace');
    const resumed = SessionManager.resume(created.sessionId, created.sessionDir);
    await resumed.restore();

    expect(resumed.hasFirstInput).toBe(false);
    expect(resumed.workspace).toBe('/workspace');
  });

  it('should record first input', () => {
    const mgr = SessionManager.create(dataDir, '/workspace');

    mgr.onUserInput('hello');
    expect(mgr.hasFirstInput).toBe(true);
    expect(readMeta(mgr.sessionDir).firstInput).toBe('hello');
  });

  it('should not overwrite first input', () => {
    const mgr = SessionManager.create(dataDir, '/workspace');

    mgr.onUserInput('first');
    mgr.onUserInput('second');
    expect(readMeta(mgr.sessionDir).firstInput).toBe('first');
  });

  it('should update lastActiveAt on every input', () => {
    const mgr = SessionManager.create(dataDir, '/workspace');

    const before = readMeta(mgr.sessionDir).lastActiveAt;
    mgr.onUserInput('hello');
    const after = readMeta(mgr.sessionDir).lastActiveAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('should persist across restore', async () => {
    const created = SessionManager.create(dataDir, '/workspace');
    created.onUserInput('persisted');

    const resumed = SessionManager.resume(created.sessionId, created.sessionDir);
    await resumed.restore();
    expect(resumed.hasFirstInput).toBe(true);
    expect(readMeta(created.sessionDir).firstInput).toBe('persisted');
  });
});

describe('SessionManager — workspace identity', () => {
  let dataDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wayang-ws-meta-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'wayang-ws-dir-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('writes workspace and workspaces together for a new session', () => {
    const mgr = SessionManager.create(dataDir, workspaceDir);
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
    const sessionDir = writeLegacySession(dataDir, 'legacy-a', workspaceDir);
    const mgr = SessionManager.resume('legacy-a', sessionDir, dataDir);
    await mgr.restore();

    const workspaces = mgr.workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].path).toBe(normalizeWorkspacePath(workspaceDir));
    // Slug comes from the registry, so it is the one every other record uses.
    expect(workspaces[0].slug).toBe(findWorkspace(dataDir, workspaceDir)!.slug);
    // Legacy fields are preserved, not replaced.
    expect(mgr.workspace).toBe(workspaceDir);
    expect(mgr.hasFirstInput).toBe(true);
  });

  it('leaves the legacy meta.json on disk untouched while reading', async () => {
    const sessionDir = writeLegacySession(dataDir, 'legacy-b', workspaceDir);
    await SessionManager.resume('legacy-b', sessionDir, dataDir).restore();
    expect(readMeta(sessionDir).workspaces).toBeUndefined();
  });

  it('is idempotent: repeated reads of one legacy session agree', async () => {
    const sessionDir = writeLegacySession(dataDir, 'legacy-c', workspaceDir);

    const first = SessionManager.resume('legacy-c', sessionDir, dataDir);
    await first.restore();
    const firstRead = first.workspaces;
    // Second read on the same instance, then a fresh resume of the same file.
    expect(first.workspaces).toEqual(firstRead);
    const second = SessionManager.resume('legacy-c', sessionDir, dataDir);
    await second.restore();
    expect(second.workspaces).toEqual(firstRead);
  });

  it('keeps an existing multi-workspace list intact across writes', async () => {
    const sessionDir = writeLegacySession(dataDir, 'legacy-d', workspaceDir);
    const other = mkdtempSync(join(tmpdir(), 'wayang-ws-other-'));
    try {
      const existing = [
        { path: normalizeWorkspacePath(workspaceDir), slug: workspaceSlugFromPath(normalizeWorkspacePath(workspaceDir)) },
        { path: normalizeWorkspacePath(other), slug: workspaceSlugFromPath(normalizeWorkspacePath(other)) },
      ];
      const meta = readMeta(sessionDir);
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({ ...meta, workspaces: existing }));

      const mgr = SessionManager.resume('legacy-d', sessionDir, dataDir);
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
    const sessionDir = writeLegacySession(dataDir, 'legacy-e', workspaceDir);
    const mgr = SessionManager.resume('legacy-e', sessionDir, dataDir);
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

  it('canonicalizes a symlinked/trailing-slash legacy workspace when synthesizing', async () => {
    const alias = join(dataDir, 'alias-repo');
    symlinkSync(workspaceDir, alias);
    // Legacy meta stores the symlink spelling with a trailing slash.
    const sessionDir = writeLegacySession(dataDir, 'legacy-symlink', `${alias}/`);

    const mgr = SessionManager.resume('legacy-symlink', sessionDir, dataDir);
    await mgr.restore();

    expect(mgr.workspaces).toHaveLength(1);
    // Restore-path normalization: the synthesized ref carries the canonical path.
    expect(mgr.workspaces[0].path).toBe(normalizeWorkspacePath(workspaceDir));
    // Legacy single field is preserved verbatim (readers normalize on the fly).
    expect(mgr.workspace).toBe(`${alias}/`);
  });

  it('reads path and slug without throwing when the workspace dir is gone', async () => {
    const missing = join(dataDir, 'gone', 'my-repo');
    const sessionDir = writeLegacySession(dataDir, 'legacy-f', missing);

    const mgr = SessionManager.resume('legacy-f', sessionDir, dataDir);
    await mgr.restore();

    expect(mgr.workspaces).toHaveLength(1);
    // path.resolve fallback keeps it absolute; the slug needs no directory.
    expect(mgr.workspaces[0].path).toBe(normalizeWorkspacePath(missing));
    expect(mgr.workspaces[0].slug).toBe('my-repo');
    // Reading is still a pure read: the legacy file was not rewritten.
    expect(readMeta(sessionDir).workspaces).toBeUndefined();
  });
});

describe('SessionManager — addWorkspace (runtime accumulation)', () => {
  let dataDir: string;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wayang-accum-unit-'));
    dirA = mkdtempSync(join(tmpdir(), 'wayang-accum-unit-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'wayang-accum-unit-b-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  function refOf(dir: string) {
    const canonical = normalizeWorkspacePath(dir);
    return { path: canonical, slug: workspaceSlugFromPath(canonical) };
  }

  it('persists a new workspace synchronously through the normal meta write', () => {
    const mgr = SessionManager.create(dataDir, dirA);
    // Nothing on disk yet beyond the seeded workspaces array.
    expect(readMeta(mgr.sessionDir).workspaces).toHaveLength(1);

    const appended = mgr.addWorkspace(refOf(dirB));

    expect(appended).toBe(true);
    // The write happened immediately (whole-meta snapshot), no later flush.
    const persisted = readMeta(mgr.sessionDir);
    expect(persisted.workspaces).toHaveLength(2);
    expect(persisted.workspaces.map((w: { path: string }) => w.path)).toEqual([
      normalizeWorkspacePath(dirA),
      normalizeWorkspacePath(dirB),
    ]);
    // The startup singleton is untouched.
    expect(persisted.workspace).toBe(dirA);
  });

  it('is idempotent by canonical path (no second write, no duplicate)', () => {
    const mgr = SessionManager.create(dataDir, dirA);
    expect(mgr.addWorkspace(refOf(dirB))).toBe(true);
    expect(mgr.addWorkspace(refOf(dirB))).toBe(false);
    expect(mgr.workspaces.filter((w) => w.path === normalizeWorkspacePath(dirB))).toHaveLength(1);
    expect(readMeta(mgr.sessionDir).workspaces).toHaveLength(2);
  });

  it('deduplicates a non-canonical spelling of the same directory', () => {
    const mgr = SessionManager.create(dataDir, dirA);
    const alias = join(dataDir, 'alias-b');
    symlinkSync(dirB, alias);
    mgr.addWorkspace(refOf(dirB));
    // Same directory through a symlink: canonicalized away, no duplicate.
    expect(mgr.addWorkspace({ path: alias, slug: 'alias-b' })).toBe(false);
    expect(mgr.workspaces).toHaveLength(2);
  });

  it('keeps an existing slug even when re-declared with a different one', () => {
    const mgr = SessionManager.create(dataDir, dirA);
    const canonicalB = normalizeWorkspacePath(dirB);
    mgr.addWorkspace({ path: canonicalB, slug: 'stable-b' });
    mgr.addWorkspace({ path: canonicalB, slug: 'changed-b' });
    const entry = mgr.workspaces.find((w) => w.path === canonicalB);
    expect(entry?.slug).toBe('stable-b');
  });

  it('accumulates onto a legacy session, persisting the synthesized startup entry too', async () => {
    const sessionDir = writeLegacySession(dataDir, 'legacy-accum', dirA);
    const mgr = SessionManager.resume('legacy-accum', sessionDir, dataDir);
    await mgr.restore();
    // Synthesized in memory only so far.
    expect(readMeta(sessionDir).workspaces).toBeUndefined();

    mgr.addWorkspace(refOf(dirB));

    const persisted = readMeta(sessionDir);
    expect(persisted.workspaces.map((w: { path: string }) => w.path)).toEqual([
      normalizeWorkspacePath(dirA),
      normalizeWorkspacePath(dirB),
    ]);
  });
});

describe('SessionManager — startupWorkspace', () => {
  let dataDir: string;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wayang-startup-ws-'));
    dirA = mkdtempSync(join(tmpdir(), 'wayang-startup-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'wayang-startup-b-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  function ref(dir: string) {
    const canonical = normalizeWorkspacePath(dir);
    return { path: canonical, slug: workspaceSlugFromPath(canonical) };
  }

  it('picks the entry matching meta.workspace, not element 0', async () => {
    // A accumulated first, but the session was started in B.
    const sessionDir = writeMultiWorkspaceSession(dataDir, 'multi-b', dirB, [ref(dirA), ref(dirB)]);
    const mgr = SessionManager.resume('multi-b', sessionDir, dataDir);
    await mgr.restore();

    expect(mgr.workspaces[0].path).toBe(normalizeWorkspacePath(dirA));
    expect(mgr.startupWorkspace).toEqual(ref(dirB));
  });

  it('matches through a non-canonical spelling of meta.workspace', async () => {
    const alias = join(dataDir, 'alias-startup');
    symlinkSync(dirB, alias);
    const sessionDir = writeMultiWorkspaceSession(dataDir, 'multi-alias', `${alias}/`, [ref(dirA), ref(dirB)]);
    const mgr = SessionManager.resume('multi-alias', sessionDir, dataDir);
    await mgr.restore();

    expect(mgr.startupWorkspace).toEqual(ref(dirB));
  });

  it('falls back to workspaces[0] when meta.workspace matches no entry', async () => {
    // The startup directory was renamed away: nothing in the array matches it.
    const renamedAway = join(dataDir, 'renamed-away');
    const sessionDir = writeMultiWorkspaceSession(dataDir, 'multi-gone', renamedAway, [ref(dirA), ref(dirB)]);
    const mgr = SessionManager.resume('multi-gone', sessionDir, dataDir);
    await mgr.restore();

    expect(mgr.startupWorkspace).toEqual(ref(dirA));
  });

  it('returns undefined when the session has no workspace identity', async () => {
    const sessionDir = join(dataDir, 'sessions', 'no-ws');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({ sessionId: 'no-ws', workspace: '', firstInput: null, createdAt: 1000, lastActiveAt: 2000 }),
    );
    const mgr = SessionManager.resume('no-ws', sessionDir, dataDir);
    await mgr.restore();

    expect(mgr.workspaces).toEqual([]);
    expect(mgr.startupWorkspace).toBeUndefined();
  });
});
