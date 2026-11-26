import { Settings2Icon, TerminalSquareIcon } from 'lucide-react';
import { useConnectionStatus, useBusy, usePendingInquiry, useContextUsage, useActiveWorkers, useTasks } from '@/renderer/shared/lib/store';
import { router } from '@/renderer/shared/lib/router';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { submitInput } from '@/renderer/shared/lib/session-lazy';
import { AppHeader } from '@/renderer/shared/components/shared/app-header';
import { ChatArea } from './chat-area';
import { Composer } from './parts/composer';
import { InquiryCard } from './parts/inquiry-card';
import { SessionMenu } from './parts/session-menu';
import { Button } from '@/renderer/shared/components/ui/button';

/**
 * 主对话页（页面编排层）：
 * - header 复用 AppHeader（48px、拖拽区、红绿灯区、logo）；右侧注入运行中
 *   Worker 状态 + 设置入口 + 会话切换；
 * - 主体：ChatArea（居中阅读栏）；底部按 pendingInquiry 切换 InquiryCard / Composer；
 * - 设置页经 lib/router 独立路由（/settings），本页只负责发起导航。
 */
export function ChatPage() {
  const busy = useBusy();
  const pendingInquiry = usePendingInquiry();
  const contextUsage = useContextUsage();
  const activeWorkers = useActiveWorkers();
  const tasks = useTasks();
  const connection = useConnectionStatus();

  return (
    <div className="relative flex h-full flex-col bg-background">
      <AppHeader
        right={
          <>
            {(activeWorkers.length > 0 || tasks.running.length > 0) && (
              <span className="mr-1 inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground">
                <TerminalSquareIcon className="size-3 text-muted-foreground" />
                <span>{activeWorkers.length} Worker 运行中</span>
              </span>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="打开设置" title="设置" onClick={() => router.navigate('/settings')}>
              <Settings2Icon />
            </Button>
            <SessionMenu disabled={busy} />
          </>
        }
      />

      {connection.phase === 'crashed' && (
        <div className="border-b border-destructive/30 bg-destructive-soft px-4 py-2 text-xs text-destructive">
          {connection.detail ?? 'server 已退出'}
        </div>
      )}

      <ChatArea busy={busy} onQuickPrompt={(prompt) => void submitInput(prompt)} />

      {pendingInquiry ? (
        <InquiryCard inquiry={pendingInquiry} onAnswer={(answer) => void wayang.answerInquiry(answer)} />
      ) : (
        <Composer
          busy={busy}
          connection={connection}
          activeWorkers={activeWorkers}
          tasks={tasks}
          contextUsage={contextUsage}
          onSubmit={(text) => void submitInput(text)}
          onAbort={() => void wayang.abort()}
        />
      )}
    </div>
  );
}
