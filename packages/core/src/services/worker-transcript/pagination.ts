// Pagination: selecting an offset/limit window counting back from the newest entry.

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
