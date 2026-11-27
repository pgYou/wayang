import { memo } from 'react';
import type { DisplayItem } from '@/renderer/shared/lib/display';
import { cn } from '@/renderer/shared/lib/cn';

/** 系统提示行：居中胶囊条（普通灰底；错误文本 destructive）。 */
export const SystemRow = memo(function SystemRow({ item, className }: { item: DisplayItem; className?: string }) {
  return (
    <div className={cn('wayang-system-row flex items-center justify-center py-1 text-center text-xs text-muted-foreground', className)}>
      <span className="rounded-full bg-muted px-3 py-1">
        {item.isError ? <span className="text-destructive">{item.content}</span> : item.content}
      </span>
    </div>
  );
});
