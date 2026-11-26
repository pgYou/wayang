import type { ReactNode } from 'react';
import type { ActiveWorkerInfo, ContextUsage, TaskDetail } from '@wayang-ai/protocol';
import type { ConnectionStatus } from '@/shared/ipc-contract';
import { Sender } from '@/renderer/shared/components/ui/sender';
import { ContextRing } from './context-ring';
import { cn } from '@/renderer/shared/lib/cn';
import './composer.scss';

/**
 * Composer——消息撰写区（邮件/IM 领域行话：输入框及其周边
 * 操作件的整块组合，非「组合器」）。职责：
 * - 悬浮卡片容器（wayang-composer-float 四向白光）fixed 在对话流底部，
 *   不占滚动流布局——ChatArea 靠底部 padding 保证最新内容不被遮挡；
 * - 输入框使用 Sender 组件；连接态 / 任务 / worker 计数
 *   走 prefix 插槽，上下文圆环走 suffix 插槽；
 * - overlayTop 插槽：「浮在卡片上缘之上」元素的统一挂载层（回底按钮、
 *   未来的指令输入浮层等）。层由本组件锚定（bottom-full，卡片伸缩自动
 *   跟随，无需 JS 测量）；挂什么由 chat-page 决定，本组件不感知业务。
 *   层容器 pointer-events-none，悬浮元素自行声明 pointer-events-auto。
 */

interface ComposerProps {
  busy: boolean;
  connection: ConnectionStatus;
  activeWorkers: ActiveWorkerInfo[];
  tasks: { pending: TaskDetail[]; running: TaskDetail[]; completed: TaskDetail[] };
  contextUsage: ContextUsage | null;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  /** 悬浮在卡片上缘之上的元素层（回底按钮、指令浮层等），见组件注释。 */
  overlayTop?: ReactNode;
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

export function Composer({
  busy,
  connection,
  activeWorkers,
  tasks,
  contextUsage,
  onSubmit,
  onAbort,
  overlayTop,
}: ComposerProps) {
  const connectionTone =
    connection.phase === 'ready'
      ? 'bg-success'
      : connection.phase === 'crashed' || connection.phase === 'fatal'
        ? 'bg-destructive'
        : 'bg-sky';

  const status = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1 rounded-md bg-grey-2 px-2 py-1 text-foreground">
        <span className={cn('size-2 rounded-full', connectionTone, busy && 'animate-pulse')} />
        <span>{busy ? '思考中' : phaseLabel(connection.phase)}</span>
      </span>
      <span className="hidden sm:inline">
        任务 <span className="font-medium text-foreground">{tasks.pending.length}</span> 排队
        {' · '}workers <span className="font-medium text-foreground">{activeWorkers.length}</span>
      </span>
    </div>
  );

  return (
    // 定位容器由 chat-page 的浮层持有；本组件只负责内容布局：居中限宽 +
    // 底距 + 点击穿透（卡片本体恢复可点）。
    <div className="pointer-events-none flex h-full justify-center px-6 pb-4">
      <div className="wayang-composer-float pointer-events-auto relative w-full max-w-3xl rounded-xl">
        {/* 悬浮元素层（架构锚点）：bottom-full 锚在卡片上缘——卡片伸缩
            自动跟随，子元素只做排布不再各自定位；层穿透，可点元素自行
            pointer-events-auto；z-20 只被 popover/dialog（z-50）压住。 */}
        {overlayTop !== undefined && (
          <div className="wayang-composer-overlay pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 flex flex-col items-center gap-2">
            {overlayTop}
          </div>
        )}
        <Sender
          loading={busy}
          placeholder="输入任务或指令，Enter 发送，Shift+Enter 换行…"
          prefix={status}
          suffix={<ContextRing usage={contextUsage} />}
          onSubmit={onSubmit}
          onCancel={onAbort}
        />
      </div>
    </div>
  );
}
