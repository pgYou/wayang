/**
 * Terminal display-width helpers shared by TUI row summaries.
 *
 * East-Asian-width approximation: CJK / fullwidth / emoji take two columns,
 * combining marks take zero. Good enough for one-line row truncation; not a
 * full Unicode width implementation.
 */

/** Display width of one code point: CJK/fullwidth = 2, combining marks = 0, else 1. */
export function charWidth(cp: number): number {
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacritics
  if (
    (cp >= 0x1100 && cp <= 0x115f) // Hangul Jamo
    || (cp >= 0x2e80 && cp <= 0xa4cf) // CJK radicals .. Yi syllables
    || (cp >= 0xa960 && cp <= 0xa97f) // Hangul Jamo Extended-A
    || (cp >= 0xac00 && cp <= 0xd7a3) // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK compatibility ideographs
    || (cp >= 0xfe10 && cp <= 0xfe19) // vertical forms
    || (cp >= 0xfe30 && cp <= 0xfe6f) // CJK compatibility forms
    || (cp >= 0xff00 && cp <= 0xff60) // fullwidth forms
    || (cp >= 0xffe0 && cp <= 0xffe6) // fullwidth signs
    || (cp >= 0x1f300 && cp <= 0x1faff) // emoji (approximation)
    || (cp >= 0x20000 && cp <= 0x3fffd) // CJK Extension B+
  ) {
    return 2;
  }
  return 1;
}

/** Total display width of a string, counting CJK/fullwidth as 2 columns. */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += charWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

/** Hard-truncate to `maxWidth` display columns, appending an ellipsis when cut. */
export function truncateToWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(s) <= maxWidth) return s;
  const limit = maxWidth - 1; // reserve one column for the ellipsis
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * Hard-truncate to at most `maxWidth` display columns WITHOUT appending an
 * ellipsis — the width-equivalent of `String.prototype.slice`, so ASCII input
 * yields exactly `s.slice(0, maxWidth)` while CJK is cut by columns. Used where
 * a value is capped by column budget but an ellipsis would be noise (e.g. the
 * status-bar label cap).
 */
export function sliceToWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** Take at most `maxWidth` display columns from the END of `s` (no ellipsis). */
function sliceToWidthFromEnd(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const chars = Array.from(s);
  let w = 0;
  let out = '';
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const cw = charWidth(chars[i].codePointAt(0) ?? 0);
    if (w + cw > maxWidth) break;
    out = chars[i] + out;
    w += cw;
  }
  return out;
}

/**
 * Middle-ellipsis truncation to at most `maxWidth` display columns: keep the
 * head and the tail, replace the middle with a single "…".
 *
 * Used where both ends of a value carry meaning — a file path's leading
 * directories identify the tree, its trailing segments identify the project —
 * so unlike `truncateToWidth` the tail survives. Never exceeds `maxWidth`
 * columns; strings that already fit are returned untouched.
 */
export function truncateMiddleToWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(s) <= maxWidth) return s;
  if (maxWidth === 1) return '…';
  // One column goes to the ellipsis; the rest splits between head and tail,
  // the head taking the odd column (paths are read left-to-right).
  const keep = maxWidth - 1;
  const headBudget = Math.ceil(keep / 2);
  const tailBudget = keep - headBudget;
  return sliceToWidth(s, headBudget) + '…' + sliceToWidthFromEnd(s, tailBudget);
}

/** Collapse runs of whitespace (incl. newlines) to single spaces. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate `body` so that `body + suffix` fits within `budget` columns,
 * keeping the suffix intact (e.g. the "(N 行)" note survives truncation).
 */
export function fitWithSuffix(body: string, suffix: string, budget: number): string {
  const bodyBudget = budget - stringWidth(suffix);
  if (bodyBudget < 1) {
    // No room for a body — the suffix alone (possibly truncated).
    return truncateToWidth(suffix, Math.max(budget, 1));
  }
  return truncateToWidth(body, bodyBudget) + suffix;
}

/** Last 4 characters of an id, used as a short visual handle (e.g. "#7xvt"). */
export function shortId(id: string): string {
  return id.slice(-4);
}
