import { afterAll, describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { render } from 'ink';
import { InputArea } from '@/tui/components/input-area';
import { stringWidth } from '@/tui/utils/text-width';

// Selection highlighting is reverse video, which Ink only emits when chalk
// has colors enabled — force a color level so the frames carry `inverse`.
// Runs before `ink` (and its chalk) is imported; other suites strip ANSI.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

// Ink's chalk reads the environment when it loads, so the level is already
// fixed for this file; clear the variable so a later file in the same worker
// renders without styles as before.
afterAll(() => {
  delete process.env.FORCE_COLOR;
});

interface HarnessOptions {
  width?: number;
  busy?: boolean;
  onEscape?: () => void;
  /** Ink's own Ctrl-C exit; off to observe what InputArea does with the key. */
  exitOnCtrlC?: boolean;
}

/** Shift+Left / Shift+Right, as terminals send them (xterm modified cursors). */
const SHIFT_LEFT = '\x1b[1;2D';
const SHIFT_RIGHT = '\x1b[1;2C';

/** Ctrl+letter arrives as the control code (Ctrl-A = 0x01 … Ctrl-Z = 0x1a). */
const CTRL_A = '\x01';
const CTRL_C = '\x03';
const CTRL_E = '\x05';
const CTRL_K = '\x0b';
const CTRL_U = '\x15';
const CTRL_W = '\x17';
const CTRL_Y = '\x19';
const CTRL_Z = '\x1a';

/** Ctrl+Left / Ctrl+Right / Ctrl+Shift+Left (xterm modifier 5 / 6 = ctrl / ctrl+shift). */
const CTRL_LEFT = '\x1b[1;5D';
const CTRL_RIGHT = '\x1b[1;5C';
const CTRL_SHIFT_LEFT = '\x1b[1;6D';

/** Alt+B / Alt+F — an ESC prefix plus the letter. */
const ALT_B = '\x1bb';
const ALT_F = '\x1bf';

/**
 * Render InputArea with a fake TTY stdin (modeled on the inquiry-prompt
 * harness) and drive it with raw key sequences: plain text chunks double as
 * typed characters and pasted text, '\r' = return, '\x7f' = backspace,
 * '\x1b[D' = left arrow, '\x1b[1;2D' = Shift+Left.
 */
function renderInteractive(options: HarnessOptions = {}) {
  const { width = 40, busy = false, onEscape, exitOnCtrlC = true } = options;
  const submitted: string[] = [];
  let rawFrame = '';
  const stdout = {
    columns: width,
    rows: 200,
    write: (s: string) => { if (s.trim()) rawFrame = s; return true; },
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
      onEscape,
      busy,
      width,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC,
    },
  );
  return {
    /**
     * The frame as text: styles stripped and per-row trailing blanks trimmed,
     * i.e. what Ink prints when it is not forced to emit color codes.
     */
    frame: () => plainFrame(rawFrame),
    /** The frame exactly as Ink wrote it, style sequences included. */
    rawFrame: () => rawFrame,
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

/**
 * Ink's output trimmer (`styledCharsToString(...).trimEnd()`) only strips a
 * row's trailing blanks while no style is open at its end, so a forced-color
 * frame keeps a highlighted blank cell that a plain frame drops. Re-apply the
 * trim to the stripped text so both look the same to the text assertions.
 */
function plainFrame(rawFrame: string): string {
  return rawFrame
    .split('\n')
    .map(row => stripAnsi(row).trimEnd())
    .join('\n');
}

/** Frame rows that carry input content (between the box borders). */
function contentRows(rawFrame: string): string[] {
  return stripAnsi(rawFrame)
    .split('\n')
    .filter(line => !line.startsWith('─') && line.trim() !== '');
}

interface InverseRun {
  text: string;
  /** True for the cursor block, which layers a white foreground on inverse. */
  cursor: boolean;
}

/** Reverse-video runs in the raw frame, row by row (both selection and cursor). */
function inverseRuns(rawFrame: string): InverseRun[] {
  const runs: InverseRun[] = [];
  for (const row of rawFrame.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[7m([\s\S]*?)\x1b\[27m/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(row)) !== null) {
      runs.push({
        text: stripAnsi(match[1]),
        cursor: match[1].includes('\x1b[37m'),
      });
    }
  }
  return runs;
}

/** Highlighted (selected) text runs, cursor blocks excluded. */
function selectionRuns(rawFrame: string): string[] {
  return inverseRuns(rawFrame).filter(run => !run.cursor).map(run => run.text);
}

/** Text covered by the cursor block. */
function cursorRuns(rawFrame: string): string[] {
  return inverseRuns(rawFrame).filter(run => run.cursor).map(run => run.text);
}

/** The suggestion row carrying the '▸' marker, ANSI-stripped. */
function highlightedSuggestion(rawFrame: string): string {
  return stripAnsi(rawFrame)
    .split('\n')
    .find(row => row.includes('\u25b8')) ?? '';
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

describe('InputArea selection', () => {
  it('highlights the chars swept by Shift+Left and drops the cursor block', async () => {
    const r = await drive(['hello', SHIFT_LEFT, SHIFT_LEFT]);
    try {
      expect(selectionRuns(r.rawFrame())).toEqual(['lo']);
      expect(cursorRuns(r.rawFrame())).toEqual([]); // exclusive, no double inverse
      expect(rowTexts(r.frame())).toEqual(['hello']);
    } finally {
      r.unmount();
    }
  });

  it('collapses the selection to the active end on a bare arrow', async () => {
    const r = await drive(['hello', SHIFT_LEFT, SHIFT_LEFT, '\x1b[D']);
    try {
      expect(selectionRuns(r.rawFrame())).toEqual([]);
      expect(cursorRuns(r.rawFrame())).toEqual(['l']); // cursor back on index 2
      expect(rowTexts(r.frame())).toEqual(['hello']);
    } finally {
      r.unmount();
    }
  });

  it('replaces the selection when typing, instead of inserting into it', async () => {
    const r = await drive(['hello', SHIFT_LEFT, SHIFT_LEFT, 'X']);
    try {
      expect(rowTexts(r.frame())[0].trimEnd()).toBe('helX');
      r.send('\r');
      await flush();
      expect(r.submitted).toEqual(['helX']);
    } finally {
      r.unmount();
    }
  });

  it('deletes the whole selection with one backspace', async () => {
    const r = await drive(['hello', SHIFT_LEFT, SHIFT_LEFT, '\x7f']);
    try {
      expect(rowTexts(r.frame())[0].trimEnd()).toBe('hel');
      expect(selectionRuns(r.rawFrame())).toEqual([]);
      // the cursor lands past the last char, on column 3
      expect(cursorRuns(r.rawFrame())).toEqual([' ']);
    } finally {
      r.unmount();
    }
  });

  it('shrinks the selection with Shift+Right while the anchor stays put', async () => {
    const r = await drive(['hello', SHIFT_LEFT, SHIFT_LEFT, SHIFT_RIGHT]);
    try {
      expect(selectionRuns(r.rawFrame())).toEqual(['o']);
      expect(cursorRuns(r.rawFrame())).toEqual([]);
    } finally {
      r.unmount();
    }
  });

  it('dismisses the selection on Escape before it reaches onEscape', async () => {
    const escapes: string[] = [];
    const r = await drive(['hello', SHIFT_LEFT, SHIFT_LEFT, '\x1b'], {
      onEscape: () => escapes.push('esc'),
    });
    try {
      expect(selectionRuns(r.rawFrame())).toEqual([]);
      expect(rowTexts(r.frame())).toEqual(['hello']);
      expect(escapes).toEqual([]);

      r.send('\x1b');
      await flush();
      expect(escapes).toEqual(['esc']);
      expect(rowTexts(r.frame())).toEqual(['']);
    } finally {
      r.unmount();
    }
  });

  it('highlights both rows of a selection crossing a wrap boundary', async () => {
    // width 12 → budget 8 columns: 'abcdefgh' | 'ijklmnop'
    const r = await drive(
      ['abcdefghijklmnop', ...Array(10).fill(SHIFT_LEFT)],
      { width: 12 },
    );
    try {
      expect(rowTexts(r.frame())).toEqual(['abcdefgh', 'ijklmnop']);
      expect(selectionRuns(r.rawFrame())).toEqual(['gh', 'ijklmnop']);
      for (const row of rowTexts(r.frame())) {
        expect(stringWidth(row)).toBeLessThanOrEqual(8);
      }
    } finally {
      r.unmount();
    }
  });

  it('highlights every logical line of a selection over pasted newlines', async () => {
    const r = await drive(['a\nb', SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT]);
    try {
      expect(rowTexts(r.frame())).toEqual(['a', 'b']);
      expect(selectionRuns(r.rawFrame())).toEqual(['a', 'b']);
    } finally {
      r.unmount();
    }
  });

  it('still types shifted characters (uppercase carries key.shift)', async () => {
    const r = await drive(['A']);
    try {
      expect(rowTexts(r.frame())[0].trimEnd()).toBe('A');
      r.send('\r');
      await flush();
      expect(r.submitted).toEqual(['A']);
    } finally {
      r.unmount();
    }
  });

  it('moves the panel marker with arrows and still selects behind the panel', async () => {
    const open = await drive(['/']);
    try {
      expect(highlightedSuggestion(open.rawFrame())).toContain('/tasks');
    } finally {
      open.unmount();
    }

    const moved = await drive(['/', '\x1b[B']);
    try {
      expect(highlightedSuggestion(moved.rawFrame())).toContain('/workers');
    } finally {
      moved.unmount();
    }

    const selecting = await drive(['/', '\x1b[B', SHIFT_LEFT]);
    try {
      expect(highlightedSuggestion(selecting.rawFrame())).toContain('/workers');
      expect(selectionRuns(selecting.rawFrame())).toEqual(['/']);
    } finally {
      selecting.unmount();
    }
  });
});

describe('InputArea Ctrl key bindings', () => {
  it('selects the whole value with Ctrl-A and leaves Ctrl-C alone', async () => {
    const r = await drive(['你好😀ab', CTRL_A], { exitOnCtrlC: false });
    try {
      expect(selectionRuns(r.rawFrame())).toEqual(['你好😀ab']);
      expect(cursorRuns(r.rawFrame())).toEqual([]); // no double inverse
      expect(rowTexts(r.frame())).toEqual(['你好😀ab']);

      // Ctrl-C belongs to app.tsx — the box must not eat it (nor change state).
      r.send(CTRL_C);
      await flush();
      expect(selectionRuns(r.rawFrame())).toEqual(['你好😀ab']);
      expect(r.submitted).toEqual([]);
    } finally {
      r.unmount();
    }
  });

  it('moves to the end of the logical line with Ctrl-E', async () => {
    // cursor 8 → 4 (inside "cd"), Ctrl-E stops just before the '\n'
    const r = await drive(['ab\ncd\nef', '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[D', CTRL_E, 'X']);
    try {
      expect(rowTexts(r.frame())).toEqual(['ab', 'cdX', 'ef']);
    } finally {
      r.unmount();
    }
  });

  it('drops a selection on Ctrl-E so typing appends at the line end', async () => {
    const r = await drive(['ab\ncd', CTRL_A, CTRL_E, 'X']);
    try {
      expect(rowTexts(r.frame())).toEqual(['ab', 'cdX']);
    } finally {
      r.unmount();
    }
  });

  it('kills to the end of the line with Ctrl-K', async () => {
    // "ab|cd" → "ab"
    const r = await drive(['abcd', '\x1b[D', '\x1b[D', CTRL_K]);
    try {
      expect(rowTexts(r.frame())).toEqual(['ab']);
    } finally {
      r.unmount();
    }
  });

  it('kills only the selection with Ctrl-K when there is one', async () => {
    // "a[bc]d" → "ad" (not "a")
    const r = await drive(['abcd', '\x1b[D', SHIFT_LEFT, SHIFT_LEFT, CTRL_K]);
    try {
      expect(rowTexts(r.frame())).toEqual(['ad']);
      expect(selectionRuns(r.rawFrame())).toEqual([]);
    } finally {
      r.unmount();
    }
  });

  it('kills to the line start with Ctrl-U without splitting a surrogate pair', async () => {
    // "a😀|c" → "c"
    const r = await drive(['a😀c', '\x1b[D', CTRL_U]);
    try {
      expect(rowTexts(r.frame())).toEqual(['c']);
    } finally {
      r.unmount();
    }
  });

  it('kills backwards by word with Ctrl-W, emoji and CJK included', async () => {
    const r = await drive(['hi 世界😀 x', CTRL_W]);
    try {
      expect(rowTexts(r.frame())).toEqual(['hi 世界😀']);

      r.send(CTRL_W);
      await flush();
      expect(rowTexts(r.frame())).toEqual(['hi 世界']); // the whole emoji

      r.send(CTRL_W);
      await flush();
      expect(rowTexts(r.frame())).toEqual(['hi 世']); // CJK steps one char
    } finally {
      r.unmount();
    }
  });

  it('moves by word with Ctrl+Left / Ctrl+Right, emoji intact', async () => {
    // "foo 世界😀 |bar": one step left lands on "|bar"
    const r = await drive(['foo 世界😀 bar', CTRL_LEFT, 'X']);
    try {
      expect(rowTexts(r.frame())).toEqual(['foo 世界😀 Xbar']);
    } finally {
      r.unmount();
    }

    // two steps left → before the emoji, one step right → after it: the pair is
    // stepped over whole, never split
    const r2 = await drive(['foo 世界😀 bar', CTRL_LEFT, CTRL_LEFT, CTRL_RIGHT, 'X']);
    try {
      expect(rowTexts(r2.frame())).toEqual(['foo 世界😀X bar']);
    } finally {
      r2.unmount();
    }

    // a third step left moves one CJK character, not the whole run
    const r3 = await drive(['foo 世界😀 bar', CTRL_LEFT, CTRL_LEFT, CTRL_LEFT, 'X']);
    try {
      expect(rowTexts(r3.frame())).toEqual(['foo 世X界😀 bar']);
    } finally {
      r3.unmount();
    }
  });

  it('steps over a word before an emoji without splitting it', async () => {
    // "ab |😀" → Ctrl+Left → "ab |😀" (the emoji starts a new word)
    const r = await drive(['ab 😀', CTRL_LEFT, 'X']);
    try {
      expect(rowTexts(r.frame())).toEqual(['ab X😀']);
    } finally {
      r.unmount();
    }
  });

  it('moves by word with Alt+B / Alt+F', async () => {
    const r = await drive(['foo 世界😀 bar', ALT_B]);
    try {
      expect(rowTexts(r.frame())).toEqual(['foo 世界😀 bar']);
      r.send('X');
      await flush();
      expect(rowTexts(r.frame())).toEqual(['foo 世界😀 Xbar']);
    } finally {
      r.unmount();
    }

    const r2 = await drive(['foo 世界😀 bar', ALT_B, ALT_B, ALT_F, 'X']);
    try {
      expect(rowTexts(r2.frame())).toEqual(['foo 世界😀X bar']);
    } finally {
      r2.unmount();
    }
  });

  it('extends the selection by word with Shift+Ctrl+Left, anchor pinned', async () => {
    const r = await drive(['foo bar baz', CTRL_SHIFT_LEFT]);
    try {
      expect(selectionRuns(r.rawFrame())).toEqual(['baz']);

      r.send(CTRL_SHIFT_LEFT);
      await flush();
      expect(selectionRuns(r.rawFrame())).toEqual(['bar baz']);

      // typing replaces the whole word selection — the anchor stayed at 11
      r.send('X');
      await flush();
      expect(rowTexts(r.frame())).toEqual(['foo X']);
    } finally {
      r.unmount();
    }
  });

  it('does nothing on Ctrl-K/U/W/Z/Y with an empty input', async () => {
    const r = await drive([CTRL_K, CTRL_U, CTRL_W, CTRL_Z, CTRL_Y]);
    try {
      expect(rowTexts(r.frame())).toEqual(['']);
      r.send('a');
      await flush();
      expect(rowTexts(r.frame())).toEqual(['a']);
    } finally {
      r.unmount();
    }
  });
});

describe('InputArea undo/redo', () => {
  it('undoes a fast typing run in one step and redoes it with Ctrl-Y', async () => {
    const r = await drive(['a', 'b', 'c', CTRL_Z]);
    try {
      expect(rowTexts(r.frame())).toEqual(['']);

      r.send(CTRL_Y);
      await flush();
      expect(rowTexts(r.frame())).toEqual(['abc']);
    } finally {
      r.unmount();
    }
  });

  it('has no redo branch once new text replaces the undone one', async () => {
    const r = await drive(['abc', CTRL_Z, CTRL_Y, 'd', CTRL_Y]);
    try {
      expect(rowTexts(r.frame())).toEqual(['abcd']);
    } finally {
      r.unmount();
    }
  });

  it('treats an IME commit as one step but keeps emoji inserts mergeable', async () => {
    const ime = await drive(['a', '你好', CTRL_Z]);
    try {
      expect(rowTexts(ime.frame())).toEqual(['a']);
    } finally {
      ime.unmount();
    }

    const emoji = await drive(['😀', '😀', CTRL_Z]);
    try {
      expect(rowTexts(emoji.frame())).toEqual(['']);
    } finally {
      emoji.unmount();
    }
  });

  it('undoes a selection replacement as one step', async () => {
    const r = await drive(['你好😀ab', CTRL_A, 'X']);
    try {
      expect(rowTexts(r.frame())).toEqual(['X']);

      r.send(CTRL_Z);
      await flush();
      expect(rowTexts(r.frame())).toEqual(['你好😀ab']);
    } finally {
      r.unmount();
    }
  });

  it('undoes a select-all kill', async () => {
    const r = await drive(['abc', CTRL_A, CTRL_K]);
    try {
      expect(rowTexts(r.frame())).toEqual(['']);

      r.send(CTRL_Z);
      await flush();
      expect(rowTexts(r.frame())).toEqual(['abc']);
    } finally {
      r.unmount();
    }
  });

  it('undoes an autocompleted command', async () => {
    const r = await drive(['/ta', '\t']);
    try {
      // the plain frame trims the trailing space the completion appends
      expect(rowTexts(r.frame())).toEqual(['/tasks']);

      r.send(CTRL_Z);
      await flush();
      // The restored '/' prefix brings the suggestion panel back (derived
      // state, not snapshot state).
      const rows = rowTexts(r.frame());
      expect(rows[rows.length - 1]).toBe('/ta');
      expect(highlightedSuggestion(r.rawFrame())).toContain('/tasks');
    } finally {
      r.unmount();
    }
  });

  it('does not resurrect submitted text with Ctrl-Z', async () => {
    const r = await drive(['abc', '\r', CTRL_Z]);
    try {
      expect(r.submitted).toEqual(['abc']);
      expect(rowTexts(r.frame())).toEqual(['']);
    } finally {
      r.unmount();
    }
  });

  it('undoes backspaces as one run and redoes them', async () => {
    const r = await drive(['abcd', '\x7f', '\x7f', CTRL_Z]);
    try {
      expect(rowTexts(r.frame())).toEqual(['abcd']);

      r.send(CTRL_Y);
      await flush();
      expect(rowTexts(r.frame())).toEqual(['ab']);
    } finally {
      r.unmount();
    }
  });
});
