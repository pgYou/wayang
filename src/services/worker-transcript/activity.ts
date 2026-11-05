// Activity inference: what a transcript says the worker is (or was) doing.

import type { ConversationEntry } from '@/types/index';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { entryToolCalls } from './entry-text';

export interface WorkerTranscriptSummary {
  totalEntries: number;
  /** Epoch ms of the newest entry's timestamp; null when empty/unparsable. */
  lastActivityAt: number | null;
  /** `type` of the newest entry (e.g. 'assistant'), or null when empty. */
  lastEntryType: string | null;
  /** Name of the most recent tool call (scanning back), or null when none. */
  currentTool: string | null;
  /**
   * A terminal marker is present: a `system` entry with subtype
   * `task_result` (success) or `error` (failure).
   *
   * Basis for `resultReceived` / `streamEnded`: `ClaudeCodeWorker.run()`
   * appends this marker only *after* its SDK message loop exits, so its
   * presence proves both "result received" and "stream ended". Puppet workers
   * write no marker, so their transcripts cannot answer either question.
   */
  hasTerminalEntry: boolean;
  /** Subtype of the terminal marker (`task_result` / `error`), if any. */
  terminalSubtype: string | null;
}

const TERMINAL_SUBTYPES: ReadonlySet<string> = new Set([ESystemSubtype.TaskResult, ESystemSubtype.Error]);

/** Parse an entry timestamp (ISO string, incl. offsets) to epoch ms. */
function entryTimestamp(entry: ConversationEntry): number | null {
  const e = entry as { timestamp?: string; endedAt?: string; startedAt?: string };
  for (const raw of [e.timestamp, e.endedAt, e.startedAt]) {
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

/** Derive activity facts from a transcript (newest-first scans). */
export function summarizeTranscript(entries: ConversationEntry[]): WorkerTranscriptSummary {
  let lastActivityAt: number | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    lastActivityAt = entryTimestamp(entries[i]);
    if (lastActivityAt !== null) break;
  }

  let currentTool: string | null = null;
  let terminalSubtype: string | null = null;
  for (let i = entries.length - 1; i >= 0 && (currentTool === null || terminalSubtype === null); i--) {
    const entry = entries[i];
    if (currentTool === null) {
      const calls = entryToolCalls(entry);
      if (calls.length > 0) currentTool = calls[calls.length - 1].toolName;
    }
    if (terminalSubtype === null
      && entry.type === EEntryType.System
      && TERMINAL_SUBTYPES.has(String((entry as { subtype?: string }).subtype))) {
      terminalSubtype = String((entry as { subtype?: string }).subtype);
    }
  }

  return {
    totalEntries: entries.length,
    lastActivityAt,
    lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : null,
    currentTool,
    hasTerminalEntry: terminalSubtype !== null,
    terminalSubtype,
  };
}

/** Compact duration, e.g. `850ms`, `12.4s`, `3m 05s`, `2h 07m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const abs = Math.max(0, ms);
  if (abs < 1000) return `${Math.round(abs)}ms`;
  if (abs < 60_000) return `${(abs / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) {
    const m = Math.floor(abs / 60_000);
    const s = Math.floor((abs % 60_000) / 1000);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Human-readable "when did this worker last do anything" fragment. */
export function formatLastActivity(lastActivityAt: number | null, now: number): string {
  if (lastActivityAt === null) return 'unknown';
  return `${new Date(lastActivityAt).toISOString()} (${formatDuration(now - lastActivityAt)} ago)`;
}
