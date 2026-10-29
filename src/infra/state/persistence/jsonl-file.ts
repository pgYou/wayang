/**
 * Append-only JSONL helper.
 *
 * Two guarantees that must not be conflated:
 *  - write(): appends ONE entry. History is immutable — entries are never
 *    rewritten. A torn last line is tolerated on read.
 *  - read():  returns full history, skipping unparsable lines instead of
 *    failing the whole file.
 *
 * The in-memory array a state class keeps for an append-mode field is a
 * WINDOW, not the full history. That is why write() takes the appended entry
 * rather than the array: replacing the file with the window would silently
 * truncate history.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IPersistenceHelper, PersistContext } from './types';

export class JSONLFileHelper<T = unknown> implements IPersistenceHelper<T[]> {
  readonly mode = 'append' as const;

  constructor(private filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  write(change: PersistContext<T[]>): void {
    // Append-mode fields only grow by one entry at a time. set/update/remove on
    // an append-mode field mutate the in-memory window only; they must never
    // rewrite the file, or history written by earlier appends would be lost.
    if (change.op !== 'append') return;
    if (change.entry === undefined) return;
    this.append(change.entry);
  }

  /** Append a single entry to history. */
  append(entry: unknown): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
  }

  read(): T[] {
    if (!existsSync(this.filePath)) return [];
    const text = readFileSync(this.filePath, 'utf-8');
    if (text.length === 0) return [];

    const entries: T[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // Torn or corrupt line (typical case: crash mid-append). Skip it —
        // one bad line must not make the whole history unreadable.
        continue;
      }
    }
    return entries;
  }

  readFromEnd(stopCondition: (entry: any) => boolean): any[] {
    const all = this.read();
    const result: any[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      if (stopCondition(all[i])) break;
      result.unshift(all[i]);
    }
    return result;
  }

  clear(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, '');
  }
}
