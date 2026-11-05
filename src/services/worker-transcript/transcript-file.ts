// Locating a worker transcript and reading it whole (the small-transcript path).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationEntry } from '@/types/index';
import { JSONLFileHelper } from '@/infra/state/persistence/jsonl-file';
import { workerDir } from '@/services/agents/worker-state';

/** File name of a worker's append-only conversation log (mirrors WorkerState). */
export const WORKER_TRANSCRIPT_FILE = 'conversation.jsonl';

/**
 * Tool-output cap for transcript reads. The default 8000-char guard in
 * `safeExecute` is tuned for file/search output; an explicit `full=true`
 * request must be able to return a finished report (the incident's was 4642
 * chars) without being silently re-cut.
 */
export const MAX_TRANSCRIPT_RESULT_CHARS = 40_000;

/** Worker ids are generated (`cw-1793587065421-6h37`, `agent-…`); anything else is untrusted input. */
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Guard against path traversal: the id becomes a directory name, and the
 * controller (an LLM) is the one supplying it.
 */
export function isValidWorkerId(workerId: string): boolean {
  return WORKER_ID_PATTERN.test(workerId) && workerId !== '.' && workerId !== '..';
}

/** Absolute path of a worker's transcript. Layout comes from WorkerState. */
export function workerTranscriptPath(sessionDir: string, workerId: string): string {
  return join(workerDir(sessionDir, workerId), WORKER_TRANSCRIPT_FILE);
}

/**
 * Read every entry of a worker transcript.
 * Returns null when the file does not exist (worker never ran / wrong session),
 * so callers can say "no transcript" instead of pretending the worker was silent.
 * Invalid ids (path separators, `..`) are refused outright — read-only tool.
 *
 * Whole-file read: fine for small transcripts, but it puts the entire file in
 * memory as one string. The pagination tools use
 * {@link readWorkerTranscriptWindow} instead.
 */
export function readWorkerTranscript(sessionDir: string, workerId: string): ConversationEntry[] | null {
  if (!isValidWorkerId(workerId)) return null;
  const path = workerTranscriptPath(sessionDir, workerId);
  if (!existsSync(path)) return null;
  // Reuse the JSONL helper: torn/corrupt lines are skipped, not fatal.
  return new JSONLFileHelper<ConversationEntry>(path).read();
}
