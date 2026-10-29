/**
 * Snapshot persistence helper.
 *
 * Semantics: the file holds the field's complete current value. Every write
 * replaces it wholesale.
 *
 * Writes are atomic (temp file + fsync + rename) so a crash leaves either the
 * old file or the new file, never a truncated one. This matters because a
 * snapshot is the ONLY source of truth for its field — there is no log to
 * replay as a fallback.
 *
 * Read failures are surfaced, not swallowed: a corrupt snapshot must not be
 * silently treated as "empty state", otherwise the caller would overwrite good
 * intent with a blank value. On corruption we move the bad file aside (so it
 * can be inspected) and throw.
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  copyFileSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { IPersistenceHelper, PersistContext } from './types';

let tempSeq = 0;

export class JSONFileHelper<T = unknown> implements IPersistenceHelper<T> {
  readonly mode = 'save' as const;

  constructor(private filePath: string) {}

  /** Absolute path of the backing file. */
  get path(): string {
    return this.filePath;
  }

  /** Whether the backing file exists, regardless of parseability. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  write(change: PersistContext<T>): void {
    this.writeValue(change.value);
  }

  /** Write an arbitrary value atomically. Used by migration paths. */
  writeValue(value: unknown): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.tempPath();
    let fd: number | null = null;
    try {
      fd = openSync(tmp, 'w');
      writeSync(fd, JSON.stringify(value, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.filePath);
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

  readonly(): T | null {
    if (!existsSync(this.filePath)) return null;    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read snapshot "${this.filePath}": ${(err as Error).message}`,
      );
    }
    if (raw.trim().length === 0) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      const quarantine = this.quarantineCorrupt();
      throw new Error(
        `Corrupt snapshot "${this.filePath}" (${(err as Error).message}). `
        + `The damaged file was moved to "${quarantine}". Refusing to treat it as empty state.`,
      );
    }
  }

  read(): unknown {
    return this.readonly();
  }

  /**
   * Read without throwing on corruption — returns null instead.
   * Only for callers that can tolerate absence (e.g. optional side files).
   * State-critical reads must use readonly()/read().
   */
  raw(): T | null {
    if (!existsSync(this.filePath)) return null;
    const text = readFileSync(this.filePath, 'utf-8');
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  clear(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.writeValue(null);
  }

  private tempPath(): string {
    tempSeq += 1;
    return join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.${tempSeq}.tmp`);
  }

  private quarantineCorrupt(): string {
    const target = `${this.filePath}.corrupt.${Date.now()}`;
    try {
      copyFileSync(this.filePath, target);
    } catch {
      /* best effort — the original stays in place */
    }
    return target;
  }
}
