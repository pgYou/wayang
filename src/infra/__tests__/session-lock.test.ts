import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STALE_MS,
  SESSION_LOCKED_MARKER,
  SESSION_OWNER_FILE,
  SessionLock,
  SessionLockedError,
  formatSessionLockHint,
} from '@/infra/session-lock';
import type { SessionOwner } from '@/infra/session-lock';

/** A pid that is guaranteed not to exist: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  const pid = child.pid;
  if (!pid) throw new Error('failed to spawn a probe process');
  return pid;
}

describe('SessionLock', () => {
  let sessionDir: string;
  let lock: SessionLock | null;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'wayang-session-lock-'));
    lock = null;
  });

  afterEach(() => {
    lock?.release();
    lock = null;
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const ownerFile = () => join(sessionDir, SESSION_OWNER_FILE);
  const readOwner = (): SessionOwner => JSON.parse(readFileSync(ownerFile(), 'utf-8')) as SessionOwner;
  const writeOwner = (owner: Partial<SessionOwner>) => {
    const full: SessionOwner = {
      pid: process.pid,
      hostname: hostname(),
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      token: 'existing-token',
      ...owner,
    };
    writeFileSync(ownerFile(), `${JSON.stringify(full, null, 2)}\n`);
    return full;
  };

  describe('acquire', () => {
    it('claims a free session and writes a well-formed owner document', () => {
      lock = new SessionLock(sessionDir);
      const before = Date.now();
      const { owner, staleTakeover } = lock.acquire();

      expect(staleTakeover).toBe(false);
      expect(lock.held).toBe(true);

      const onDisk = readOwner();
      expect(onDisk).toEqual(owner);
      expect(onDisk.pid).toBe(process.pid);
      expect(onDisk.hostname).toBe(hostname());
      expect(onDisk.token).toBeTruthy();
      expect(onDisk.startedAt).toBeGreaterThanOrEqual(before);
      expect(onDisk.heartbeatAt).toBe(onDisk.startedAt);
    });

    it('uses the documented heartbeat/stale defaults', () => {
      expect(DEFAULT_HEARTBEAT_MS).toBe(20_000);
      expect(DEFAULT_STALE_MS).toBe(60_000);
    });

    it('rejects a second acquire while the holder is alive with a fresh heartbeat', () => {
      lock = new SessionLock(sessionDir);
      const first = lock.acquire();
      const heldToken = readOwner().token;

      const second = new SessionLock(sessionDir);
      let thrown: unknown;
      try {
        second.acquire();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SessionLockedError);
      const err = thrown as SessionLockedError;
      expect(err.message).toContain(SESSION_LOCKED_MARKER);
      expect(err.message).toContain(`pid ${process.pid}`);
      expect(err.message).toContain(sessionDir);
      expect(err.holder.token).toBe(first.owner.token);
      expect(err.sessionDir).toBe(sessionDir);

      // The failed attempt must not have touched the holder's document.
      expect(readOwner().token).toBe(heldToken);
      expect(second.held).toBe(false);
    });

    it('reports actionable next steps in the user-facing hint', () => {
      lock = new SessionLock(sessionDir);
      lock.acquire();

      const second = new SessionLock(sessionDir);
      let thrown: unknown;
      try {
        second.acquire();
      } catch (err) {
        thrown = err;
      }

      const hint = formatSessionLockHint(thrown as SessionLockedError);
      expect(hint).toContain(SESSION_LOCKED_MARKER);
      expect(hint).toContain('--resume');
      expect(hint).toContain('--fresh');
    });

    it('takes over a stale lock when the heartbeat expired', () => {
      const stale = writeOwner({ heartbeatAt: Date.now() - 120_000 });

      lock = new SessionLock(sessionDir);
      const result = lock.acquire();

      expect(result.staleTakeover).toBe(true);
      expect(result.owner.token).not.toBe(stale.token);
      expect(readOwner().token).toBe(result.owner.token);
      expect(readOwner().heartbeatAt).toBeGreaterThan(stale.heartbeatAt);
    });

    it('takes over a lock held by a pid that no longer exists', () => {
      const dead = writeOwner({ pid: deadPid(), heartbeatAt: Date.now() });

      lock = new SessionLock(sessionDir);
      const result = lock.acquire();

      expect(result.staleTakeover).toBe(true);
      expect(readOwner().pid).toBe(process.pid);
      expect(readOwner().token).not.toBe(dead.token);
    });

    it('takes over a lock on another host only once its heartbeat expires', () => {
      // A remote owner cannot be probed by pid, so a fresh heartbeat wins.
      writeOwner({ hostname: 'some-other-host', heartbeatAt: Date.now() });
      const blocked = new SessionLock(sessionDir);
      expect(() => blocked.acquire()).toThrow(SessionLockedError);

      // ...but an expired heartbeat makes it a zombie even across hosts.
      writeOwner({ hostname: 'some-other-host', heartbeatAt: Date.now() - 120_000 });
      lock = new SessionLock(sessionDir);
      expect(lock.acquire().staleTakeover).toBe(true);
    });

    it('treats a corrupt owner document as stale', () => {
      writeFileSync(ownerFile(), '{ not json');

      lock = new SessionLock(sessionDir);
      const result = lock.acquire();

      expect(result.staleTakeover).toBe(true);
      expect(readOwner().token).toBe(result.owner.token);
    });

    it('rejects a second acquire on the same instance', () => {
      lock = new SessionLock(sessionDir);
      lock.acquire();
      expect(() => lock!.acquire()).toThrow(/already held/);
    });
  });

  describe('heartbeat', () => {
    it('advances heartbeatAt on the timer', () => {
      vi.useFakeTimers();
      try {
        lock = new SessionLock(sessionDir, { heartbeatMs: 1_000, staleMs: 60_000 });
        const { owner } = lock.acquire();
        expect(readOwner().heartbeatAt).toBe(owner.heartbeatAt);

        vi.advanceTimersByTime(3_000);

        const onDisk = readOwner();
        expect(onDisk.heartbeatAt).toBeGreaterThan(owner.heartbeatAt);
        expect(onDisk.heartbeatAt).toBe(Date.now());
        // Identity is preserved across heartbeats — only the timestamp moves.
        expect(onDisk.token).toBe(owner.token);
        expect(onDisk.pid).toBe(owner.pid);
        expect(onDisk.startedAt).toBe(owner.startedAt);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops refreshing after a takeover and drops ownership', () => {
      vi.useFakeTimers();
      try {
        lock = new SessionLock(sessionDir, { heartbeatMs: 1_000, staleMs: 60_000 });
        lock.acquire();

        // Simulate a takeover: another process replaced the document.
        const usurper = writeOwner({ token: 'usurper-token', heartbeatAt: Date.now() });
        vi.advanceTimersByTime(3_000);

        expect(lock.held).toBe(false);
        expect(readOwner().token).toBe(usurper.token);
        expect(readOwner().heartbeatAt).toBe(usurper.heartbeatAt);

        // A later release must not delete the usurper's lock.
        lock.release();
        expect(existsSync(ownerFile())).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('release', () => {
    it('removes the lock file', () => {
      lock = new SessionLock(sessionDir);
      lock.acquire();
      expect(existsSync(ownerFile())).toBe(true);

      lock.release();

      expect(existsSync(ownerFile())).toBe(false);
      expect(lock.held).toBe(false);
    });

    it('is idempotent', () => {
      lock = new SessionLock(sessionDir);
      lock.acquire();

      expect(() => lock!.release()).not.toThrow();
      expect(() => lock!.release()).not.toThrow();
      expect(() => lock!.release()).not.toThrow();
      expect(existsSync(ownerFile())).toBe(false);
    });

    it('is a no-op when never acquired', () => {
      lock = new SessionLock(sessionDir);
      expect(() => lock!.release()).not.toThrow();
      expect(existsSync(ownerFile())).toBe(false);
    });

    it('lets another instance acquire after release', () => {
      const first = new SessionLock(sessionDir);
      first.acquire();
      first.release();

      lock = new SessionLock(sessionDir);
      const result = lock.acquire();
      expect(result.staleTakeover).toBe(false);
      expect(readOwner().token).toBe(result.owner.token);
    });

    it('does not delete a lock another process has taken over', () => {
      lock = new SessionLock(sessionDir);
      lock.acquire();

      const usurper = writeOwner({ token: 'usurper-token', heartbeatAt: Date.now() });
      lock.release();

      expect(existsSync(ownerFile())).toBe(true);
      expect(readOwner().token).toBe(usurper.token);
    });
  });
});
