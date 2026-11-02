import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { render } from 'ink';
import { InputArea } from '@/tui/components/input-area';

interface HarnessOptions {
  width?: number;
  busy?: boolean;
}

/**
 * Render InputArea with a fake TTY stdin (modeled on the inquiry-prompt
 * harness) and drive it with raw key sequences: plain text chunks double as
 * typed characters and pasted text, '\r' = return, '\x7f' = backspace,
 * '\x1b[D' = left arrow.
 */
function renderInteractive(options: HarnessOptions = {}) {
  const { width = 40, busy = false } = options;
  const submitted: string[] = [];
  let frame = '';
  const stdout = {
    columns: width,
    rows: 200,
    write: (s: string) => { if (s.trim()) frame = s; return true; },
    on() { return stdout; },
    off() { return stdout; },
    removeListener() { return stdout; },
  };
  const readableListeners: Array<() => void> = [];
  const pending: string[] = [];
  const stdin = {
    isTTY: true,
    setEncoding() { /* noop */ },
    setRawMode() { /* noop */ },
    ref() { /* noop */ },
    unref() { /* noop */ },
    read: () => pending.shift() ?? null,
    on(evt: string, fn: () => void) { return stdin.addListener(evt, fn); },
    addListener(evt: string, fn: () => void) {
      if (evt === 'readable') readableListeners.push(fn);
      return stdin;
    },
    removeListener(evt: string, fn: () => void) {
      if (evt === 'readable') {
        const i = readableListeners.indexOf(fn);
        if (i >= 0) readableListeners.splice(i, 1);
      }
      return stdin;
    },
  };
  const app = render(
    h(InputArea, {
      onSubmit: (input: string) => submitted.push(input),
      onExit: () => {},
      busy,
      width,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
    },
  );
  return {
    frame: () => frame,
    submitted,
    send(data: string) {
      pending.push(data);
      for (const fn of [...readableListeners]) fn();
    },
    unmount: () => app.unmount(),
  };
}

/** Strip ANSI escape sequences (colors, inverse, cursor moves). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Frame rows that carry input content (between the box borders). */
function contentRows(rawFrame: string): string[] {
  return stripAnsi(rawFrame)
    .split('\n')
    .filter(line => !line.startsWith('─') && line.trim() !== '');
}

/** Content rows with leading prompt/gutter whitespace removed. */
function rowTexts(rawFrame: string): string[] {
  return contentRows(rawFrame).map(row => row.replace(/^[\s→]+/, ''));
}

/** Let React flush effects and commits between keystrokes. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function drive(keys: string[], options: HarnessOptions = {}) {
  const r = renderInteractive(options);
  try {
    await flush();
    for (const k of keys) {
      r.send(k);
      await flush();
    }
    return r;
  } catch (err) {
    r.unmount();
    throw err;
  }
}

describe('InputArea multi-line paste rendering', () => {
  it('renders a pasted 3-line text as three rows', async () => {
    const r = await drive(['line1\nline2\nline3']);
    try {
      expect(rowTexts(r.frame())).toEqual(['line1', 'line2', 'line3']);
    } finally {
      r.unmount();
    }
  });

  it('normalizes CR and CRLF pastes into real lines', async () => {
    const r = await drive(['line1\rline2\rline3']);
    try {
      expect(r.frame()).not.toContain('\r');
      expect(rowTexts(r.frame())).toEqual(['line1', 'line2', 'line3']);
    } finally {
      r.unmount();
    }

    const r2 = await drive(['a\r\nb\r\nc']);
    try {
      expect(r2.frame()).not.toContain('\r');
      expect(rowTexts(r2.frame())).toEqual(['a', 'b', 'c']);
    } finally {
      r2.unmount();
    }
  });

  it('renders CJK paste as one row per line', async () => {
    const r = await drive(['第一行\n第二行\n第三行']);
    try {
      expect(rowTexts(r.frame())).toEqual(['第一行', '第二行', '第三行']);
    } finally {
      r.unmount();
    }
  });

  it('wraps a long pasted line by display width without losing content', async () => {
    // width 40 → budget 36 columns; 75 chars → rows of 36, 36, 3
    const text = 'a'.repeat(75);
    const r = await drive([text]);
    try {
      const rows = rowTexts(r.frame()).map(row => row.replace(/\s+$/, ''));
      expect(rows).toEqual(['a'.repeat(36), 'a'.repeat(36), 'a'.repeat(3)]);
      expect(rows.join('')).toBe(text);
    } finally {
      r.unmount();
    }
  });

  it('wraps long CJK lines by display width, not character count', async () => {
    // 20 CJK glyphs = 40 columns → rows of 18 glyphs (36 cols) and 2 glyphs
    const text = '一二三四五六七八九十'.repeat(2);
    const r = await drive([text]);
    try {
      expect(rowTexts(r.frame())).toEqual([
        '一二三四五六七八九十'.repeat(2).slice(0, 18),
        '九十',
      ]);
    } finally {
      r.unmount();
    }
  });

  it('keeps rows intact when the cursor moves into the middle of pasted text', async () => {
    // cursor 17 → 8 (inside "line2")
    const r = await drive(['line1\nline2\nline3', ...Array(9).fill('\x1b[D')]);
    try {
      expect(rowTexts(r.frame())).toEqual(['line1', 'line2', 'line3']);
    } finally {
      r.unmount();
    }
  });

  it('keeps rows intact when the cursor sits on a newline', async () => {
    // cursor 17 → 11 (the '\n' after "line2")
    const r = await drive(['line1\nline2\nline3', ...Array(6).fill('\x1b[D')]);
    try {
      expect(rowTexts(r.frame())).toEqual(['line1', 'line2', 'line3']);
    } finally {
      r.unmount();
    }
  });

  it('renders a paste with an empty line as an empty row', async () => {
    const r = await drive(['a\n\nb']);
    try {
      const rows = stripAnsi(r.frame()).split('\n');
      const a = rows.findIndex(row => row.includes('a'));
      const b = rows.findIndex(row => row.includes('b'));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThan(a);
      // the row between the two content rows is blank apart from the gutter
      expect(rows[a + 1].trim()).toBe('');
    } finally {
      r.unmount();
    }
  });

  it('does not split an emoji when moving the cursor left', async () => {
    // value "hi👍" (cursor 4) → left, left lands before the surrogate pair
    const r = await drive(['hi👍', '\x1b[D', '\x1b[D']);
    try {
      expect(rowTexts(r.frame()).join('')).toContain('hi👍');
    } finally {
      r.unmount();
    }
  });

  it('deletes a whole emoji with one backspace', async () => {
    // value "a👍" → backspace removes the pair, leaving "a"
    const r = await drive(['a👍', '\x7f']);
    try {
      expect(rowTexts(r.frame())).toEqual(['a']);
    } finally {
      r.unmount();
    }
  });

  it('inserts a multi-line paste at the cursor, not only at the end', async () => {
    // type "ab", move left, paste "X\nY" → rows "aX" / "Yb"
    const r = await drive(['ab', '\x1b[D', 'X\nY']);
    try {
      expect(rowTexts(r.frame())).toEqual(['aX', 'Yb']);
    } finally {
      r.unmount();
    }
  });
});

describe('InputArea submission', () => {
  it('submits multi-line content intact on Enter and resets', async () => {
    const r = await drive(['line1\nline2\nline3', '\r']);
    try {
      expect(r.submitted).toEqual(['line1\nline2\nline3']);
      expect(rowTexts(r.frame())).toEqual(['']);
    } finally {
      r.unmount();
    }
  });

  it('submits CR-pasted content with normalized newlines', async () => {
    const r = await drive(['one\rtwo\rthree', '\r']);
    try {
      expect(r.submitted).toEqual(['one\ntwo\nthree']);
    } finally {
      r.unmount();
    }
  });

  it('submits CJK multi-line content intact', async () => {
    const r = await drive(['第一行\n第二行', '\r']);
    try {
      expect(r.submitted).toEqual(['第一行\n第二行']);
    } finally {
      r.unmount();
    }
  });

  it('still submits single-line typing', async () => {
    const r = await drive(['h', 'e', 'l', 'l', 'o', '\r']);
    try {
      expect(r.submitted).toEqual(['hello']);
    } finally {
      r.unmount();
    }
  });
});

describe('InputArea busy indicator', () => {
  it('shows the thinking note on the cursor row of multi-line input', async () => {
    const r = await drive(['a\nb'], { busy: true });
    try {
      const frame = stripAnsi(r.frame());
      expect(frame).toContain('a');
      expect(frame).toContain('b');
      expect(frame).toContain('(thinking...)');
      // the note rides on the last content row, not on its own stray line
      expect(rowTexts(r.frame()).some(row => row.endsWith('(thinking...)'))).toBe(true);
    } finally {
      r.unmount();
    }
  });
});
