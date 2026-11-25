import type { ActiveWorkerInfo, TaskDetail, ContextUsage } from '@wayang-ai/protocol';
import { Badge } from './ui/badge';

interface StatusBarProps {
  busy: boolean;
  activeWorkers: ActiveWorkerInfo[];
  tasks: { pending: TaskDetail[]; running: TaskDetail[]; completed: TaskDetail[] };
  contextUsage: ContextUsage | null;
  connection: { phase: string; detail?: string };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 底部状态条：连接态 / 任务 / worker / 上下文占用（对应 TUI StatusBar）。 */
export function StatusBar({ busy, activeWorkers, tasks, contextUsage, connection }: StatusBarProps) {
  const usage = contextUsage
    ? Math.min(100, Math.round((contextUsage.usedTokens / Math.max(1, contextUsage.contextWindowTokens)) * 100))
    : null;

  return (
    <footer className="flex items-center gap-3 border-t border-border bg-surface/80 px-4 py-1.5 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={
            connection.phase === 'ready'
              ? 'h-2 w-2 rounded-full bg-success'
              : connection.phase === 'crashed'
                ? 'h-2 w-2 rounded-full bg-danger'
                : 'h-2 w-2 animate-pulse rounded-full bg-primary'
          }
        />
        {connection.phase === 'ready'
          ? '已连接'
          : connection.phase === 'reconnecting'
            ? '重连中…'
            : connection.phase === 'crashed'
              ? 'server 已退出'
              : '连接中…'}
      </span>
      {busy && <Badge tone="blue">思考中</Badge>}
      <span className="ml-auto flex items-center gap-3">
        <span>
          任务 <span className="text-foreground">{tasks.pending.length}</span> 排队 ·{' '}
          <span className="text-foreground">{tasks.running.length}</span> 运行 ·{' '}
          <span className="text-foreground">{tasks.completed.length}</span> 完成
        </span>
        <span>
          workers <span className="text-foreground">{activeWorkers.length}</span>
        </span>
        {usage !== null && (
          <span>
            上下文 <span className={usage > 80 ? 'font-medium text-danger' : 'text-foreground'}>{usage}%</span>
            <span className="text-muted-foreground/70">
              {' '}
              ({formatTokens(contextUsage!.usedTokens)}/{formatTokens(contextUsage!.contextWindowTokens)})
            </span>
          </span>
        )}
      </span>
    </footer>
  );
}
