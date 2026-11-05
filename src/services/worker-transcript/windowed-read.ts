// Windowed (tail) transcript read: bounded byte windows from the end of the file.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ConversationEntry } from '@/types/index';
import { isValidWorkerId, workerTranscriptPath } from './transcript-file';

/** Hard cap on bytes a transcript read may pull from the tail of the file (2 MB). */
export const MAX_TRANSCRIPT_WINDOW_BYTES = 2 * 1024 * 1024;

/** Smallest tail window a read starts from. */
const MIN_WINDOW_BYTES = 64 * 1024;

/** Rough per-entry byte estimate used to size the first read window. */
const ENTRY_BYTES_ESTIMATE = 1024;

export interface TranscriptReadOptions {
  /**
   * How many entries (after `matches`) the caller needs. The window grows —
   * doubling, up to the hard byte cap — until that many matched entries are
   * parsed, the start of the file is reached, or the cap hits. Default: grow
   * all the way to the start of the file (or the cap).
   */
  need?: number;
  /** Entry predicate the growth targets — mirror of the caller's type filter. */
  matches?: (entry: ConversationEntry) => boolean;
}

export interface WorkerTranscriptWindow {
  /** Complete entries parsed from the tail window, oldest → newest. */
  entries: ConversationEntry[];
  /** The file's last line is mid-write (torn JSON): more entries are coming. */
  incompleteTail: boolean;
  /** The window hit its byte cap: older entries exist on disk but were not read. */
  windowTruncated: boolean;
  /** The window reaches the start of the file — `entries` is the full history. */
  coversFile: boolean;
}

/**
 * Parse the text of one read window into complete entries.
 * - A window not starting at byte 0 begins mid-line: everything up to the
 *   first `\n` is the tail of an older entry and is dropped (never a half entry).
 * - The file's last line without a trailing `\n` that fails to parse is a
 *   concurrent append in progress: kept out of `entries`, flagged instead.
 * - Corrupt lines elsewhere are skipped, matching `JSONLFileHelper.read()`.
 */
function parseWindow(text: string, startsAtFileHead: boolean): { entries: ConversationEntry[]; incompleteTail: boolean } {
  let body = text;
  if (!startsAtFileHead) {
    const nl = body.indexOf('\n');
    if (nl === -1) return { entries: [], incompleteTail: false };
    body = body.slice(nl + 1);
  }
  const endsComplete = body.endsWith('\n');
  const lines = body.split('\n');
  if (endsComplete) lines.pop();
  const entries: ConversationEntry[] = [];
  let incompleteTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as ConversationEntry);
    } catch {
      if (i === lines.length - 1 && !endsComplete) incompleteTail = true;
    }
  }
  return { entries, incompleteTail };
}

/**
 * Read a worker transcript from the END of the file, bounded:
 * stat the size, pull only a tail window, parse from its first complete line.
 * The window starts at roughly `need` entries' worth of bytes (with margin)
 * and doubles until `need` matched entries are available, the file start is
 * reached, or {@link MAX_TRANSCRIPT_WINDOW_BYTES} is hit — so a huge
 * transcript never enters memory whole, while small ones are still read exactly.
 *
 * Returns null when the file does not exist, so callers can tell "worker never
 * wrote anything here" from "transcript is empty".
 */
export function readWorkerTranscriptWindow(
  sessionDir: string,
  workerId: string,
  opts: TranscriptReadOptions = {},
): WorkerTranscriptWindow | null {
  if (!isValidWorkerId(workerId)) return null;
  const path = workerTranscriptPath(sessionDir, workerId);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size === 0) {
    return { entries: [], incompleteTail: false, windowTruncated: false, coversFile: true };
  }

  const matches = opts.matches ?? (() => true);
  const need = opts.need ?? Number.POSITIVE_INFINITY;
  let windowBytes = need === Number.POSITIVE_INFINITY
    ? MAX_TRANSCRIPT_WINDOW_BYTES
    : Math.min(MAX_TRANSCRIPT_WINDOW_BYTES, Math.max(MIN_WINDOW_BYTES, Math.ceil(need) * ENTRY_BYTES_ESTIMATE));

  for (;;) {
    const readLen = Math.min(size, windowBytes);
    const start = size - readLen;
    const chunk = Buffer.alloc(readLen);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, chunk, 0, readLen, start);
    } finally {
      closeSync(fd);
    }
    const parsed = parseWindow(chunk.toString('utf8'), start === 0);
    const enough = parsed.entries.filter(matches).length >= need;
    const canGrow = start > 0 && windowBytes < MAX_TRANSCRIPT_WINDOW_BYTES;
    if (enough || !canGrow) {
      return {
        entries: parsed.entries,
        incompleteTail: parsed.incompleteTail,
        windowTruncated: start > 0,
        coversFile: start === 0,
      };
    }
    windowBytes = Math.min(MAX_TRANSCRIPT_WINDOW_BYTES, windowBytes * 2);
  }
}
