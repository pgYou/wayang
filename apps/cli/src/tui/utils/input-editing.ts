/**
 * Pure editing helpers for the input box (selection, word/line motion, kill).
 *
 * Everything here is a pure function over `(value, index)` — no component
 * state, no side effects — so the keybinding layer in `input-area.tsx` can
 * stay thin and the semantics are testable in isolation. Indices are UTF-16
 * code-unit offsets into the raw value, the same convention as the `cursor`
 * state in `input-area.tsx`; the code-point stepping helpers are reused from
 * `input-display.ts`.
 *
 * Surrogate safety: a cursor index that lands between the halves of a
 * surrogate pair (a split emoji) is normalized to sit AFTER that code point.
 * That one rule, applied at every entry point, guarantees no helper ever
 * returns an index — or cuts a deletion range — that splits a pair.
 *
 * Word-boundary rules (`wordLeft` / `wordRight`), per code point:
 * - separators: Unicode whitespace (including '\n' — word motion crosses
 *   line breaks, like readline/emacs) and Unicode punctuation `\p{P}` (ASCII
 *   and CJK/fullwidth alike: `,` `.` `，` `。` …). Underscore is a word
 *   character, per the `\w` convention.
 * - CJK characters (Han, Hiragana, Katakana incl. the prolonged sound mark)
 *   are each their own word unit — one character per step. Rationale:
 *   Chinese/Japanese text has no spaces, so a run of Han characters is not a
 *   word (real segmentation needs a dictionary); stepping one character at a
 *   time gives predictable, fine-grained control, matching how mainstream
 *   editors segment CJK.
 * - everything else (letters, digits, Hangul, emoji, symbols) forms one word
 *   per maximal run, like readline's M-b / M-f.
 */

import {
  nextCodePointLength,
  prevCodePointLength,
} from '@/tui/utils/input-display';

/** An edited value plus the cursor position it leaves behind. */
export interface EditResult {
  value: string;
  cursor: number;
}

/** A normalized selection range: `start <= end`, both code-point boundaries. */
export interface SelectionRange {
  start: number;
  end: number;
}

/** Clamp an index into `[0, value.length]`. */
export function clampIndex(value: string, index: number): number {
  return Math.max(0, Math.min(value.length, index));
}

/**
 * Clamp `index`, then — if it sits between the halves of a surrogate pair —
 * move it past the whole code point. `codePointAt(i - 1) > 0xffff` holds
 * exactly when the unit at `i - 1` is a high surrogate paired with the low
 * surrogate at `i`, so this never fires on a lone surrogate.
 */
