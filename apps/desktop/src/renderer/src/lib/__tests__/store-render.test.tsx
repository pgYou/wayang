// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ComponentType } from 'react';
import type { AssistantEntry, ConversationEntry, UserEntry } from '@wayang-ai/protocol';
import { EEntryType } from '@wayang-ai/protocol/types/conversation';
import { wayangStore } from '../store';
import type { DisplayItem } from '../display';

/**
 * Render-count pin (§4.2 验收「流式输出只重绘当前条目」): the memoized row
 * components receive stable item references from the memoized section
 * builders, so a streaming chunk re-renders ONLY the streaming row — the
 * conversation rows' render counts stay frozen. The counting wrappers mirror
 * the production rows' own memo() boundaries.
 */

const userRenders = { count: 0 };
const assistantRenders = { count: 0 };

vi.mock('../../components/chat/user-row', async (importOriginal) => {
  const actual = await importOriginal<Record<string, ComponentType<{ item: DisplayItem }>>>();
  const { memo } = await import('react');
  return {
    ...actual,
    UserRow: memo(function CountingUserRow(props: { item: DisplayItem }) {
      userRenders.count += 1;
      return <actual.UserRow {...props} />;
    }),
  };
});

vi.mock('../../components/chat/assistant-row', async (importOriginal) => {
  const actual = await importOriginal<Record<string, ComponentType<{ item: DisplayItem }>>>();
  const { memo } = await import('react');
  return {
    ...actual,
    AssistantRow: memo(function CountingAssistantRow(props: { item: DisplayItem }) {
      assistantRenders.count += 1;
      return <actual.AssistantRow {...props} />;
    }),
  };
});

import { ChatArea } from '../../components/chat/chat-area';

const userEntry = (n: number): UserEntry => ({
  type: EEntryType.User,
  uuid: `u-${n}`,
  parentUuid: null,
  sessionId: 's-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'user', content: `user message ${n}` },
});

const streamingEntry = (n: number, content: string): AssistantEntry => ({
  type: EEntryType.Assistant,
  uuid: `a-${n}`,
  parentUuid: null,
  sessionId: 's-1',
  timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'assistant', content },
});

const setConversation = (entries: ConversationEntry[]): void => {
  wayangStore.applyState({ target: 'controllerAgent', path: 'conversation', data: entries });
};

const setStreaming = (entries: ConversationEntry[]): void => {
  wayangStore.applyState({ target: 'controllerAgent', path: 'dynamicState.streamingEntries', data: entries });
};

describe('ChatArea render granularity (§2.7 流式输出只重绘当前条目)', () => {
  let root: Root;
  let container: HTMLElement;

  beforeAll(() => {
    // React 19 requires the explicit act environment marker outside Jest.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // happy-dom has no layout: stub the auto-scroll entry point.
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    userRenders.count = 0;
    assistantRenders.count = 0;
    act(() => {
      root.render(<ChatArea busy={false} />);
    });
  });

  afterAll(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('streaming chunks re-render only the streaming row, never the conversation rows', () => {
    // Seed three committed conversation rows.
    act(() => {
      setConversation([userEntry(1), userEntry(2), userEntry(3)]);
    });
    const userBaseline = userRenders.count;
    expect(userBaseline).toBe(3);

    // First streaming chunk: one streaming row renders.
    act(() => {
      setStreaming([streamingEntry(1, 'Hello')]);
    });
    expect(assistantRenders.count).toBe(1);
    expect(userRenders.count).toBe(userBaseline);
    expect(container.textContent).toContain('user message 1');
    expect(container.textContent).toContain('Hello');

    // The chunk grows: the SAME streaming row re-renders (new content),
    // the conversation rows stay frozen.
    act(() => {
      setStreaming([streamingEntry(1, 'Hello, streaming along')]);
    });
    expect(assistantRenders.count).toBe(2);
    expect(userRenders.count).toBe(userBaseline);
    expect(container.textContent).toContain('Hello, streaming along');

    // Another chunk: still only the streaming row.
    act(() => {
      setStreaming([streamingEntry(1, 'Hello, streaming along — more text')]);
    });
    expect(assistantRenders.count).toBe(3);
    expect(userRenders.count).toBe(userBaseline);

    // A committed conversation entry (a finished step) takes the coarse
    // path: the slice update re-delivers every entry as a fresh object, so
    // the whole section re-renders — the same low-frequency behavior as
    // before the refactor, and the granularity contract above is unaffected.
    act(() => {
      setConversation([userEntry(1), userEntry(2), userEntry(3), userEntry(4)]);
    });
    expect(userRenders.count).toBe(userBaseline + 4);
  });
});
