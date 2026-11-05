// Formatting: rendering entries under a character budget, with explicit truncation meta.

import type { ConversationEntry } from '@/types/index';
import { entryLabel, entryText, entryToolCalls, entryToolResults } from './entry-text';
import type { TranscriptWindow } from './pagination';

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
