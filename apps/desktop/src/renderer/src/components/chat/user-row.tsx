import { memo } from 'react';
import type { DisplayItem } from '../../lib/display';
import { cn } from '../../lib/cn';

/**
 * The user's own message — the light-blue presence in the conversation.
 * Memoized: rows receive stable item references from the memoized section
 * builders (§2.7), so a streaming update skips re-rendering them.
 */
export const UserRow = memo(function UserRow({ item }: { item: DisplayItem }) {
  return (
    <div className="flex justify-end px-4">
      <div className="max-w-[78%] whitespace-pre-wrap rounded-xl rounded-tr-md border border-primary-border bg-primary-soft px-4 py-2 text-sm leading-relaxed text-foreground">
        {item.content}
      </div>
    </div>
  );
});

export const SystemRow = memo(function SystemRow({ item, className }: { item: DisplayItem; className?: string }) {
  return (
    <div className={cn('px-4 text-center text-xs text-muted-foreground/80', className)}>
      {item.isError ? <span className="text-danger">{item.content}</span> : item.content}
    </div>
  );
});