function normalizeCursorIndex(value: string, index: number): number {
  const i = clampIndex(value, index);
  if (i > 0 && i < value.length && (value.codePointAt(i - 1) ?? 0) > 0xffff) {
    return i + 1;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Word motion
// ---------------------------------------------------------------------------

/** How a code point participates in word motion. */
type WordClass = 'separator' | 'cjk' | 'word';

/** Code-point ranges whose characters are each their own word unit. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  // Hiragana + Katakana, incl. the prolonged sound mark ー (the middle dot ・
  // is punctuation and filtered out before this check).
  [0x3040, 0x30ff],
  // CJK Extension A + Unified Ideographs.
  [0x3400, 0x9fff],
  // CJK compatibility ideographs.
  [0xf900, 0xfaff],
  // CJK Extension B and beyond.
  [0x20000, 0x3ffff],
];

const WHITESPACE = /\s/u;
const PUNCTUATION = /\p{P}/u;

function classifyCodePoint(cp: number): WordClass {
  if (cp === 0x5f) return 'word'; // underscore: word char per the \w convention
  const ch = String.fromCodePoint(cp);
  if (WHITESPACE.test(ch)) return 'separator';
  if (PUNCTUATION.test(ch)) return 'separator';
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return 'cjk';
  }
  return 'word';
}

/** Class of the code point ending at `index` (the one stepped over moving left). */
function classBefore(value: string, index: number): WordClass {
  if (index <= 0) return 'separator';
  const len = prevCodePointLength(value, index);
  return classifyCodePoint(value.codePointAt(index - len) ?? 0);
}

/** Class of the code point starting at `index`. */
function classAt(value: string, index: number): WordClass {
  return classifyCodePoint(value.codePointAt(index) ?? 0);
}

/**
 * Move to the start of the word before the cursor (readline M-b /
 * ctrl+left). Separators are skipped transparently, so the cursor only ever
 * lands on word starts; motion crosses line breaks because '\n' is a
 * separator. CJK characters step one per call.
 */
export function wordLeft(value: string, index: number): number {
  let i = normalizeCursorIndex(value, index);
  while (i > 0 && classBefore(value, i) === 'separator') {
    i -= prevCodePointLength(value, i);
  }
  if (i === 0) return 0;
  if (classBefore(value, i) === 'cjk') {
    return i - prevCodePointLength(value, i);
  }
  while (i > 0 && classBefore(value, i) === 'word') {
    i -= prevCodePointLength(value, i);
  }
  return i;
}

/**
 * Move to the end of the word at/after the cursor (readline M-f /
 * ctrl+right). From inside a word it stops at that word's end; from a
 * separator position it skips separators first. CJK characters step one per
 * call.
 */
export function wordRight(value: string, index: number): number {
  const len = value.length;
  let i = normalizeCursorIndex(value, index);
  while (i < len && classAt(value, i) === 'separator') {
    i += nextCodePointLength(value, i);
  }
  if (i === len) return len;
  if (classAt(value, i) === 'cjk') {
    return i + nextCodePointLength(value, i);
  }
  while (i < len && classAt(value, i) === 'word') {
    i += nextCodePointLength(value, i);
  }
  return i;
}

// ---------------------------------------------------------------------------
// Line motion
// ---------------------------------------------------------------------------

/** Start of the logical line containing `index`: 0, or just after a '\n'. */
export function lineStart(value: string, index: number): number {
  let i = normalizeCursorIndex(value, index);
  while (i > 0 && value.charCodeAt(i - 1) !== 0x0a) i -= 1;
  return i;
}

/**
 * End of the logical line containing `index`: the index of the '\n' that
 * ends it (the newline itself is NOT part of the line), or `value.length`.
 */
export function lineEnd(value: string, index: number): number {
  let i = normalizeCursorIndex(value, index);
  while (i < value.length && value.charCodeAt(i) !== 0x0a) i += 1;
  return i;
}

// ---------------------------------------------------------------------------
// Kill (delete) operations
// ---------------------------------------------------------------------------

/** Delete from the cursor to the end of the line; the '\n' survives. */
export function killToLineEnd(value: string, index: number): EditResult {
  const cursor = normalizeCursorIndex(value, index);
  const end = lineEnd(value, cursor);
  return { value: value.slice(0, cursor) + value.slice(end), cursor };
}

/**
 * Delete from the start of the line to the cursor; the cursor lands on the
 * (unchanged) line start.
 */
export function killToLineStart(value: string, index: number): EditResult {
  const cursor = normalizeCursorIndex(value, index);
  const start = lineStart(value, cursor);
  return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
}

/**
 * Delete the word before the cursor (readline M-BS / ctrl+backspace): the
 * range between `wordLeft(value, index)` and `index`, so separators before
 * the word go with it and motion may cross a line break.
 */
export function killWordBefore(value: string, index: number): EditResult {
  const cursor = normalizeCursorIndex(value, index);
  const start = wordLeft(value, cursor);
  return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
}

// ---------------------------------------------------------------------------
// Selection / range plumbing
// ---------------------------------------------------------------------------

/**
 * Normalize an (anchor, cursor) pair into an ordered range. `anchor === null`
 * (no selection in progress) and `anchor === cursor` both mean an empty
 * selection at the cursor; a reversed pair (anchor after cursor) is ordered
 * so `start <= end` always holds.
 */
export function normalizeSelection(
  value: string,
  anchor: number | null,
  cursor: number,
): SelectionRange {
  const c = normalizeCursorIndex(value, cursor);
  const a = anchor === null ? c : normalizeCursorIndex(value, anchor);
  return a <= c ? { start: a, end: c } : { start: c, end: a };
}

/**
 * Splice `insert` into `[start, end)` — clamped into range and order-
 * normalized — and place the cursor after the inserted text. The component
 * layer's bread-and-butter for typed input and selection replacement;
 * boundaries are expected to be code-point positions (cursor-derived).
 */
export function replaceRange(
  value: string,
  start: number,
  end: number,
  insert: string,
): EditResult {
  let a = clampIndex(value, start);
  let b = clampIndex(value, end);
  if (a > b) [a, b] = [b, a];
  return { value: value.slice(0, a) + insert + value.slice(b), cursor: a + insert.length };
}
