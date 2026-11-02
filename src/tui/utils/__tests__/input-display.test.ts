import { describe, it, expect } from 'vitest';
import {
  layoutInput,
  nextCodePointLength,
  normalizeInputText,
  prevCodePointLength,
  wrapByDisplayWidth,
} from '@/tui/utils/input-display';

// --- newline normalization ---

describe('normalizeInputText', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeInputText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('normalizes a terminal CR paste into real newlines', () => {
    expect(normalizeInputText('line1\rline2\rline3')).toBe('line1\nline2\nline3');
  });

  it('leaves plain and wide-character text untouched', () => {
    expect(normalizeInputText('hello 世界\n👍')).toBe('hello 世界\n👍');
  });
});

// --- surrogate-aware cursor stepping ---

describe('prevCodePointLength / nextCodePointLength', () => {
  it('steps one code unit for BMP characters', () => {
    expect(prevCodePointLength('abc', 2)).toBe(1);
    expect(nextCodePointLength('abc', 1)).toBe(1);
  });

  it('steps two code units across an emoji surrogate pair', () => {
    const s = 'a👍b'; // 👍 occupies code units 1..2
    expect(prevCodePointLength(s, 3)).toBe(2); // before 'b': skip the whole pair
    expect(nextCodePointLength(s, 1)).toBe(2); // at the pair start: skip the whole pair
    expect(prevCodePointLength(s, 1)).toBe(1);
    expect(nextCodePointLength(s, 3)).toBe(1);
  });

  it('returns 0 at the string boundaries', () => {
    expect(prevCodePointLength('abc', 0)).toBe(0);
    expect(nextCodePointLength('abc', 3)).toBe(0);
    expect(nextCodePointLength('', 0)).toBe(0);
  });
});

// --- display-width wrapping ---

describe('wrapByDisplayWidth', () => {
  it('returns the line as one segment when it fits', () => {
    expect(wrapByDisplayWidth('abc', 10)).toEqual(['abc']);
  });

  it('returns one empty segment for an empty line', () => {
    expect(wrapByDisplayWidth('', 10)).toEqual(['']);
  });

  it('hard-wraps long ASCII lines at the budget', () => {
    expect(wrapByDisplayWidth('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('measures CJK glyphs as two columns', () => {
    // 5 CJK glyphs = 10 columns, budget 9 → 4 glyphs (8 cols) + 1 glyph
    expect(wrapByDisplayWidth('一二三四五', 9)).toEqual(['一二三四', '五']);
  });

  it('moves a wide glyph that would straddle the boundary to the next segment', () => {
    expect(wrapByDisplayWidth('aaaa中', 5)).toEqual(['aaaa', '中']);
  });

  it('never drops a glyph wider than the budget', () => {
    expect(wrapByDisplayWidth('中', 1)).toEqual(['中']);
  });

  it('preserves all content across segments', () => {
    const s = `abc${'x'.repeat(50)}中文👍tail`;
    expect(wrapByDisplayWidth(s, 7).join('')).toBe(s);
  });
});

// --- value + cursor layout ---

describe('layoutInput', () => {
  it('splits pasted multi-line text into one row per line', () => {
    const layout = layoutInput('line1\nline2\nline3', 17, 36);
    expect(layout.lines.map(l => l.text)).toEqual(['line1', 'line2', 'line3']);
    expect(layout.lines.map(l => l.offset)).toEqual([0, 6, 12]);
  });

  it('puts the cursor at the end of the last line for a full paste', () => {
    const layout = layoutInput('line1\nline2\nline3', 17, 36);
    expect(layout.cursorLine).toBe(2);
    expect(layout.cursorCol).toBe(5); // === text.length → trailing block
  });

  it('places the cursor in the middle of a line', () => {
    const layout = layoutInput('line1\nline2\nline3', 8, 36); // on 'n' of line2
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorCol).toBe(2);
  });

  it('keeps a cursor sitting on a newline at the end of that line', () => {
    const layout = layoutInput('line1\nline2', 5, 36); // on the '\n'
    expect(layout.cursorLine).toBe(0);
    expect(layout.cursorCol).toBe(5); // trailing block on line 1
  });

  it('treats the start of a line as distinct from the previous newline', () => {
    const layout = layoutInput('ab\ncd', 3, 36); // before 'c'
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorCol).toBe(0);
  });

  it('handles the empty value', () => {
    const layout = layoutInput('', 0, 36);
    expect(layout.lines).toEqual([{ text: '', offset: 0 }]);
    expect(layout.cursorLine).toBe(0);
    expect(layout.cursorCol).toBe(0);
  });

  it('keeps a trailing newline as its own empty row', () => {
    const layout = layoutInput('ab\n', 3, 36);
    expect(layout.lines.map(l => l.text)).toEqual(['ab', '']);
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorCol).toBe(0);
  });

  it('wraps long lines and maps the cursor onto the wrapped row', () => {
    const layout = layoutInput('x'.repeat(80), 40, 36);
    expect(layout.lines.map(l => l.text.length)).toEqual([36, 36, 8]);
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorCol).toBe(4);
  });

  it('maps a cursor at a wrap boundary to the start of the next row', () => {
    const layout = layoutInput('x'.repeat(40), 36, 36);
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorCol).toBe(0);
  });

  it('wraps CJK lines by display width', () => {
    const value = '一二三四五六七八九十'.repeat(2); // 20 glyphs = 40 columns
    const layout = layoutInput(value, value.length, 36);
    expect(layout.lines.map(l => l.text)).toEqual([
      '一二三四五六七八九十'.repeat(2).slice(0, 18), // 18 glyphs = 36 cols
      '九十',
    ]);
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorCol).toBe(2);
  });

  it('clamps an out-of-range cursor to the end of the value', () => {
    const layout = layoutInput('abc', 99, 36);
    expect(layout.cursorLine).toBe(0);
    expect(layout.cursorCol).toBe(3);
  });
});
