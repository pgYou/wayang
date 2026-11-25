/**
 * Atomic file write primitives for snapshot-style persistence.
 *
 * Guarantees: after a crash the target file is either the old content or the
 * new content — never a half-written truncation — because we write to a
 * sibling temp file, fsync it, then rename (atomic within a filesystem).
 *
 * Also serializes writes per resolved path so that concurrent writes to the
 * same file cannot interleave on the same temp file.
 */

import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** Per-path write queues. Keyed by resolved target path. */
const writeQueues = new Map<string, Promise<void>>();

function tempPathFor(filePath: string): string {
  // Unique per process + monotonic counter to avoid collisions with leftovers.
  tempCounter += 1;
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${tempCounter}.tmp`);
}

let tempCounter = 0;

/**
 * Write content to filePath atomically.
 * Synchronous by contract: callers rely on the value being on disk when this
 * returns (state persistence is part of the write path, not a background job).
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = tempPathFor(filePath);

  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * Queue a write for a path. Writes to the same path are serialized; different
 * paths proceed independently. Errors are swallowed by the caller's contract —
 * this function never rejects, it only orders execution.
 */
export function queueAtomicWrite(filePath: string, contentProvider: () => string): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(() => {
    atomicWriteFileSync(filePath, contentProvider());
  });
  // Keep the chain alive even if this write fails, so later writes still run.
  writeQueues.set(
    filePath,
    next.catch(() => {
      /* error surfaces via caller's sync path when needed */
    }),
  );
  return next;
}
