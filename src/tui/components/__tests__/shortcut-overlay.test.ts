import { describe, it, expect } from 'vitest';

// ink applies Text styles through chalk, which captures color support at
// import time — and the test runner's stdout is not a TTY, so the rendered
// frame would come back with every style stripped. Force level-1 colors
// before ink loads; the static-import-free imports below are why.
process.env.FORCE_COLOR = '1';

const { createElement: h } = await import('react');
const { render } = await import('ink');
const {
  ShortcutOverlay,
  SHORTCUT_SPAN_STYLES,
  truncateSpanLine,
} = await import('@/tui/components/shortcut-overlay');
const { renderShortcutSpans } = await import('@/tui/utils/shortcut-catalog');
const { theme } = await import('@/tui/theme');
const { stringWidth } = await import('@/tui/utils/text-width');

/** The `Ctrl+A` entry line — `  Ctrl+A — Select all`, 21 columns. */
function ctrlALine() {
  return renderShortcutSpans().find(line => line[0]?.text === '  Ctrl+A')!;
}

/** Render the overlay into a fake stdout and return the final frame. */
async function renderOverlayFrame(columns: number): Promise<string> {
  const chunks: string[] = [];
  const stdout = {
    columns,
    rows: 24,
    write: (s: string) => { chunks.push(s); return true; },
    on() { return stdout; },
    off() { return stdout; },
    removeListener() { return stdout; },
  };
  const app = render(h(ShortcutOverlay), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  app.unmount();
  const frame = chunks[chunks.length - 1] ?? '';
  // With colors on, the frame opens with the border's gray escape.
  if (!stripAnsi(frame).startsWith('┌')) throw new Error('no complete frame was written');
  return frame;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI, '');

describe('SHORTCUT_SPAN_STYLES', () => {
  it('anchors keys with the accent color + bold, like the assistant prefix', () => {
    expect(SHORTCUT_SPAN_STYLES.key).toEqual({
      color: theme.baseToken.color.accent,
      bold: true,
    });
  });

  it('keeps actions dim and group headings plain-bold', () => {
    expect(SHORTCUT_SPAN_STYLES.action).toEqual({ dimColor: true });
    expect(SHORTCUT_SPAN_STYLES.heading).toEqual({ bold: true });
  });
});

describe('truncateSpanLine', () => {
  it('returns a fitting line unchanged, same reference', () => {
    const line = ctrlALine();
    expect(truncateSpanLine(line, 21)).toBe(line);
    expect(truncateSpanLine(line, 200)).toBe(line);
  });

  it('keeps a cut line within the budget and marks the cut with an ellipsis', () => {
    for (const width of [1, 5, 12, 20]) {
      const out = truncateSpanLine(ctrlALine(), width);
      const text = out.map(span => span.text).join('');
      expect(stringWidth(text)).toBeLessThanOrEqual(width);
      expect(text.endsWith('…')).toBe(true);
    }
  });

  it('computes the budget on plain text — the kept part is a prefix of the line', () => {
    const line = ctrlALine();
    const plain = line.map(span => span.text).join('');
    for (const width of [1, 5, 12, 20]) {
      const kept = truncateSpanLine(line, width).map(span => span.text).join('');
      expect(plain.startsWith(kept.slice(0, -1))).toBe(true);
    }
  });

  it('gives up the boundary column when a span exactly fills the line', () => {
    const spans = [
      { text: 'aaaa', role: 'key' as const },
      { text: 'bbbb', role: 'action' as const },
    ];
    // 'aaaa' fills all 4 columns, so its last column becomes the ellipsis.
    const out = truncateSpanLine(spans, 4);
    expect(out.map(span => span.text).join('')).toBe('aa…');
    // One column left: the ellipsis alone says there was more.
    expect(truncateSpanLine(spans, 1).map(span => span.text).join('')).toBe('…');
  });

  it('returns no spans when there is no budget at all', () => {
    expect(truncateSpanLine(ctrlALine(), 0)).toEqual([]);
  });
});

describe('ShortcutOverlay frame', () => {
  it('renders keys emphasized, actions dim, and the catalog copy verbatim', async () => {
    const frame = await renderOverlayFrame(80);

    // Key span: bold + accent green directly before the keys text.
    expect(frame).toContain('\u001B[1m\u001B[32m  Ctrl+A');
    // Action span (with its separator): dim directly before the copy.
    expect(frame).toContain('\u001B[2m — Select all');
    // Group heading: plain bold.
    expect(frame).toContain('\u001B[1mInput editing');
    // The longest key spelling survives on a wide terminal.
    expect(frame).toContain('Ctrl+J, Alt+Enter, Ctrl+Enter');
  });

  it('keeps every line unwrapped on a narrow terminal, marking cuts', async () => {
    const frame = await renderOverlayFrame(40);
    const lines = stripAnsi(frame).split('\n').map(line => line.replace(/\s+$/, ''));

    // 23 content lines (3 headings + 20 entries) plus top and bottom border.
    expect(lines).toHaveLength(25);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(40);
    }
    // The overlong Ctrl+J row is cut once with an ellipsis — not wrapped.
    const ctrlJ = lines.find(line => line.includes('Ctrl+J'))!;
    expect(ctrlJ).toMatch(/…\s*│$/);
  });
});
