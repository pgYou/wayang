import { describe, it, expect } from 'vitest';
import {
  layoutInput,
  nextCodePointLength,
  normalizeInputText,
  prevCodePointLength,
  splitLineBySelection,
  wrapByDisplayWidth,
} from '@/tui/utils/input-display';
import { stringWidth } from '@/tui/utils/text-width';

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

// --- selection segmentation ---

describe('splitLineBySelection', () => {
  const line = (text: string, offset = 0) => ({ text, offset });

  it('leaves the line unselected for an empty selection', () => {
    expect(splitLineBySelection(line('hello'), { start: 2, end: 2 })).toEqual([
      { text: 'hello', selected: false },
    ]);
  });

  it('leaves the line unselected when the selection does not reach it', () => {
    expect(splitLineBySelection(line('hello', 10), { start: 0, end: 5 })).toEqual([
      { text: 'hello', selected: false },
    ]);
  });

  it('returns one selected segment for a fully covered line', () => {
    expect(splitLineBySelection(line('hello'), { start: 0, end: 5 })).toEqual([
      { text: 'hello', selected: true },
    ]);
    // A selection wider than the line clamps to it on both sides.
    expect(splitLineBySelection(line('hello'), { start: 0, end: 99 })).toEqual([
      { text: 'hello', selected: true },
    ]);
  });

  it('splits a partial selection into before / selected / after', () => {
    expect(splitLineBySelection(line('hello'), { start: 1, end: 3 })).toEqual([
      { text: 'h', selected: false },
      { text: 'el', selected: true },
      { text: 'lo', selected: false },
    ]);
  });

  it('drops the empty edge segments instead of emitting empty text', () => {
    expect(splitLineBySelection(line('hello'), { start: 0, end: 2 })).toEqual([
      { text: 'he', selected: true },
      { text: 'llo', selected: false },
    ]);
    expect(splitLineBySelection(line('hello'), { start: 2, end: 5 })).toEqual([
      { text: 'he', selected: false },
      { text: 'llo', selected: true },
    ]);
  });

  it('has no trailing segment when the selection ends at the line end', () => {
    expect(splitLineBySelection(line('hello'), { start: 3, end: 5 })).toEqual([
      { text: 'hel', selected: false },
      { text: 'lo', selected: true },
    ]);
  });

  describe('wrap boundaries', () => {
    // budget 4 → rows 'abcd' | 'efgh' | 'ij' at offsets 0 / 4 / 8
    const { lines } = layoutInput('abcdefghij', 0, 4);

    it('starts the later row at column 0 when the selection starts on the boundary', () => {
      expect(lines.map(l => l.text)).toEqual(['abcd', 'efgh', 'ij']);
      expect(splitLineBySelection(lines[0], { start: 4, end: 6 })).toEqual([
        { text: 'abcd', selected: false },
      ]);
      expect(splitLineBySelection(lines[1], { start: 4, end: 6 })).toEqual([
        { text: 'ef', selected: true },
        { text: 'gh', selected: false },
      ]);
    });

    it('selects the earlier row up to its last character when the selection ends on the boundary', () => {
      expect(splitLineBySelection(lines[0], { start: 2, end: 4 })).toEqual([
        { text: 'ab', selected: false },
        { text: 'cd', selected: true },
      ]);
      expect(splitLineBySelection(lines[1], { start: 2, end: 4 })).toEqual([
        { text: 'efgh', selected: false },
      ]);
    });

    it('never highlights the same index on two rows', () => {
      const selected = lines
        .flatMap(l => splitLineBySelection(l, { start: 4, end: 5 }))
        .filter(seg => seg.selected)
        .map(seg => seg.text);
      expect(selected).toEqual(['e']);
    });
  });

  describe('logical lines', () => {
    // 'ab\ncd' → 'ab' at offset 0, 'cd' at offset 3, '\n' at index 2
    const { lines } = layoutInput('ab\ncd', 0, 36);

    it('selects every row through its end when the selection spans the newline', () => {
      expect(lines.map(l => l.text)).toEqual(['ab', 'cd']);
      expect(splitLineBySelection(lines[0], { start: 0, end: 5 })).toEqual([
        { text: 'ab', selected: true },
      ]);
      expect(splitLineBySelection(lines[1], { start: 0, end: 5 })).toEqual([
        { text: 'cd', selected: true },
      ]);
    });

    it('leaves the next row unselected when the selection ends on the newline', () => {
      expect(splitLineBySelection(lines[0], { start: 0, end: 2 })).toEqual([
        { text: 'ab', selected: true },
      ]);
      expect(splitLineBySelection(lines[1], { start: 0, end: 2 })).toEqual([
        { text: 'cd', selected: false },
      ]);
    });
  });

  describe('wide and surrogate glyphs', () => {
    it('slices CJK text without changing its display width', () => {
      const segments = splitLineBySelection(line('你好世界'), { start: 1, end: 3 });
      expect(segments).toEqual([
        { text: '你', selected: false },
        { text: '好世', selected: true },
        { text: '界', selected: false },
      ]);
      const selected = segments.find(seg => seg.selected);
      expect(selected?.text).toBe('好世');
      expect(stringWidth(selected?.text ?? '')).toBe(4);
    });

    it('keeps a surrogate pair in one segment', () => {
      expect(splitLineBySelection(line('a😀b'), { start: 1, end: 3 })).toEqual([
        { text: 'a', selected: false },
        { text: '😀', selected: true },
        { text: 'b', selected: false },
      ]);
      // Selecting the whole value, emoji included, stays one segment.
      expect(splitLineBySelection(line('a😀b'), { start: 0, end: 4 })).toEqual([
        { text: 'a😀b', selected: true },
      ]);
    });
  });

  it('always rejoins to the original line text', () => {
    const l = line('hello world');
    for (let start = 0; start <= 11; start++) {
      for (let end = start; end <= 11; end++) {
        const segments = splitLineBySelection(l, { start, end });
        expect(segments.map(seg => seg.text).join('')).toBe(l.text);
        expect(segments.every(seg => !seg.text.includes('\n'))).toBe(true);
      }
    }
  });
});
