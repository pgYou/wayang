/**
 * Size-rotating file sink for the session log (issue #52).
 *
 * One Writable that appends every chunk (one pretty-printed line) to the
 * active file and, once the file is at budget, shifts the rotated set before
 * the next write lands:
 *
 *   wayang.log → wayang.log.1 → wayang.log.2 → … (oldest dropped)
 *
 * Deliberate simplifications (agreed in #52 review — rotation is a fallback,
 * not a feature):
 *  - Writes are synchronous `appendFileSync`. Every accepted line is on disk
 *    when `_write` returns, so `close()` has nothing to flush and a crash
 *    loses at most the lines still buffered upstream in pino-pretty.
 *  - No timers, no compression: rotation is checked per write only. A single
 *    chunk larger than the budget is still written whole (a log line is never
 *    split); the following write then rotates.
 *  - Rotation or append failures never break logging: the sink keeps going
 *    (dropping the line on append failure, retrying the shift on the next
 *    write) — a broken logger must not take the process down.
 */

import { Writable } from 'node:stream';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Rotation policy for {@link RotatingFileSink}. */
export interface RotationOptions {
  /** Max bytes the active file may reach; the next write past it rotates. */
  maxFileSizeBytes: number;
  /** How many rotated files (`.1` … `.N`) to retain next to the active one. */
  maxFiles: number;
}

export class RotatingFileSink extends Writable {
  /** Bytes already in the active file (seeded from disk, grown per append). */
  private bytesWritten: number;

  constructor(
    private readonly filePath: string,
    private readonly opts: RotationOptions,
  ) {
    super({ autoDestroy: true });
    // Resume accounting from an existing file: a fresh process appending to a
    // session log that is already at budget must still rotate, not restart
    // the counter at zero and overshoot by another budget.
    this.bytesWritten = existsSync(filePath) ? statSync(filePath).size : 0;
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    try {
      this.append(text);
    } catch {
      // Disk full / vanished directory: drop the line, keep the process up.
    }
    cb();
  }

  private append(text: string): void {
    const size = Buffer.byteLength(text, 'utf8');
    // Rotate only when the file already holds bytes — the first write into an
    // empty file always goes through, whatever its size.
    if (this.bytesWritten > 0 && this.bytesWritten + size > this.opts.maxFileSizeBytes) {
      this.rotate();
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, text, 'utf8');
    this.bytesWritten += size;
  }

  /** Shift `path.(N-1)→path.N, …, path→path.1`, dropping the old `path.N`. */
  private rotate(): void {
    try {
      rmSync(`${this.filePath}.${this.opts.maxFiles}`, { force: true });
      for (let i = this.opts.maxFiles - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        if (existsSync(from)) renameSync(from, `${this.filePath}.${i + 1}`);
      }
      renameSync(this.filePath, `${this.filePath}.1`);
      this.bytesWritten = 0;
    } catch {
      // Shift failed midway (permissions, vanished dir): keep appending to
      // the current file. bytesWritten stays over budget, so the next write
      // retries the shift — logging never stops over a rename.
    }
  }
}
