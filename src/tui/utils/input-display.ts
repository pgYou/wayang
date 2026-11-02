/**
 * Layout helpers for the multi-line input box.
 *
 * The input box renders each visual line as its own row, so no rendered text
 * node ever contains a newline or exceeds the row budget: Ink wraps and
 * positions sibling text nodes per node, and a node that spans several rows
 * (through embedded newlines or its own wrapping) makes later siblings land
 * on the wrong row — scrambled lines and lost characters (issue #22).
 *
 * All width math goes through `text-width.ts` so CJK/fullwidth glyphs count
 * as two terminal columns, never as one UTF-16 code unit.
 */

import { charWidth, stringWidth } from '@/tui/utils/text-width';

/** One rendered row of the input box: a wrapped slice of a logical line. */
export interface InputDisplayLine {
  /** Text of this visual line: no newlines, fits `maxWidth` display columns. */
  text: string;
  /** Code-unit offset into the raw value where this line's text starts. */
  offset: number;
}

/** Value + cursor mapped onto visual lines. */
export interface InputLayout {
  lines: InputDisplayLine[];
  /** Index into `lines` hosting the cursor block (always valid). */
  cursorLine: number;
  /**
   * Code-unit offset of the cursor within that line's text, 0..text.length.
   * `text.length` means the block renders as a trailing inverse space — the
   * cursor sits past the last character (end of value, or on the newline
   * that ends this logical line).
   */
  cursorCol: number;
}

/**
 * Normalize newlines coming from the terminal: pasted multi-line text
 * arrives with CR (most terminals) or CRLF, which would otherwise be
 * inserted verbatim and garble the rendered frame.
 */
export function normalizeInputText(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Code-unit length of the code point ENDING at `index` (the unit the cursor
 * would step over when moving left). Surrogate-aware so the cursor never
 * lands between the halves of an emoji.
 */
export function prevCodePointLength(s: string, index: number): number {
  if (index <= 0) return 0;
  if (
    index >= 2
    && isHighSurrogate(s.charCodeAt(index - 2))
    && isLowSurrogate(s.charCodeAt(index - 1))
  ) {
    return 2;
  }
  return 1;
}

/**
 * Code-unit length of the code point STARTING at `index` (the unit the
 * cursor would step over when moving right). 0 at/past the end.
 */
export function nextCodePointLength(s: string, index: number): number {
  if (index < 0 || index >= s.length) return 0;
  if (
    index + 1 < s.length
    && isHighSurrogate(s.charCodeAt(index))
    && isLowSurrogate(s.charCodeAt(index + 1))
  ) {
    return 2;
  }
  return 1;
}

/**
 * Hard-wrap one newline-free line to `maxWidth` display columns, breaking
 * anywhere (terminal-style) and measuring with `stringWidth` so wide glyphs
 * count as two columns. Content is never dropped: a wide glyph that does
 * not fit still starts the next segment, and an empty line yields `['']`.
 */
export function wrapByDisplayWidth(line: string, maxWidth: number): string[] {
  const limit = Math.max(1, Math.floor(maxWidth));
  if (stringWidth(line) <= limit) return [line];

  const segments: string[] = [];
  let current = '';
  let width = 0;
  for (const ch of line) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (current !== '' && width + cw > limit) {
      segments.push(current);
      current = ch;
      width = cw;
    } else {
      current += ch;
      width += cw;
    }
  }
  if (current !== '') segments.push(current);
  return segments.length > 0 ? segments : [''];
}

/**
 * Map `value` + `cursor` onto visual lines that each fit `maxWidth`
 * display columns, and locate the cursor block.
 *
 * Cursor ownership: index `cursor` counts code units before the cursor, so
 * the index of a `'\n'` belongs to the line that `'\n'` ends (block at end
 * of that line) while the following index belongs to the next line's start.
 */
export function layoutInput(value: string, cursor: number, maxWidth: number): InputLayout {
  const c = Math.max(0, Math.min(value.length, cursor));
  const logicalLines = value.split('\n');

  const lines: InputDisplayLine[] = [];
  let cursorLine = 0;
  let cursorCol = 0;
  let offset = 0;

  for (const lineText of logicalLines) {
    const col = c - offset; // code-unit column within this logical line
    const ownsCursor = col >= 0 && col <= lineText.length;
    const segments = wrapByDisplayWidth(lineText, maxWidth);

    for (const segment of segments) {
      lines.push({ text: segment, offset });
      offset += segment.length;
    }

    if (ownsCursor) {
      // Find the visual segment holding `col`; a col equal to a non-final
      // segment's end is a wrap boundary and belongs to the next segment.
      let base = 0;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segEnd = base + segment.length;
        const isLastSegment = i === segments.length - 1;
        if (col < segEnd || (col === segEnd && isLastSegment)) {
          cursorLine = lines.length - segments.length + i;
          cursorCol = col - base;
          break;
        }
        base = segEnd;
      }
    }

    offset += 1; // the '\n' that ended this logical line
  }

  return { lines, cursorLine, cursorCol };
}
