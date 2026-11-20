import { describe, it, expect } from 'vitest';
import {
  clampIndex,
  killToLineEnd,
  killToLineStart,
  killWordBefore,
  lineEnd,
  lineStart,
  normalizeSelection,
  replaceRange,
  wordLeft,
  wordRight,
} from '@/tui/utils/input-editing';

// --- index clamping ---

describe('clampIndex', () => {
  it('clamps below zero and past the end', () => {
    expect(clampIndex('abc', -1)).toBe(0);
    expect(clampIndex('abc', 5)).toBe(3);
  });

  it('passes through in-range indices', () => {
    expect(clampIndex('abc', 0)).toBe(0);
    expect(clampIndex('abc', 2)).toBe(2);
    expect(clampIndex('abc', 3)).toBe(3);
  });

  it('clamps everything to 0 on an empty value', () => {
    expect(clampIndex('', 0)).toBe(0);
    expect(clampIndex('', 7)).toBe(0);
  });
});

// --- selection normalization ---

describe('normalizeSelection', () => {
  it('treats a null anchor as an empty selection at the cursor', () => {
    expect(normalizeSelection('hello', null, 2)).toEqual({ start: 2, end: 2 });
  });

  it('treats anchor === cursor as an empty selection', () => {
    expect(normalizeSelection('hello', 3, 3)).toEqual({ start: 3, end: 3 });
  });

  it('orders a reversed selection (anchor after cursor)', () => {
    expect(normalizeSelection('hello', 4, 1)).toEqual({ start: 1, end: 4 });
  });

  it('keeps a forward selection as-is', () => {
    expect(normalizeSelection('hello', 1, 4)).toEqual({ start: 1, end: 4 });
  });

  it('clamps out-of-range anchor and cursor', () => {
    expect(normalizeSelection('abc', 10, -2)).toEqual({ start: 0, end: 3 });
  });

  it('snaps boundaries that split a surrogate pair outward to whole code points', () => {
    // 'a👍b': the emoji occupies code units 1..2, so index 2 splits the pair.
    expect(normalizeSelection('a👍b', 1, 2)).toEqual({ start: 1, end: 3 });
    expect(normalizeSelection('a👍b', 2, 1)).toEqual({ start: 1, end: 3 });
    expect(normalizeSelection('a👍b', null, 2)).toEqual({ start: 3, end: 3 });
  });
});

// --- word motion ---

describe('wordLeft / wordRight', () => {
  it('steps CJK one character at a time and Latin words whole (你好 world foo)', () => {
    // 你0 好1 ' '2 w3..d7 ' '8 f9..o11
    expect(wordRight('你好 world foo', 0)).toBe(1);
    expect(wordRight('你好 world foo', 1)).toBe(2);
    expect(wordRight('你好 world foo', 2)).toBe(8);
    expect(wordRight('你好 world foo', 8)).toBe(12);

    expect(wordLeft('你好 world foo', 12)).toBe(9);
    expect(wordLeft('你好 world foo', 9)).toBe(3);
    expect(wordLeft('你好 world foo', 3)).toBe(1);
    expect(wordLeft('你好 world foo', 1)).toBe(0);
  });

  it('locks the CJK-per-character behavior mid-run (foo这是bar)', () => {
    // f0 o1 o2 这3 是4 b5 a6 r7
    expect(wordRight('foo这是bar', 0)).toBe(3);
    expect(wordRight('foo这是bar', 3)).toBe(4);
    expect(wordRight('foo这是bar', 4)).toBe(5);
    expect(wordRight('foo这是bar', 5)).toBe(8);

    expect(wordLeft('foo这是bar', 8)).toBe(5);
    expect(wordLeft('foo这是bar', 5)).toBe(4);
    expect(wordLeft('foo这是bar', 4)).toBe(3);
    expect(wordLeft('foo这是bar', 3)).toBe(0);
  });

  it('locks per-character CJK against run-based Latin (中文abc)', () => {
    // 中0 文1 a2 b3 c4
    expect(wordLeft('中文abc', 3)).toBe(2); // start of "abc", not past 文
    expect(wordLeft('中文abc', 2)).toBe(1); // one CJK char
    expect(wordRight('中文abc', 1)).toBe(2);
    expect(wordRight('中文abc', 2)).toBe(5); // whole "abc"
  });

  it('skips ASCII punctuation transparently (hello, world!)', () => {
    // h0..o4 ','5 ' '6 w7..d11 '!'12
    expect(wordRight('hello, world!', 0)).toBe(5);
    expect(wordRight('hello, world!', 5)).toBe(12);
    expect(wordRight('hello, world!', 12)).toBe(13);

    expect(wordLeft('hello, world!', 13)).toBe(7);
    expect(wordLeft('hello, world!', 7)).toBe(0);
    expect(wordLeft('hello, world!', 5)).toBe(0);
  });

  it('treats CJK/fullwidth punctuation as a separator (你好，世界)', () => {
    // 你0 好1 '，'2 世3 界4
    expect(wordRight('你好，世界', 2)).toBe(4);
    expect(wordLeft('你好，世界', 5)).toBe(4);
    expect(wordLeft('你好，世界', 3)).toBe(1); // skips the comma, one CJK char
  });

  it('keeps underscore inside a word (foo_bar baz)', () => {
    expect(wordRight('foo_bar baz', 0)).toBe(7);
    expect(wordLeft('foo_bar baz', 7)).toBe(0);
  });

  it('crosses line breaks: newline is just a separator (foo\\nbar)', () => {
    // f0 o1 o2 '\n'3 b4 a5 r6
    expect(wordRight('foo\nbar', 3)).toBe(7);
    expect(wordLeft('foo\nbar', 4)).toBe(0);
    expect(wordLeft('foo\nbar', 7)).toBe(4);
    expect(wordRight('foo\nbar', 0)).toBe(3);
  });

  it('is a no-op at the string boundaries', () => {
    expect(wordLeft('foo', 0)).toBe(0);
    expect(wordRight('foo', 3)).toBe(3);
    expect(wordLeft('', 0)).toBe(0);
    expect(wordRight('', 0)).toBe(0);
  });

  it('skips a separators-only string entirely', () => {
    expect(wordLeft(' , , ', 5)).toBe(0);
    expect(wordRight(' , , ', 0)).toBe(5);
  });

  it('treats an emoji as its own word unit (hi 👍!!)', () => {
    // h0 i1 ' '2 👍3..4 '!'5 '!'6
    expect(wordRight('hi 👍!!', 0)).toBe(2);
    expect(wordRight('hi 👍!!', 2)).toBe(5);
    expect(wordRight('hi 👍!!', 5)).toBe(7);
    expect(wordLeft('hi 👍!!', 7)).toBe(3);
    expect(wordLeft('hi 👍!!', 5)).toBe(3);
    expect(wordLeft('hi 👍!!', 3)).toBe(0);
  });

  it('never returns an index that splits a surrogate pair', () => {
    // 'a👍b': possible results are only 0, 1, 3, 4 — never 2.
    expect(wordLeft('a👍b', 4)).toBe(0);
    expect(wordLeft('a👍b', 3)).toBe(0);
    expect(wordLeft('a👍b', 2)).toBe(0); // mid-pair input: normalized first
    expect(wordRight('a👍b', 0)).toBe(4);
    expect(wordRight('a👍b', 1)).toBe(4); // mid-pair input
    // A run of emoji is one word: both pairs skipped whole.
    expect(wordLeft('👍👍', 4)).toBe(0);
  });
});

