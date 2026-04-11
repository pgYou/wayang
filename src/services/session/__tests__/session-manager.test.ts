import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSessions, getSession } from '@/infra/session-helpers';
import { SessionManager } from '@/services/session/session-manager';

/** Read meta.json from disk for assertion. */
function readMeta(sessionDir: string) {
  return JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8'));
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
