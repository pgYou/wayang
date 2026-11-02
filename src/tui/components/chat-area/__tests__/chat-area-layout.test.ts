import { describe, it, expect } from 'vitest';
import { Box } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { ChatArea } from '@/tui/components/chat-area/chat-area';
import { theme } from '@/tui/theme';
import { renderToString, h } from './render-to-string';

// Issue #17: while the controller is thinking/streaming, the pending
// ("waiting for process") notice sits in the same live frame as the streaming
// row. Both used to be row-direction siblings, so the notice was laid out to
// the right of the spinner / streaming text instead of on its own line.

const HINT = '··· waiting for process ···';
const COLUMNS = 60;
const CONTENT_WIDTH = COLUMNS - 4; // matches controller-page's chatContentWidth

function userItem(content: string): DisplayItem {
  return { id: `u-${content.slice(0, 8)}`, timestamp: 0, read: false, role: 'user', content };
}

function signalItem(content: string): DisplayItem {
  return {
    id: `s-${content.slice(0, 8)}`,
    timestamp: 0,
    read: false,
    role: 'signal',
    subtype: 'worker_completed',
    content,
  };
}

function streamingItem(content: string): DisplayItem {
  return { id: 'stream-1', timestamp: 0, read: true, role: 'assistant', content };
}

/** Render like the controller page does: ChatArea wrapped in a plain <Box>. */
function render(children: {
  items: DisplayItem[];
  busy?: boolean;
  streamingItems?: DisplayItem[];
}, columns = COLUMNS): string[] {
  const element = h(
    Box,
    { marginBottom: 1 },
    h(ChatArea, { ...children, contentWidth: columns - 4 }),
  );
  return renderToString(element, columns).split('\n');
}

function lineOf(lines: string[], needle: string): string {
  const line = lines.find(l => l.includes(needle));
  expect(line, `no rendered line contains ${JSON.stringify(needle)}`).toBeDefined();
  return line as string;
}

function indexOf(lines: string[], needle: string): number {
  const idx = lines.findIndex(l => l.includes(needle));
  expect(idx, `no rendered line contains ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return idx;
}

describe('ChatArea live region layout', () => {
  it('renders the pending notice on its own line below the streaming body', () => {
    const lines = render({
      items: [userItem('hello from the user'), signalItem('task finished fine')],
      busy: true,
      streamingItems: [streamingItem('I am streaming the current answer')],
    });

    const hintLine = lineOf(lines, HINT);
    // The notice must not share a line with the streaming text or the spinner.
    expect(hintLine.trim()).toBe(HINT);
    expect(hintLine).not.toContain('streaming the current answer');
    expect(hintLine).not.toContain(theme.spinner.frames[0]);

    const streamingLine = lineOf(lines, 'I am streaming the current answer');
    expect(streamingLine).toContain(theme.spinner.frames[0]);
    expect(streamingLine).not.toContain(HINT);

    // Section order: streaming row, then pending notice, then pending items.
    const hintIdx = indexOf(lines, HINT);
    expect(indexOf(lines, 'I am streaming the current answer')).toBeLessThan(hintIdx);
    expect(indexOf(lines, 'hello from the user')).toBeGreaterThan(hintIdx);
  });

  it('keeps the pending notice below the spinner while no text has streamed yet', () => {
    const lines = render({
      items: [signalItem('task finished fine')],
      busy: true,
      streamingItems: [],
    });

    const spinnerLine = lines.findIndex(l => l.includes(theme.spinner.frames[0]));
    expect(spinnerLine).toBeGreaterThanOrEqual(0);
    // Nothing else may be glued after the loading icon.
    expect(lines[spinnerLine].trim()).toBe(theme.spinner.frames[0]);
    expect(indexOf(lines, HINT)).toBeGreaterThan(spinnerLine);
  });

  it('keeps every rendered line within the terminal width', () => {
    const lines = render({
      items: [userItem('x'.repeat(CONTENT_WIDTH)), signalItem('task finished fine')],
      busy: true,
      streamingItems: [streamingItem('word '.repeat(30))],
    });

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(COLUMNS);
    }
  });

  it('does not wrap a long pending user message onto a stray extra line', () => {
    const content = 'y'.repeat(48);
    const lines = render({
      items: [userItem(content)],
      busy: true,
      streamingItems: [],
    });

    const userRows = lines.filter(l => l.includes(content));
    expect(userRows).toHaveLength(1);
  });

  it('keeps wrapped streaming text aligned to the right of the spinner', () => {
    const lines = render({
      items: [],
      busy: true,
      streamingItems: [streamingItem('word '.repeat(30))],
    });

    const firstIdx = lines.findIndex(l => l.includes('word'));
    const continuation = lines.slice(firstIdx + 1).filter(l => l.includes('word'));
    expect(continuation.length).toBeGreaterThan(0);
    for (const line of continuation) {
      // 1 column of padding + 2 columns of spinner prefix.
      expect(line.startsWith(' '.repeat(3) + 'word')).toBe(true);
    }
  });

  it('separates consecutive pending items with a blank line', () => {
    const lines = render({
      items: [signalItem('first signal content'), signalItem('second signal content')],
      busy: false,
    });

    // Each signal row is "⚑ completed" + an indented content line.
    const headerIndices = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => line.includes(theme.signal.prefix))
      .map(({ idx }) => idx);
    expect(headerIndices).toHaveLength(2);
    expect(lines[headerIndices[1] - 1].trim()).toBe('');
    expect(indexOf(lines, 'second signal content')).toBeGreaterThan(headerIndices[1]);
  });

  it('keeps the separation on a narrow terminal', () => {
    const columns = 40;
    const lines = render({
      items: [userItem('a fairly long pending message that must wrap')],
      busy: true,
      streamingItems: [streamingItem('streaming text that is long enough to wrap')],
    }, columns);

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
    const hintLine = lineOf(lines, HINT);
    expect(hintLine.trim()).toBe(HINT);
    expect(hintLine).not.toContain(theme.spinner.frames[0]);
    expect(hintLine).not.toContain('streaming text');
  });
});
