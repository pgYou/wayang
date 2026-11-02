import { describe, it, expect } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { render } from 'ink';
import { InquiryPrompt } from '@/tui/components/inquiry-prompt';
import {
  INQUIRE_OTHER_OPTION,
  INQUIRE_CUSTOM_ANSWER_PREFIX,
  buildSelectChoices,
  formatCustomAnswer,
  isCustomAnswer,
  isOtherChoice,
  type InquireQuestion,
} from '@/types/index';

// --- pure select-choice helpers ---

describe('inquiry select helpers', () => {
  it('appends the Other choice by default', () => {
    expect(buildSelectChoices(['A', 'B'])).toEqual(['A', 'B', INQUIRE_OTHER_OPTION]);
  });

  it('appends the Other choice when allowOther is explicitly true', () => {
    expect(buildSelectChoices(['A'], true)).toEqual(['A', INQUIRE_OTHER_OPTION]);
  });

  it('does not append the Other choice when allowOther is false', () => {
    expect(buildSelectChoices(['A', 'B'], false)).toEqual(['A', 'B']);
  });

  it('keeps the Other choice as the only fallback for empty options', () => {
    expect(buildSelectChoices([])).toEqual([INQUIRE_OTHER_OPTION]);
  });

  it('identifies the Other choice row', () => {
    expect(isOtherChoice(INQUIRE_OTHER_OPTION)).toBe(true);
    expect(isOtherChoice('A')).toBe(false);
  });

  it('marks custom answers and only custom answers', () => {
    const marked = formatCustomAnswer('my own plan');
    expect(marked).toBe(`${INQUIRE_CUSTOM_ANSWER_PREFIX}my own plan`);
    expect(isCustomAnswer(marked)).toBe(true);
    expect(isCustomAnswer('A preset option')).toBe(false);
  });
});

// --- interactive rendering ---

/** Strip ANSI escape sequences (colors, cursor moves) from rendered output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Render an Ink element with a fake TTY stdin so useInput-based components
 * work outside a terminal, and drive it with raw key sequences
 * ('\x1b[B' = down arrow, '\r' = return, plain text = typed characters).
 *
 * Modeled on the chat-area renderToString helper (debug mode writes the
 * full frame on every commit), plus just enough stdin for App's raw-mode
 * path: isTTY + setRawMode/ref/unref stubs and a readable/read pair the
 * test pumps through send().
 */
function renderInteractive(element: ReactElement) {
  let frame = '';
  const stdout = {
    columns: 100,
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
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
  });
  return {
    frame: () => stripAnsi(frame),
    send(data: string) {
      pending.push(data);
      for (const fn of [...readableListeners]) fn();
    },
    unmount: () => app.unmount(),
  };
}

/** Let React flush effects and commits between keystrokes. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function selectInquiry(overrides?: Partial<InquireQuestion>): InquireQuestion {
  return { message: 'Which framework?', type: 'select', options: ['react', 'vue'], ...overrides };
}

describe('InquiryPrompt select rendering', () => {
  it('shows preset options plus the auto-appended Other row by default', async () => {
    const r = renderInteractive(h(InquiryPrompt, { inquiry: selectInquiry(), onAnswer: () => {} }));
    try {
      await flush();
      const frame = r.frame();
      expect(frame).toContain('Which framework?');
      expect(frame).toContain('react');
      expect(frame).toContain('vue');
      expect(frame).toContain(INQUIRE_OTHER_OPTION);
    } finally {
      r.unmount();
    }
  });

  it('omits the Other row when allowOther is false', async () => {
    const r = renderInteractive(h(InquiryPrompt, {
      inquiry: selectInquiry({ allowOther: false }),
      onAnswer: () => {},
    }));
    try {
      await flush();
      const frame = r.frame();
      expect(frame).toContain('react');
      expect(frame).toContain('vue');
      expect(frame).not.toContain(INQUIRE_OTHER_OPTION);
    } finally {
      r.unmount();
    }
  });
});

describe('InquiryPrompt select interaction', () => {
  it('returns the selected preset option unchanged', async () => {
    const answers: string[] = [];
    const r = renderInteractive(h(InquiryPrompt, { inquiry: selectInquiry(), onAnswer: (a) => answers.push(a) }));
    try {
      await flush();
      r.send('\x1b[B'); // down → vue
      await flush();
      r.send('\r');
      await flush();
      expect(answers).toEqual(['vue']);
    } finally {
      r.unmount();
    }
  });

  it('returns custom text with the Other marker when the Other row is picked', async () => {
    const answers: string[] = [];
    const r = renderInteractive(h(InquiryPrompt, { inquiry: selectInquiry(), onAnswer: (a) => answers.push(a) }));
    try {
      await flush();
      r.send('\x1b[B'); // down → vue
      r.send('\x1b[B'); // down → 其他（自行输入）
      await flush();
      r.send('\r');     // pick Other → free-form input
      await flush();
      expect(r.frame()).toContain(`${INQUIRE_OTHER_OPTION}:`);
      r.send('svelte, actually');
      await flush();
      r.send('\r');
      await flush();
      expect(answers).toEqual([`${INQUIRE_CUSTOM_ANSWER_PREFIX}svelte, actually`]);
    } finally {
      r.unmount();
    }
  });

  it('does not submit an empty custom answer', async () => {
    const answers: string[] = [];
    const r = renderInteractive(h(InquiryPrompt, { inquiry: selectInquiry(), onAnswer: (a) => answers.push(a) }));
    try {
      await flush();
      r.send('\x1b[B');
      r.send('\x1b[B'); // → Other
      await flush();
      r.send('\r');
      await flush();
      r.send('\r'); // empty input — must not submit
      await flush();
      expect(answers).toEqual([]);
      expect(r.frame()).toContain(`${INQUIRE_OTHER_OPTION}:`);
    } finally {
      r.unmount();
    }
  });
});
