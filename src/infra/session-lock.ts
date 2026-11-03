/**
 * SessionLock — per-session ownership lock.
 *
 * Two wayang processes that resume the same session would append to the same
 * `conversation.jsonl` at the same time, interleaving unrelated turns and
 * corrupting the transcript's parent/child lineage. This lock keeps a session
 * single-owner while deliberately NOT restricting the home dir: different
 * sessions are expected to run in parallel, so the lock is scoped to one
 * session directory.
 *
 * Protocol — `<sessionDir>/.owner.json`:
 *
 *   { pid, hostname, startedAt, heartbeatAt, token }
 *
 * - `acquire()` writes the file atomically (unique temp file + rename, then a
 *   read-back that settles create races) and starts a heartbeat timer.
 * - The holder refreshes `heartbeatAt` every `heartbeatMs` (20s, unref'd so it
 *   never keeps the process alive on its own).
 * - `release()` deletes the file, but only if the token on disk is still ours;
 *   it is idempotent (repeat calls are no-ops, never throws).
 *
 * Zombie rules (`isStale`):
 *
 * - Same host: the lock is stale when the heartbeat is older than `staleMs`
 *   (60s) OR when the pid no longer exists (`process.kill(pid, 0)` →
 *   ESRCH). A dead pid is conclusive even with a fresh heartbeat — a process
 *   killed mid-interval stops refreshing before the heartbeat expires.
 * - Different host: the pid cannot be probed, so the heartbeat age is the only
 *   evidence; the lock is stale only once it expires.
 * - An unreadable/corrupt lock cannot describe a live owner and is treated as
 *   stale as well.
 *
 * A stale lock is taken over and the result reports `staleTakeover: true` so
 * the caller can tell the user that a previous crash left the session behind.
 * Abnormal exits (SIGKILL, power loss) need no bookkeeping: the heartbeat
 * expires and the next process takes the lock over.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Lock file name inside a session directory. */
export const SESSION_OWNER_FILE = '.owner.json';

/** A heartbeat older than this is evidence that the owner is gone. */
export const DEFAULT_STALE_MS = 60_000;

/** How often a holder refreshes `heartbeatAt` while it runs. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * Grep-able marker at the start of every lock-conflict message. The server
 * prints it on stderr when it refuses to boot; the client process scans the
 * child's stderr tail for it to turn "server exited" into an actionable hint
 * (a cross-process marker is needed because the Error object does not survive
 * the process boundary).
 */
export const SESSION_LOCKED_MARKER = '[SESSION_LOCKED]';

/** Identity of the process that owns a session directory. */
export interface SessionOwner {
  pid: number;
  hostname: string;
  /** When the owner took the lock (epoch ms). */
  startedAt: number;
  /** When the owner last proved it is alive (epoch ms). */
  heartbeatAt: number;
  /** Random per-acquisition id: distinguishes a retaken lock from a stale file. */
  token: string;
}

/** Thrown when another live process owns the session being opened. */
export class SessionLockedError extends Error {
  readonly holder: SessionOwner;
  readonly sessionDir: string;

  constructor(holder: SessionOwner, sessionDir: string) {
    super(
      `${SESSION_LOCKED_MARKER} Session "${sessionDir}" is already in use by another wayang process `
        + `(pid ${holder.pid} on ${holder.hostname}, holding since ${new Date(holder.startedAt).toISOString()})`,
    );
    this.name = 'SessionLockedError';
    this.holder = holder;
    this.sessionDir = sessionDir;
  }
}

/**
 * User-facing explanation with next steps for a lock conflict. Shared by both
 * processes: the server prints it on stderr, the client re-prints the same
 * block instead of a bare "server exited" message.
 */
export function formatSessionLockHint(err: SessionLockedError): string {
  return [
    err.message,
    'That process may still be working in this session; wait for it to finish and retry.',
    'To use a different session instead: wayang --resume',
    'To start a new session instead: wayang --fresh',
  ].join('\n');
}

/** Result of a successful `SessionLock.acquire()`. */
export interface AcquireResult {
  /** The identity this process wrote into the lock file. */
  owner: SessionOwner;
  /** True when a dead/corrupt previous lock had to be replaced. */
  staleTakeover: boolean;
}

export interface SessionLockOptions {
  /** Heartbeat age after which the owner is presumed gone. Default 60s. */
  staleMs?: number;
  /** Heartbeat refresh interval while holding. Default 20s. */
  heartbeatMs?: number;
  /** Hostname to stamp. Defaults to `os.hostname()`; injectable for tests. */
  hostname?: string;
  /** Pid to stamp. Defaults to `process.pid`; injectable for tests. */
  pid?: number;
  /** Clock. Defaults to `Date.now`; injectable for tests. */
  now?: () => number;
}

/** What we found on disk before/after a claim. */
type OwnerRead =
  | { kind: 'missing' }
  /** Present but not a well-formed owner document — cannot describe a live owner. */
  | { kind: 'unreadable' }
  | { kind: 'owner'; owner: SessionOwner };

export class SessionLock {
  readonly sessionDir: string;
  readonly ownerFile: string;
  private readonly staleMs: number;
  private readonly heartbeatMs: number;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly now: () => number;
  /** Currently held identity, or null when not holding. */
  private owner: SessionOwner | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(sessionDir: string, options: SessionLockOptions = {}) {
    this.sessionDir = sessionDir;
    this.ownerFile = path.join(sessionDir, SESSION_OWNER_FILE);
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.hostname = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
  }

