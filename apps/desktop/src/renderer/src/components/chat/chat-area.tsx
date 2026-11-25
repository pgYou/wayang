import { useEffect, useMemo, useRef } from 'react';
import type { ConversationEntry, ControllerSignal } from '@wayang-ai/protocol';
import {
  SLICE,
  buildConversationItems,
  buildStreamingItems,
  buildUnreadSignalItems,
  useSliceValue,
} from '../../lib/store';
import { UserRow, SystemRow } from './user-row';
import { AssistantRow } from './assistant-row';
import { SignalRow } from './signal-row';

interface ChatAreaProps {
  busy: boolean;
}

/** Row renderer shared by the conversation and unread-signal sections. */
function renderRow(item: ReturnType<typeof buildConversationItems>[number]) {
  switch (item.role) {
    case 'user':
      return <UserRow key={item.id} item={item} />;
    case 'assistant':
      return <AssistantRow key={item.id} item={item} />;
    case 'signal':
      return <SignalRow key={item.id} item={item} />;
    case 'system':
      return <SystemRow key={item.id} item={item} />;
  }
}

/**
 * 会话流：自动滚底（用户上滚时暂停跟随）。
 *
 * Fine-grained sections (§2.7): conversation / streaming / unread signals
 * each subscribe to their own slice, so a streaming chunk re-renders only
 * the streaming row (rows are memoized and receive stable item references
 * from the memoized section builders).
 */
export function ChatArea({ busy }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversation = useSliceValue<ConversationEntry[]>(SLICE.conversation);
  const signals = useSliceValue<ControllerSignal[]>(SLICE.signals);
  const streaming = useSliceValue<ConversationEntry[]>(SLICE.streaming);

  const conversationItems = useMemo(
    () => buildConversationItems({ [SLICE.conversation]: conversation }),
    [conversation],
  );
  const streamingItems = useMemo(
    () => buildStreamingItems({ [SLICE.conversation]: conversation, [SLICE.streaming]: streaming }),
    [conversation, streaming],
  );
  const unreadSignalItems = useMemo(
    () => buildUnreadSignalItems({ [SLICE.signals]: signals }),
    [signals],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [conversationItems, streamingItems, unreadSignalItems, busy]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4">
      <div className="flex flex-col gap-3">
        {conversationItems.map(renderRow)}
        {streamingItems.map((item) =>
          item.role === 'assistant' ? <AssistantRow key={`s-${item.id}`} item={item} /> : null,
        )}
        {unreadSignalItems.map(renderRow)}
        {busy && streamingItems.length === 0 && (
          <div className="flex items-center gap-2 px-5 text-xs text-primary-strong">
            <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            Controller 正在思考…
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
