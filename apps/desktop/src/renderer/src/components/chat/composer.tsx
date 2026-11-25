import { useRef, useState, type KeyboardEvent } from 'react';
import { LoaderIcon, SendIcon, SquareIcon } from 'lucide-react';
import type { ActiveWorkerInfo, ContextUsage, TaskDetail } from '@wayang-ai/protocol';
import type { ConnectionStatus } from '../../../../shared/ipc-contract';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { ContextRing } from './context-ring';
import { cn } from '../../lib/cn';

/**
 * Sender/Footer 合一（§4.3 工作项③）：悬浮输入与底部状态合并为单一
 * composer——上沿状态行（连接态 / 任务 / worker 计数 + 上下文圆环），
 * 下沿输入与发送/停止（按 busy 切换）。
 */

interface ComposerProps {
  busy: boolean;
  connection: ConnectionStatus;
  activeWorkers: ActiveWorkerInfo[];
  tasks: { pending: TaskDetail[]; running: TaskDetail[]; completed: TaskDetail[] };
  contextUsage: ContextUsage | null;
  onSubmit: (text: string) => void;
  onAbort: () => void;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'ready': return '已连接';
    case 'reconnecting': return '重连中…';
    case 'restarting': return '重启中…';
    case 'degraded': return '降级中…';
    case 'fatal': return 'server 已退出';
    case 'crashed': return 'server 已退出';
    case 'stopped': return '已停止';
    default: return '连接中…';
  }
}

export function Composer({ busy, connection, activeWorkers, tasks, contextUsage, onSubmit, onAbort }: ComposerProps) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = (): void => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue('');
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && busy) {
      onAbort();
    }
  };

  const connectionTone = connection.phase === 'ready' ? 'bg-success' : connection.phase === 'crashed' || connection.phase === 'fatal' ? 'bg-destructive' : 'bg-primary';

  return (
    <div className="border-t border-border bg-card/80 px-4 py-2">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {/* Footer line (合一): connection / tasks / workers / context ring. */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className={cn('size-2 rounded-full', busy ? 'animate-pulse ' + connectionTone : connectionTone)} />
            {phaseLabel(connection.phase)}
          </span>
          {busy && <Badge>思考中</Badge>}
          <span className="ml-auto flex items-center gap-3">
            <span>
              任务 <span className="text-foreground">{tasks.pending.length}</span> 排队 ·{' '}
              <span className="text-foreground">{tasks.running.length}</span> 运行 ·{' '}
              <span className="text-foreground">{tasks.completed.length}</span> 完成
            </span>
            <span>
              workers <span className="text-foreground">{activeWorkers.length}</span>
            </span>
            <ContextRing usage={contextUsage} />
          </span>
        </div>

        {/* Sender line: input + send/stop switched by busy. */}
        <div className="flex items-end gap-2">
          <Textarea
            ref={ref}
            rows={2}
            value={value}
            placeholder="给 Wayang 说点什么…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="flex shrink-0 flex-col gap-2">
            {busy ? (
              <>
                <Button size="sm" variant="destructive" onClick={onAbort}>
                  <SquareIcon />
                  停止
                </Button>
                <Button size="sm" disabled>
                  <LoaderIcon className="animate-spin" />
                  发送
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={send} disabled={!value.trim()}>
                <SendIcon />
                发送
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
