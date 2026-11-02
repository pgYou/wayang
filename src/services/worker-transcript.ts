/**
 * Worker transcript utilities — the controller's read path into a worker's
 * live/on-disk conversation (issue #16).
 *
 * Everything here is read-only. It inspects
 * `<sessionDir>/workers/<workerId>/conversation.jsonl` — the same append-only
 * file `WorkerState` writes — so a finished, failed, or cancelled worker stays
 * inspectable after the engine has dropped it from its in-memory `workers` map.
 *
 * Also hosts the pagination/formatting helpers shared by `get_task_detail` and
 * `read_worker_conversation`, plus the activity inference used by
 * `get_worker_status` and the heartbeat signal.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationEntry } from '@/types/index';
import { EEntryType, ESystemSubtype } from '@/types/index';
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
 */
export function readWorkerTranscript(sessionDir: string, workerId: string): ConversationEntry[] | null {
  if (!isValidWorkerId(workerId)) return null;
  const path = workerTranscriptPath(sessionDir, workerId);
  if (!existsSync(path)) return null;
  // Reuse the JSONL helper: torn/corrupt lines are skipped, not fatal.
  return new JSONLFileHelper<ConversationEntry>(path).read();
}

// ---------------------------------------------------------------------------
// Entry text extraction
// ---------------------------------------------------------------------------

function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
    // Non-text blocks (tool_use, images, …) keep their structure instead of
    // degrading to "[object Object]" / comma-joined fragments.
    return JSON.stringify(block);
  }
  return String(block ?? '');
}

/**
 * Flatten an entry's text payload.
 * `message.content` may be a string or a content-block array — the array case
 * used to collapse into a comma-joined String() before being cut, losing both
 * structure and readability.
 */
export function entryText(entry: ConversationEntry): string {
  const raw = entry as { message?: { content?: unknown }; content?: unknown };
  const content = raw.message?.content ?? raw.content ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('\n');
  return content === null || content === undefined ? '' : String(content);
}

/** Tool calls recorded on an entry (puppet/controller entries carry them). */
function entryToolCalls(entry: ConversationEntry): Array<{ toolName: string; arguments?: string }> {
  const calls = (entry as { toolCalls?: Array<{ toolName?: string; arguments?: string }> }).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter((c) => typeof c?.toolName === 'string')
    .map((c) => ({ toolName: c.toolName as string, arguments: c.arguments }));
}

function entryToolResults(entry: ConversationEntry): Array<{ output?: string; isError?: boolean }> {
  const results = (entry as { toolResults?: Array<{ output?: string; isError?: boolean }> }).toolResults;
  return Array.isArray(results) ? results : [];
}

/** Human-facing label, e.g. `assistant` or `system/task_result`. */
export function entryLabel(entry: ConversationEntry): string {
  const subtype = (entry as { subtype?: string }).subtype;
  return subtype ? `${entry.type}/${subtype}` : entry.type;
}

// ---------------------------------------------------------------------------
// Activity inference
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface TranscriptWindow<T> {
  entries: T[];
  /** Entries in the paginated population (after any type filter). */
  totalEntries: number;
  returnedEntries: number;
  offset: number;
  limit: number;
  /** 1-based index of the first returned entry in the population (0 = empty). */
  startIndex: number;
  /** 1-based index of the last returned entry (0 = empty). */
  endIndex: number;
  /** The window itself cut entries off (returned < total). */
  windowTruncated: boolean;
}

/**
 * Select a window counting back from the newest entry.
 * offset=0 starts at the tail; offset=5 skips the newest 5 entries.
 * The returned slice keeps chronological order (oldest → newest in window).
 */
export function selectWindow<T>(entries: T[], offset: number, limit: number): TranscriptWindow<T> {
  const total = entries.length;
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
  const safeLimit = Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : 0);
  const end = Math.max(0, total - safeOffset);
  const start = safeLimit === 0 ? end : Math.max(0, end - safeLimit);
  const window = entries.slice(start, end);
  return {
    entries: window,
    totalEntries: total,
    returnedEntries: window.length,
    offset: safeOffset,
    limit: safeLimit,
    startIndex: window.length > 0 ? start + 1 : 0,
    endIndex: window.length > 0 ? end : 0,
    windowTruncated: window.length < total,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Per-entry character cap on the text payload; null = no cap (full mode). */
  maxChars: number | null;
  /** Include tool-call arguments and tool results (full mode). */
  includeToolDetail?: boolean;
}

export interface FormattedEntry {
  lines: string[];
  /** The entry's text payload was cut. */
  truncated: boolean;
  originalChars: number;
}

