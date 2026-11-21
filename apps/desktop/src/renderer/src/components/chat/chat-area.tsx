import { useEffect, useRef } from 'react';
import type { DisplayItem } from '../../lib/display';
import { UserRow, SystemRow } from './user-row';
import { AssistantRow } from './assistant-row';
import { SignalRow } from './signal-row';

interface ChatAreaProps {
  items: DisplayItem[];
  busy: boolean;
  streamingItems: DisplayItem[];
}

/** 会话流：自动滚底（用户上滚时暂停跟随）。 */
export function ChatArea({ items, busy, streamingItems }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [items, streamingItems, busy]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4">
      <div className="flex flex-col gap-3">
        {items.map((item) => {
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
        })}
        {streamingItems.map((item) =>
          item.role === 'assistant' ? <AssistantRow key={`s-${item.id}`} item={item} /> : null,
        )}
        {busy && streamingItems.length === 0 && (
          <div className="flex items-center gap-2 px-5 text-xs text-primary-strong">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
            Controller 正在思考…
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
