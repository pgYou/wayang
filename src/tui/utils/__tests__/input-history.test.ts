import { describe, it, expect } from 'vitest';
import {
  MAX_ENTRIES,
  MERGE_WINDOW_MS,
  commitEdit,
  initInputHistory,
  redoEdit,
  undoEdit,
} from '@/tui/utils/input-history';
import type { EditKind, InputHistory } from '@/tui/utils/input-history';

// Explicit timestamps everywhere: the merge window is data, not a timer, so
// no fake timers and no flakiness.
const T0 = 1_000_000;

/** Append `text` at the live entry's cursor, as ordinary typing would. */
function type(
  h: InputHistory,
  text: string,
  ts: number,
  kind: EditKind = 'insert',
): InputHistory {
  const live = h.entries[h.pointer];
  return commitEdit(h, {
    value: live.value + text,
    cursor: live.cursor + text.length,
    anchor: null,
    ts,
    kind,
  });
}

/** Remove the last code point (BMP only — tests keep it simple), as backspace would. */
function backspace(h: InputHistory, ts: number, kind: EditKind = 'delete'): InputHistory {
  const live = h.entries[h.pointer];
  return commitEdit(h, {
    value: live.value.slice(0, -1),
    cursor: live.cursor - 1,
    anchor: null,
    ts,
    kind,
  });
}

/** The value the component would be showing. */
function live(h: InputHistory): string {
  return h.entries[h.pointer].value;
}

describe('initInputHistory', () => {
  it('starts with a single baseline entry', () => {
    const h = initInputHistory('', T0);
    expect(h.entries).toEqual([
      { value: '', cursor: 0, anchor: null, ts: T0, kind: 'snap' },
    ]);
    expect(h.pointer).toBe(0);
    expect(h.rewound).toBe(false);
  });

  it('parks the baseline cursor at the end of the given value', () => {
    const h = initInputHistory('你好', T0);
    expect(h.entries[0].value).toBe('你好');
    expect(h.entries[0].cursor).toBe(2);
  });
});

describe('commitEdit merging', () => {
  it('folds three quick inserts into one undo step', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 20);
    h = type(h, 'c', T0 + 30);
    expect(h.entries).toHaveLength(2); // baseline + one merged run
    expect(live(h)).toBe('abc');
    expect(h.entries[h.pointer].cursor).toBe(3);
    expect(h.entries[h.pointer].kind).toBe('insert');
    expect(h.pointer).toBe(1);
  });

  it('keeps inserts apart when the gap reaches the merge window', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 10 + MERGE_WINDOW_MS);
    expect(h.entries).toHaveLength(3);
    expect(live(h)).toBe('ab');
  });

  it('slides the window: a long run stays merged as long as gaps are short', () => {
    let h = initInputHistory('', T0);
    for (let i = 0; i < 20; i++) h = type(h, 'x', T0 + i * 400);
    expect(h.entries).toHaveLength(2);
    expect(live(h)).toBe('x'.repeat(20));
  });

  it('does not merge when the cursor jumped between inserts', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10); // 'a', cursor 1
    // Insert at the start instead of at the previous cursor: 'x' + 'a'.
    h = commitEdit(h, { value: 'xa', cursor: 1, anchor: null, ts: T0 + 20, kind: 'insert' });
    expect(h.entries).toHaveLength(3);
    expect(live(h)).toBe('xa');
  });

  it('folds three quick backspaces into one undo step', () => {
    let h = initInputHistory('abcd', T0);
    h = backspace(h, T0 + 10);
    h = backspace(h, T0 + 20);
    h = backspace(h, T0 + 30);
    expect(h.entries).toHaveLength(2);
    expect(live(h)).toBe('a');
    expect(h.entries[h.pointer].kind).toBe('delete');
  });

  it('does not merge deletions that are not cursor-adjacent', () => {
    let h = initInputHistory('abcd', T0);
    h = backspace(h, T0 + 10); // 'abc', cursor 3
    // Delete at the front: 'bc', cursor 0 — the cursor did not back up.
    h = commitEdit(h, { value: 'bc', cursor: 0, anchor: null, ts: T0 + 20, kind: 'delete' });
    expect(h.entries).toHaveLength(3);
  });

  it('never merges paste, kill or replace runs', () => {
    for (const kind of ['paste', 'kill', 'replace'] as const) {
      let h = initInputHistory('', T0);
      h = type(h, 'a', T0 + 10, kind);
      h = type(h, 'b', T0 + 20, kind);
      expect(h.entries, kind).toHaveLength(3);
      expect(live(h)).toBe('ab');
    }
  });

  it('never merges a single-code-point insert into a paste run', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'ab', T0 + 10, 'paste');
    h = type(h, 'c', T0 + 20);
    expect(h.entries).toHaveLength(3);
  });

  it('merges surrogate pairs as one code point (2 code units)', () => {
    let h = initInputHistory('', T0);
    h = type(h, '😀', T0 + 10);
    h = type(h, '😀', T0 + 20);
    expect(h.entries).toHaveLength(2);
    expect(live(h)).toBe('😀😀');
    expect(h.entries[h.pointer].cursor).toBe(4);
  });

  it('starts a run from a plain insert even after a non-mergeable entry', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'ab', T0 + 10, 'paste');
    h = type(h, 'c', T0 + 20);
    h = type(h, 'd', T0 + 30);
    // baseline + paste + one merged insert run ('cd')
    expect(h.entries.map(e => e.value)).toEqual(['', 'ab', 'abcd']);
  });
});

