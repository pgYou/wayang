/**
 * BlockingRequestMap — the shared "blocking request" spine.
 *
 * Pattern extracted from the permission flow (wrapWithPermissionMiddleware,
 * ClaudeCodeWorker.permissionHandler) so worker inquiries reuse the same
 * semantics instead of a drifting copy: id-keyed pending promise, timeout
 * fallback, cleanup-all on abort. One registry per worker run.
 *
 * Semantics:
 * - `wait(id, timeoutMs, makeTimeoutValue)` — park a promise under `id`.
 *   On timeout, resolves with `makeTimeoutValue()` — the factory runs
 *   side effects first (e.g. emitting an inquiry_timeout signal).
 * - `resolve(id, value)` — settle one promise. Returns false if the id is
 *   unknown (already settled, timed out, or cleaned up).
 * - `cleanupAll(makeValue)` — settle every pending promise (worker abort).
 * - Timers are unref'd so they never hold the process open.
 */

interface PendingEntry<T> {
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BlockingRequestMap<T> {
  private pending = new Map<string, PendingEntry<T>>();

  /** Number of requests parked right now. */
  get size(): number {
    return this.pending.size;
  }

  wait(id: string, timeoutMs: number, makeTimeoutValue: () => T): Promise<T> {
    // A duplicate id would silently corrupt both waiters (the second timer
    // settles the first promise and the map entry gets crossed). Ids are
    // caller-generated — treat a collision as a programming error.
    if (this.pending.has(id)) {
      throw new Error(`BlockingRequestMap: duplicate wait id "${id}"`);
    }
    return new Promise<T>((resolve) => {
      const settle = (value: T) => {
        this.pending.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => {
        // Delete BEFORE the side-effect factory runs, so factory code
        // (e.g. deferred-interrupt delivery) sees this request as gone.
        this.pending.delete(id);
        resolve(makeTimeoutValue());
      }, timeoutMs);
      // Never hold the process open for a pending request.
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
      this.pending.set(id, { resolve: settle, timer });
    });
  }

  /** Settle one request. False when the id is unknown (settled/timed out/cleaned). */
  resolve(id: string, value: T): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(value);
    return true;
  }

  /** Settle everything (worker aborted / shut down). */
  cleanupAll(makeValue: (id: string) => T): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(makeValue(id));
    }
  }
}
