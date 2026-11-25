import { memo } from 'react';
import { ESignalSubtype } from '@wayang-ai/protocol/types/conversation';
import type { DisplayItem } from '../../lib/display';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';

function toneFor(subtype?: string): { border: string; badge: 'blue' | 'neutral' | 'success' | 'danger' } {
  switch (subtype) {
    case ESignalSubtype.WorkerCompleted:
      return { border: 'border-l-success', badge: 'success' };
    case ESignalSubtype.WorkerFailed:
      return { border: 'border-l-danger', badge: 'danger' };
    case ESignalSubtype.PermissionRequest:
    case ESignalSubtype.WorkerInquiry:
    case ESignalSubtype.InquiryTimeout:
      return { border: 'border-l-primary', badge: 'blue' };
    default:
      return { border: 'border-l-primary-border', badge: 'neutral' };
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

/** Worker / 系统事件信号行：emoji、任务标签、摘要（memo：见 §2.7 行级重绘纪律）。 */
export const SignalRow = memo(function SignalRow({ item }: { item: DisplayItem }) {
  const tone = toneFor(item.subtype);
  return (
    <div className="px-4">
      <div
        className={cn(
          'max-w-[92%] rounded-lg border border-border border-l-[3px] bg-surface/70 px-3 py-1.5 text-sm',
          tone.border,
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {item.emoji && <span aria-hidden>{item.emoji}</span>}
          <Badge tone={tone.badge}>{labelFor(item.subtype)}</Badge>
          {item.taskTitle && (
            <span className="max-w-[50%] truncate text-xs font-medium text-primary-strong">{item.taskTitle}</span>
          )}
          {item.workerType && !item.emoji && (
            <span className="text-[11px] text-muted-foreground">{item.workerType}</span>
          )}
        </div>
        {item.content && (
          <p className="mt-1 whitespace-pre-wrap break-all text-xs leading-relaxed text-muted-foreground">
            {item.content}
          </p>
        )}
        {item.permissionMeta && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
            {item.permissionMeta.toolName} · 审批由 Controller 决定
          </p>
        )}
      </div>
    </div>
  );
});
