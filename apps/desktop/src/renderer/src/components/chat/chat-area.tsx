import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationEntry, ControllerSignal } from '@wayang-ai/protocol';
import {
  SLICE,
  buildConversationItems,
  buildStreamingItems,
  buildUnreadSignalItems,
  useSliceValue,
} from '../../lib/store';
import type { TurnDot } from '../../lib/chat-metrics';
import { UserRow, SystemRow } from './user-row';
import { AssistantRow } from './assistant-row';
import { SignalRow } from './signal-row';
import { TurnDotsNav } from '../turn-dots-nav';

interface ChatAreaProps {
  busy: boolean;
}

/** Row renderer shared by the conversation and unread-signal sections. */
function renderRow(item: ReturnType<typeof buildConversationItems>[number]) {
  switch (item.role) {
    case 'user':
      // Layout-level turn anchor (§4.3 TurnDotsNav 数据源只取 user 消息) —
      // the bubble component itself stays untouched.
      return (
        <div key={item.id} data-turn-uuid={item.id}>
          <UserRow item={item} />
        </div>
      );
    case 'assistant':
      return <AssistantRow key={item.id} item={item} />;
    case 'signal':
      return <SignalRow key={item.id} item={item} />;
    case 'system':
      return <SystemRow key={item.id} item={item} />;
  }
}

/**
 * 会话流：自动滚底（用户上滚时暂停跟随）+ 侧边轮次圆点导航。
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
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

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

  // 轮次导航数据源：只取 user 消息（§4.3），预览取首行截断。
  const turnDots = useMemo<TurnDot[]>(
    () =>
      conversationItems
        .filter((item) => item.role === 'user')
        .map((item) => ({
          id: item.id,
          preview: item.content.length > 40 ? `${item.content.slice(0, 40)}…` : item.content,
        })),
    [conversationItems],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollEl(el);
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
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto py-4">
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
      <TurnDotsNav items={turnDots} scrollContainer={scrollEl} />
    </div>
  );
}
