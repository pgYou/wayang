import type { DisplayItem } from '../../lib/display';
import { cn } from '../../lib/cn';

/** The user's own message — the light-blue presence in the conversation. */
export function UserRow({ item }: { item: DisplayItem }) {
  return (
    <div className="flex justify-end px-4">
      <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-tr-md border border-primary-border bg-primary-soft px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {item.content}
      </div>
    </div>
  );
}

export function SystemRow({ item, className }: { item: DisplayItem; className?: string }) {
  return (
    <div className={cn('px-4 text-center text-xs text-muted-foreground/80', className)}>
      {item.isError ? <span className="text-danger">{item.content}</span> : item.content}
    </div>
  );
}
