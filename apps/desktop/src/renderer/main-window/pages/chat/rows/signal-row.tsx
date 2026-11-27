import { memo, useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { ESignalSubtype } from '@wayang-ai/protocol/types/conversation';
import type { DisplayItem } from '@/renderer/shared/lib/display';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { cn } from '@/renderer/shared/lib/cn';

function toneFor(subtype?: string): { dot: string; badge: 'default' | 'outline' | 'success' | 'destructive' } {
  switch (subtype) {
    case ESignalSubtype.WorkerCompleted:
      return { dot: 'bg-success', badge: 'success' };
    case ESignalSubtype.WorkerFailed:
      return { dot: 'bg-destructive', badge: 'destructive' };
    case ESignalSubtype.PermissionRequest:
    case ESignalSubtype.WorkerInquiry:
    case ESignalSubtype.InquiryTimeout:
      return { dot: 'bg-sky', badge: 'default' };
    default:
      return { dot: 'bg-muted-foreground', badge: 'outline' };
  }
}

function labelFor(subtype?: string): string {
  switch (subtype) {
    case ESignalSubtype.WorkerProgress: return '进度';
    case ESignalSubtype.WorkerCompleted: return '完成';
    case ESignalSubtype.WorkerFailed: return '失败';
    case ESignalSubtype.WorkerDisposed: return '释放';
    case ESignalSubtype.TaskCancelled: return '已取消';
    case ESignalSubtype.TaskQueued: return '排队';
    case ESignalSubtype.WorkerStarted: return '启动';
    case ESignalSubtype.PermissionRequest: return '权限请求';
    case ESignalSubtype.WorkerInquiry: return 'worker 提问';
    case ESignalSubtype.InquiryTimeout: return '提问超时';
    case ESignalSubtype.MessageUndelivered: return '未送达';
    default: return '信号';
  }
}

/** Worker / 系统事件信号行：紧凑内联事件条，长内容支持折叠展开（memo 化的稳定引用避免流式重绘）。 */
export const SignalRow = memo(function SignalRow({ item }: { item: DisplayItem }) {
  const [open, setOpen] = useState(false);
  const tone = toneFor(item.subtype);
  const hasDetail = Boolean(item.content || item.permissionMeta);

  return (
    <div className="wayang-signal-row rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
      <div
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn('flex items-center gap-2', hasDetail && 'cursor-pointer select-none')}
      >
        <span className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
        {item.emoji && <span aria-hidden>{item.emoji}</span>}
        <Badge variant={tone.badge}>{labelFor(item.subtype)}</Badge>
        {item.taskTitle && (
          <span className="truncate font-medium text-foreground">{item.taskTitle}</span>
        )}
        {item.workerType && !item.emoji && (
          <span className="text-[11px] text-muted-foreground">{item.workerType}</span>
        )}
        {!open && item.content && (
          <span className="ml-1 flex-1 truncate text-muted-foreground">{item.content}</span>
        )}
        {hasDetail && (
          <ChevronRightIcon
            className={cn(
              'ml-auto size-3 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-90',
            )}
          />
        )}
      </div>
      {open && (
        <div className="mt-2 border-t border-border/70 pt-2">
          {item.content && (
            <p className="m-0 whitespace-pre-wrap break-all leading-relaxed text-muted-foreground">
              {item.content}
            </p>
          )}
          {item.permissionMeta && (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
              {item.permissionMeta.toolName} · 审批由 Controller 决定
            </p>
          )}
        </div>
      )}
    </div>
  );
});