// --- line motion ---

describe('lineStart / lineEnd', () => {
  it('single line: whole string regardless of cursor', () => {
    expect(lineStart('abc', 1)).toBe(0);
    expect(lineStart('abc', 3)).toBe(0);
    expect(lineEnd('abc', 0)).toBe(3);
    expect(lineEnd('abc', 2)).toBe(3);
  });

  it('multi-line: each logical line bounded by newlines', () => {
    // a0 b1 '\n'2 c3 d4 '\n'5 e6 f7
    const v = 'ab\ncd\nef';
    expect(lineStart(v, 0)).toBe(0);
    expect(lineStart(v, 1)).toBe(0);
    expect(lineStart(v, 3)).toBe(3);
    expect(lineStart(v, 6)).toBe(6);
    expect(lineStart(v, 8)).toBe(6); // end of value still belongs to last line

    expect(lineEnd(v, 0)).toBe(2);
    expect(lineEnd(v, 1)).toBe(2);
    expect(lineEnd(v, 3)).toBe(5);
    expect(lineEnd(v, 6)).toBe(8);
    expect(lineEnd(v, 8)).toBe(8);
  });

  it('cursor on a newline belongs to the line it ends', () => {
    const v = 'ab\ncd\nef';
    expect(lineStart(v, 2)).toBe(0); // on the first '\n'
    expect(lineEnd(v, 2)).toBe(2); // ...and the '\n' is not part of the line
    expect(lineStart(v, 5)).toBe(3); // on the second '\n'
    expect(lineEnd(v, 5)).toBe(5);
  });

  it('empty line between newlines collapses to a point', () => {
    // a0 '\n'1 '\n'2 b3
    const v = 'a\n\nb';
    expect(lineStart(v, 2)).toBe(2);
    expect(lineEnd(v, 2)).toBe(2);
    expect(lineStart(v, 3)).toBe(3);
    expect(lineEnd(v, 1)).toBe(1);
  });

  it('handles the empty value and out-of-range indices', () => {
    expect(lineStart('', 0)).toBe(0);
    expect(lineEnd('', 0)).toBe(0);
    expect(lineStart('ab', 99)).toBe(0);
    expect(lineEnd('ab', -1)).toBe(2);
  });
});

// --- kill to line end / start ---