describe('commitEdit after undo/redo', () => {
  it('does not merge an insert typed right after an undo', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 600);
    expect(h.entries).toHaveLength(3);

    const undone = undoEdit(h);
    expect(undone).not.toBeNull();
    h = type(undone as InputHistory, 'c', T0 + 610);
    // Baseline + 'a' + the new 'c' — the restored entry was not overwritten.
    expect(h.entries).toHaveLength(3);
    expect(live(h)).toBe('ac');
    expect(h.rewound).toBe(false);
  });

  it('does not merge an insert typed right after a redo', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 600);

    const undone = undoEdit(h) as InputHistory;
    const redone = redoEdit(undone) as InputHistory;
    h = type(redone, 'c', T0 + 610);
    expect(h.entries).toHaveLength(4);
    expect(live(h)).toBe('abc');
  });

  it('refuses to merge below the tail even without the rewound flag', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 600);
    // Simulate "pointer parked mid-stack, flag cleared".
    const parked: InputHistory = { ...h, pointer: 1, rewound: false };
    const next = commitEdit(parked, {
      value: 'aX',
      cursor: 2,
      anchor: null,
      ts: T0 + 610,
      kind: 'insert',
    });
    expect(next.entries).toHaveLength(3); // [baseline, 'a', 'aX'] — redo dropped
    expect(next.entries.map(e => e.value)).toEqual(['', 'a', 'aX']);
    expect(next.pointer).toBe(2);
  });

  it('truncates the redo branch when a new edit follows an undo', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 600);
    h = undoEdit(h) as InputHistory;
    h = type(h, 'z', T0 + 610);

    expect(h.entries.map(e => e.value)).toEqual(['', 'a', 'az']);
    expect(h.pointer).toBe(2);
    expect(redoEdit(h)).toBeNull();
  });
});

describe('commitEdit bounds', () => {
  it('caps the stack at MAX_ENTRIES, dropping the oldest entries', () => {
    let h = initInputHistory('', T0);
    for (let i = 0; i < MAX_ENTRIES + 50; i++) {
      h = type(h, 'x', T0 + i * (MERGE_WINDOW_MS + 1));
    }
    expect(h.entries).toHaveLength(MAX_ENTRIES);
    expect(h.pointer).toBe(MAX_ENTRIES - 1);
    expect(h.entries[h.pointer].value).toBe('x'.repeat(MAX_ENTRIES + 50));
  });
});

describe('undoEdit / redoEdit', () => {
  it('walks back and forward through the entries', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 600);
    h = type(h, 'c', T0 + 1200);

    h = undoEdit(h) as InputHistory;
    expect(h.pointer).toBe(2);
    expect(live(h)).toBe('ab');
    h = undoEdit(h) as InputHistory;
    expect(h.pointer).toBe(1);
    expect(live(h)).toBe('a');
    h = undoEdit(h) as InputHistory;
    expect(h.pointer).toBe(0);
    expect(live(h)).toBe('');

    h = redoEdit(h) as InputHistory;
    expect(h.pointer).toBe(1);
    expect(live(h)).toBe('a');
    h = redoEdit(h) as InputHistory;
    h = redoEdit(h) as InputHistory;
    expect(h.pointer).toBe(3);
    expect(live(h)).toBe('abc');
  });

  it('returns null at both ends', () => {
    const h = initInputHistory('', T0);
    expect(undoEdit(h)).toBeNull();
    expect(redoEdit(h)).toBeNull();

    const one = type(h, 'a', T0 + 10);
    expect(redoEdit(one)).toBeNull();
    const back = undoEdit(one) as InputHistory;
    expect(undoEdit(back)).toBeNull();
  });

  it('marks the result as rewound and keeps the entries themselves', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'a', T0 + 10);
    h = type(h, 'b', T0 + 600);
    const entries = h.entries;

    const undone = undoEdit(h) as InputHistory;
    expect(undone.rewound).toBe(true);
    expect(undone.entries).toBe(entries); // shared, not copied: undo is just a pointer move
  });

  it('restores the cursor recorded with the entry', () => {
    let h = initInputHistory('', T0);
    h = type(h, 'ab', T0 + 10);
    h = undoEdit(h) as InputHistory;
    expect(h.entries[h.pointer].cursor).toBe(0);
    expect(h.entries[h.pointer].anchor).toBeNull();
  });
});