/** Format one entry as indented lines, with an explicit per-entry truncation marker. */
export function formatTranscriptEntry(
  entry: ConversationEntry,
  position: number,
  opts: FormatOptions,
): FormattedEntry {
  const body = entryText(entry).replace(/\r/g, '');
  const toolNames = entryToolCalls(entry).map((c) => c.toolName);
  const toolNote = toolNames.length > 0 ? ` (tools: ${toolNames.join(', ')})` : '';
  const head = `  #${position} [${entryLabel(entry)}]${toolNote}`;

  const cap = opts.maxChars;
  const cut = cap !== null && body.length > cap;
  const shown = cut ? body.slice(0, cap as number) + '…' : body;
  const marker = cut ? ` (truncated: ${cap}/${body.length} chars)` : '';

  const lines: string[] = [];
  if (shown.length === 0) {
    lines.push(`${head}${marker} (empty)`);
  } else if (!shown.includes('\n')) {
    lines.push(`${head}${marker} ${shown}`);
  } else {
    lines.push(`${head}${marker}`);
    for (const line of shown.split('\n')) lines.push(`      ${line}`);
  }

  if (opts.includeToolDetail) {
    for (const call of entryToolCalls(entry)) {
      const args = call.arguments ?? '';
      const argsShown = cap !== null && args.length > cap ? args.slice(0, cap as number) + '…' : args;
      lines.push(`      ↳ ${call.toolName} ${argsShown}`.trimEnd());
    }
    for (const result of entryToolResults(entry)) {
      const output = result.output ?? '';
      const outputShown = cap !== null && output.length > cap ? output.slice(0, cap as number) + '…' : output;
      lines.push(`      ↳ result${result.isError ? ' [error]' : ''}: ${outputShown}`.trimEnd());
    }
  }

  return { lines, truncated: cut, originalChars: body.length };
}

/**
 * Shrink a window from its oldest side (used when the rendered text would
 * exceed the tool-output budget, so the meta we report still matches what the
 * caller actually receives instead of being silently cut by the tool runner).
 */
export function shrinkWindow<T>(win: TranscriptWindow<T>, dropFromStart: number): TranscriptWindow<T> {
  const drop = Math.max(0, Math.min(dropFromStart, win.entries.length));
  if (drop === 0) return win;
  const entries = win.entries.slice(drop);
  return {
    ...win,
    entries,
    returnedEntries: entries.length,
    startIndex: win.startIndex + drop,
    windowTruncated: true,
  };
}

export interface RenderedEntries {
  lines: string[];
  /** How many entries had to be dropped from the oldest side to fit. */
  dropped: number;
  /** Entries whose text payload was shortened. */
  shortened: number;
}

/**
 * Format entries newest-first under a character budget.
 * Entries that do not fit are dropped from the oldest side (never silently cut
 * in the middle), and the caller shrinks its window by `dropped`.
 */
export function renderEntriesFitting(
  entries: ConversationEntry[],
  startIndex: number,
  opts: FormatOptions,
  budgetChars: number,
): RenderedEntries {
  const formatted = entries.map((entry, i) => formatTranscriptEntry(entry, startIndex + i, opts));
  let used = 0;
  let first = formatted.length;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const size = formatted[i].lines.reduce((n, line) => n + line.length + 1, 0);
    // Always keep at least the newest entry, even if it alone blows the budget.
    if (used + size > budgetChars && first < formatted.length) break;
    used += size;
    first = i;
  }
  const kept = formatted.slice(first);
  return {
    lines: kept.flatMap((f) => f.lines),
    dropped: first,
    shortened: kept.filter((f) => f.truncated).length,
  };
}

export interface WindowMeta {
  totalEntries: number;
  returnedEntries: number;
  offset: number;
  limit: number;
  /** Per-entry character cap; null in full mode. */
  maxChars: number | null;
  full: boolean;
  /** Anything was cut: the window, or an individual entry's text. */
  truncated: boolean;
  /** The entry window itself excluded entries (returned < total). */
  windowTruncated: boolean;
  startIndex: number;
  endIndex: number;
  /** How many returned entries had their text shortened. */
  shortenedEntries: number;
}

/** Build the meta object from a window plus per-entry shortening count. */
export function buildWindowMeta(
  win: TranscriptWindow<ConversationEntry>,
  opts: { maxChars: number | null; full: boolean; shortenedEntries: number },
): WindowMeta {
  return {
    totalEntries: win.totalEntries,
    returnedEntries: win.returnedEntries,
    offset: win.offset,
    limit: win.limit,
    maxChars: opts.maxChars,
    full: opts.full,
    truncated: win.windowTruncated || opts.shortenedEntries > 0,
    windowTruncated: win.windowTruncated,
    startIndex: win.startIndex,
    endIndex: win.endIndex,
    shortenedEntries: opts.shortenedEntries,
  };
}

/**
 * Explicit truncation notice — the missing piece that made the controller read
 * a cut-off report opening as "the worker is stuck at section A".
 */
export function buildTruncationNotice(meta: WindowMeta): string | null {
  const perEntry = meta.maxChars === null ? 'none' : `${meta.maxChars}`;
  const shortened = meta.shortenedEntries > 0 ? ` (${meta.shortenedEntries} entries shortened)` : '';

  if (meta.windowTruncated) {
    // In full mode the window was already widened, so the only way further
    // back is paging with offset.
    const how = meta.full
      ? 'output cap reached — page further back with offset'
      : 'pass offset/limit or full=true';
    return `[truncated: showing ${meta.returnedEntries} of ${meta.totalEntries} entries (${meta.startIndex}-${meta.endIndex}), per-entry limit ${perEntry} chars${shortened}; ${how}]`;
  }
  if (meta.shortenedEntries > 0) {
    return `[truncated: showing all ${meta.totalEntries} entries, per-entry limit ${perEntry} chars${shortened}; pass full=true for complete content]`;
  }
  return null;
}

/** Header line for a paginated transcript block, counts always consistent. */
export function buildTranscriptHeader(meta: WindowMeta): string {
  if (meta.totalEntries === 0) return 'Conversation (0 entries):';
  if (!meta.windowTruncated) return `Conversation (${meta.totalEntries} entries):`;
  return `Conversation (${meta.totalEntries} entries total, showing ${meta.startIndex}-${meta.endIndex} by offset=${meta.offset} limit=${meta.limit}):`;
}