  /** Whether this instance currently holds the lock. */
  get held(): boolean {
    return this.owner !== null;
  }

  /** Copy of the held identity (null when not holding). */
  get ownerInfo(): SessionOwner | null {
    return this.owner ? { ...this.owner } : null;
  }

  /**
   * Take ownership of the session directory.
   *
   * @throws SessionLockedError when a live process already owns it.
   * @throws Error when the file system refuses the write for another reason.
   */
  acquire(): AcquireResult {
    if (this.owner) {
      throw new Error(`SessionLock for ${this.sessionDir} is already held by this instance`);
    }

    const existing = this.readOwner();
    let staleTakeover = false;
    if (existing.kind === 'owner') {
      if (!this.isStale(existing.owner)) {
        throw new SessionLockedError(existing.owner, this.sessionDir);
      }
      staleTakeover = true;
    } else if (existing.kind === 'unreadable') {
      // A corrupt document cannot prove a live owner (an owner always writes
      // atomically, so a torn file means the write itself failed); replace it.
      staleTakeover = true;
    }

    const owner = this.claim();
    this.owner = owner;
    this.startHeartbeat();
    return { owner: { ...owner }, staleTakeover };
  }

  /**
   * Refresh `heartbeatAt` on disk. Called by the heartbeat timer; exposed so
   * callers and tests can tick it explicitly.
   *
   * If the file on disk no longer carries our token, our lease was taken over
   * (e.g. this process was suspended past `staleMs`): stop writing and drop
   * ownership instead of clobbering the new owner's heartbeat.
   */
  heartbeat(): void {
    const owner = this.owner;
    if (!owner) return;

    const current = this.readOwner();
    if (current.kind !== 'owner' || current.owner.token !== owner.token) {
      this.owner = null;
      this.stopHeartbeat();
      return;
    }

    const next: SessionOwner = { ...owner, heartbeatAt: this.now() };
    this.writeOwner(next);
    this.owner = next;
  }

  /**
   * Drop the lock. Idempotent: safe to call repeatedly, and safe to call
   * without ever having acquired (a no-op).
   *
   * The file is deleted only when the token on disk is still ours, so a release
   * delayed past a takeover cannot delete the new owner's lock.
   */
  release(): void {
    this.stopHeartbeat();
    const owner = this.owner;
    if (!owner) return;
    this.owner = null;

    const current = this.readOwner();
    if (current.kind !== 'owner' || current.owner.token !== owner.token) return;

    try {
      fs.unlinkSync(this.ownerFile);
    } catch (err) {
      // Someone else removed it first — that is a successful release.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  // --- Internals ---

  /**
   * Write our owner document atomically and confirm it survived any concurrent
   * claimant. Two processes can both pass the "does not exist" check, so after
   * the rename each reads the file back: whoever reads a foreign token lost.
   */
  private claim(): SessionOwner {
    const at = this.now();
    const owner: SessionOwner = {
      pid: this.pid,
      hostname: this.hostname,
      startedAt: at,
      heartbeatAt: at,
      token: randomUUID(),
    };

    this.writeOwner(owner);

    const readback = this.readOwner();
    if (readback.kind !== 'owner' || readback.owner.token !== owner.token) {
      if (readback.kind === 'owner') {
        throw new SessionLockedError(readback.owner, this.sessionDir);
      }
      throw new Error(`Failed to claim session lock at ${this.ownerFile}`);
    }
    return owner;
  }

  /** Temp-file + rename, so readers never observe a partially written document. */
  private writeOwner(owner: SessionOwner): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });
    const tmp = path.join(this.sessionDir, `${SESSION_OWNER_FILE}.${owner.pid}.${randomUUID()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(owner, null, 2)}\n`, 'utf-8');
    try {
      fs.renameSync(tmp, this.ownerFile);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Nothing to do: the rename failure is the error worth reporting.
      }
      throw err;
    }
  }

  private readOwner(): OwnerRead {
    let raw: string;
    try {
      raw = fs.readFileSync(this.ownerFile, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: 'unreadable' };
    }
    if (!isSessionOwner(parsed)) return { kind: 'unreadable' };
    return { kind: 'owner', owner: parsed };
  }

  /** See the zombie rules in the module docstring. */
  private isStale(owner: SessionOwner): boolean {
    const heartbeatFresh = this.now() - owner.heartbeatAt < this.staleMs;

    if (owner.hostname !== this.hostname) {
      // A remote pid cannot be probed, so heartbeat age is all we have.
      return !heartbeatFresh;
    }
    // Same host: a dead pid is conclusive even when the heartbeat looks fresh.
    return !heartbeatFresh || !isProcessAlive(owner.pid);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    // The heartbeat must never be the reason a process stays alive.
    timer.unref?.();
    this.timer = timer;
  }

  private stopHeartbeat(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

function isSessionOwner(value: unknown): value is SessionOwner {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0
    && typeof v.hostname === 'string' && v.hostname.length > 0
    && typeof v.startedAt === 'number' && Number.isFinite(v.startedAt)
    && typeof v.heartbeatAt === 'number' && Number.isFinite(v.heartbeatAt)
    && typeof v.token === 'string' && v.token.length > 0;
}

/** `process.kill(pid, 0)` liveness probe; EPERM means "exists, other user". */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