describe('killToLineEnd', () => {
  it('deletes to the newline but keeps the newline', () => {
    expect(killToLineEnd('ab\ncd', 0)).toEqual({ value: '\ncd', cursor: 0 });
  });

  it('is a no-op when the cursor is already at the line end (on the newline)', () => {
    expect(killToLineEnd('ab\ncd', 2)).toEqual({ value: 'ab\ncd', cursor: 2 });
  });

  it('kills only the tail of the current line in a multi-line value', () => {
    // a0 b1 c2 '\n'3 d4 e5 f6 '\n'7 ...
    expect(killToLineEnd('abc\ndef\nghi', 5)).toEqual({
      value: 'abc\nd\nghi',
      cursor: 5,
    });
  });

  it('is a no-op at the end of the value (also with out-of-range index)', () => {
    expect(killToLineEnd('abc', 3)).toEqual({ value: 'abc', cursor: 3 });
    expect(killToLineEnd('abc', 99)).toEqual({ value: 'abc', cursor: 3 });
  });

  it('never splits a surrogate pair when given a mid-pair index', () => {
    // x0 👍1..2 y3 z4 '\n'5 k6 — index 2 splits the emoji.
    expect(killToLineEnd('x👍yz\nk', 2)).toEqual({ value: 'x👍\nk', cursor: 3 });
  });
});

describe('killToLineStart', () => {
  it('deletes the head of the current line and lands on the line start', () => {
    expect(killToLineStart('ab\ncd', 1)).toEqual({ value: 'b\ncd', cursor: 0 });
  });

  it('cursor on the newline kills the whole line above it, keeping the newline', () => {
    expect(killToLineStart('ab\ncd', 2)).toEqual({ value: '\ncd', cursor: 0 });
  });

  it('kills the middle line in a multi-line value', () => {
    // a0 b1 c2 '\n'3 d4 e5 f6 '\n'7 — cursor on the second '\n'.
    expect(killToLineStart('abc\ndef\nghi', 7)).toEqual({
      value: 'abc\n\nghi',
      cursor: 4,
    });
  });

  it('is a no-op at the line start (also with out-of-range index)', () => {
    expect(killToLineStart('ab\ncd', 3)).toEqual({ value: 'ab\ncd', cursor: 3 });
    expect(killToLineStart('abc', -5)).toEqual({ value: 'abc', cursor: 0 });
  });
});

// --- kill word before ---

describe('killWordBefore', () => {
  it('deletes the previous word and the separators before it', () => {
    expect(killWordBefore('foo bar', 7)).toEqual({ value: 'foo ', cursor: 4 });
    expect(killWordBefore('foo bar', 4)).toEqual({ value: 'bar', cursor: 0 });
  });

  it('crosses a line break: the newline dies with the word above it', () => {
    expect(killWordBefore('foo\nbar', 4)).toEqual({ value: 'bar', cursor: 0 });
  });

  it('kills only the current word when the line continues', () => {
    // f0 o1 o2 '\n'3 b4 a5 r6 ' '7 ...
    expect(killWordBefore('foo\nbar baz', 8)).toEqual({
      value: 'foo\nbaz',
      cursor: 4,
    });
  });

  it('takes punctuation before the word with it (readline behavior)', () => {
    expect(killWordBefore('hello, world', 7)).toEqual({
      value: 'world',
      cursor: 0,
    });
  });

  it('deletes exactly one CJK character per call', () => {
    // 你0 好1 ' '2 世3 界4
    expect(killWordBefore('你好 世界', 5)).toEqual({ value: '你好 世', cursor: 4 });
    expect(killWordBefore('你好 世界', 3)).toEqual({ value: '你世界', cursor: 1 });
  });

  it('is a no-op at the very start (including the empty value)', () => {
    expect(killWordBefore('foo', 0)).toEqual({ value: 'foo', cursor: 0 });
    expect(killWordBefore('', 0)).toEqual({ value: '', cursor: 0 });
  });

  it('deletes a whole emoji, even from a mid-pair index', () => {
    // a0 b1 👍2..3 ' '4 c5 d6
    expect(killWordBefore('ab👍 cd', 5)).toEqual({ value: 'cd', cursor: 0 });
    // '👍' occupies 0..1; index 1 splits it and is normalized to 2 first.
    expect(killWordBefore('👍ab', 1)).toEqual({ value: 'ab', cursor: 0 });
  });
});

// --- range splicing ---

describe('replaceRange', () => {
  it('replaces a range and places the cursor after the insert', () => {
    expect(replaceRange('hello world', 0, 5, 'goodbye')).toEqual({
      value: 'goodbye world',
      cursor: 7,
    });
  });

  it('inserts when start === end', () => {
    expect(replaceRange('ab', 1, 1, 'X')).toEqual({ value: 'aXb', cursor: 2 });
  });

  it('deletes when the insert is empty', () => {
    expect(replaceRange('abcd', 1, 3, '')).toEqual({ value: 'ad', cursor: 1 });
  });

  it('order-normalizes reversed bounds', () => {
    expect(replaceRange('abcd', 3, 1, 'X')).toEqual({ value: 'aXd', cursor: 2 });
  });

  it('clamps out-of-range bounds', () => {
    expect(replaceRange('abc', -5, 99, 'X')).toEqual({ value: 'X', cursor: 1 });
  });

  it('removes an emoji whole when the range covers it', () => {
    expect(replaceRange('a👍b', 1, 3, '')).toEqual({ value: 'ab', cursor: 1 });
  });
});
