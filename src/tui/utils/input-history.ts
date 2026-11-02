/**
 * Snapshot-based undo/redo history for the input box.
 *
 * Everything here is a pure function over an immutable history value — no
 * component state, no timers, no side effects — so the keybinding layer in
 * `input-area.tsx` only has to keep one `useRef` and the merge semantics are
 * testable with explicit timestamps.
 *
 * Why snapshots and not inverse operations: an inverse would have to remember
 * the deleted text and where it sat, and a selection replacement would need a
 * patch stitched from both halves. A snapshot is trivially correct for
 * CJK/emoji (indices are UTF-16 code units, same convention as
 * `input-editing.ts`) and the input box holds a handful of characters, so the
 * memory is noise.
 *
 * Model: `entries[0]` is the baseline (created by `initInputHistory`, refreshed
 * whenever the box is reset) and `pointer` is the live entry — the invariant
 * is `live value === entries[pointer].value`; the cursor may drift between
 * edits without committing. `rewound` is true right after an undo/redo so the
 * next edit never merges into an entry the user just navigated to.
 */

/** What produced an entry. Only `'insert'`/`'delete'` runs ever merge. */
export type EditKind = 'insert' | 'delete' | 'paste' | 'kill' | 'replace' | 'snap';

/** One committed state of the input box. */
export interface HistoryEntry {
  value: string;
  cursor: number;
  /** Fixed end of the selection at commit time; `null` when none. */
  anchor: number | null;
  /** Timestamp (ms) used for merge-window judgement. */
  ts: number;
  kind: EditKind;
}

/** The undo stack plus the cursor into it. */
export interface InputHistory {
  entries: HistoryEntry[];
  /** Index of the entry matching the live value. */
  pointer: number;
  /** True when the pointer was just moved by undo/redo, not by an edit. */
  rewound: boolean;
}

/** An edit to commit: the post-edit state plus how it was produced. */
export interface EditCommit {
  value: string;
  cursor: number;
  anchor: number | null;
  ts: number;
  kind: EditKind;
}

/** Consecutive plain inserts/deletes merge while closer together than this. */
export const MERGE_WINDOW_MS = 500;

/** Hard cap on stack depth; the oldest entries fall off the bottom. */
export const MAX_ENTRIES = 100;

/** A fresh history holding only the baseline entry for `value`. */
export function initInputHistory(value: string, ts: number = Date.now()): InputHistory {
  return {
    entries: [{ value, cursor: value.length, anchor: null, ts, kind: 'snap' }],
    pointer: 0,
    rewound: false,
  };
}

/**
 * Whether `edit` continues the run recorded in `prev`.
 *
 * Insert: both sides are plain inserts, exactly one code point was added
 * (1 or 2 code units — surrogate pairs count as one), and the cursor sits
 * where the previous insert left it. A cursor move in between breaks the
 * chain, so typing, moving away and typing again yields two undo steps.
 *
 * Delete: mirror image — one code point removed and the cursor backed up by
 * exactly that much, i.e. repeated backspaces.
 */
function continuesRun(prev: HistoryEntry, edit: EditCommit): boolean {
  if (prev.kind === 'insert' && edit.kind === 'insert') {
    const lenDiff = edit.value.length - prev.value.length;
    return (lenDiff === 1 || lenDiff === 2) && edit.cursor === prev.cursor + lenDiff;
  }
  if (prev.kind === 'delete' && edit.kind === 'delete') {
    const diff = prev.value.length - edit.value.length;
    return (diff === 1 || diff === 2) && edit.cursor === prev.cursor - diff;
  }
  return false;
}

/**
 * Record `edit` and return the resulting history.
 *
 * Merging requires all three guards at once: the pointer is at the tail (no
 * redo branch to drop), the history was not just rewound (undo → type must not
 * fold into the restored entry), and the edit continues the previous run
 * within `MERGE_WINDOW_MS`. Otherwise the redo branch is truncated, the edit
 * is pushed, and the stack is trimmed to `MAX_ENTRIES`.
 */
export function commitEdit(history: InputHistory, edit: EditCommit): InputHistory {
  const { entries, pointer, rewound } = history;
  const prev = entries[pointer];
  const atTail = pointer === entries.length - 1;

  if (
    prev &&
    atTail &&
    !rewound &&
    edit.ts - prev.ts < MERGE_WINDOW_MS &&
    continuesRun(prev, edit)
  ) {
    const merged = entries.slice();
    // The sliding window slides: the merged entry takes the newer timestamp.
    merged[pointer] = { ...edit };
    return { entries: merged, pointer, rewound: false };
  }

  const next = [...entries.slice(0, pointer + 1), { ...edit }];
  if (next.length > MAX_ENTRIES) {
    const trimmed = next.slice(next.length - MAX_ENTRIES);
    return { entries: trimmed, pointer: trimmed.length - 1, rewound: false };
  }
  return { entries: next, pointer: next.length - 1, rewound: false };
}

/**
 * Step back one entry, or `null` when already at the baseline. The caller
 * reads `entries[pointer]` and applies it to the input box.
 */
export function undoEdit(history: InputHistory): InputHistory | null {
  if (history.pointer === 0) return null;
  return { entries: history.entries, pointer: history.pointer - 1, rewound: true };
}

/**
 * Step forward one entry, or `null` when already at the newest one.
 */
export function redoEdit(history: InputHistory): InputHistory | null {
  if (history.pointer === history.entries.length - 1) return null;
  return { entries: history.entries, pointer: history.pointer + 1, rewound: true };
}
