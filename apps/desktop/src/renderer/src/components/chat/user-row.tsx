import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { DisplayItem } from '../../lib/display';
import { FOLD_THRESHOLD_PX, shouldFold } from '../../lib/chat-metrics';
import { cn } from '../../lib/cn';

/**
 * The user's own message — the light-blue presence in the conversation.
 * 长消息折叠（§4.3 工作项③）：渲染高度超过 300px 默认折叠 + 展开按钮。
 * Memoized: rows receive stable item references from the memoized section
 * builders (§2.7), so a streaming update skips re-rendering them.
 */
export const UserRow = memo(function UserRow({ item }: { item: DisplayItem }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Measure once per content change (and when expanded resets the clamp).
  useLayoutEffect(() => {
    setHeight(contentRef.current?.scrollHeight ?? null);
  }, [item.content, expanded]);

  const folded = shouldFold(height, expanded, FOLD_THRESHOLD_PX);

  return (
    <div className="flex justify-end px-4">
      <div className="flex max-w-[78%] flex-col items-end gap-1">
        <div
          ref={contentRef}
          className={cn(
            'whitespace-pre-wrap rounded-xl rounded-tr-md border border-primary-border bg-primary-soft px-4 py-2 text-sm leading-relaxed text-foreground',
            folded && 'max-h-[300px] overflow-hidden',
          )}
        >
          {item.content}
        </div>
        {folded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-xs text-primary-strong transition-colors hover:text-primary"
          >
            展开长消息（{height}px）
          </button>
        )}
        {expanded && height !== null && height > FOLD_THRESHOLD_PX && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            收起
          </button>
        )}
      </div>
    </div>
  );
});

export const SystemRow = memo(function SystemRow({ item, className }: { item: DisplayItem; className?: string }) {
  return (
    <div className={cn('px-4 text-center text-xs text-muted-foreground/80', className)}>
      {item.isError ? <span className="text-destructive">{item.content}</span> : item.content}
    </div>
  );
});
