import { useMemo } from 'react';
import { CloudIcon, Settings2Icon, TerminalSquareIcon } from 'lucide-react';
import { EEntryType } from '@wayang-ai/protocol/types/conversation';
import { useConnectionStatus, useBusy, usePendingInquiry, useContextUsage, useActiveWorkers, useTasks, useConversation } from '@/renderer/shared/lib/store';
import { router } from '@/renderer/shared/lib/router';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { submitInput } from '@/renderer/shared/lib/session-lazy';
import { ChatArea } from './chat-area';
import { Composer } from './parts/composer';
import { InquiryCard } from './parts/inquiry-card';
import { SessionMenu } from './parts/session-menu';
import { Button } from '@/renderer/shared/components/ui/button';

/**
 * 主对话页（页面编排层）：
 * - header：W 标识 + 会话标题（取首条 user 消息）+ 运行中 Worker 状态 + 设置入口 + 会话切换；
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
  const conversation = useConversation();

  // 会话标题：第一条 user 消息首行截断（无则「新对话」）。
  const sessionTitle = useMemo(() => {
    const firstUser = conversation.find((e) => e.type === EEntryType.User);
    if (!firstUser || firstUser.type !== EEntryType.User) return '新对话';
    const firstLine = firstUser.message.content.split('\n')[0].trim();
    if (!firstLine) return '新对话';
    return firstLine.length > 28 ? `${firstLine.slice(0, 28)}…` : firstLine;
  }, [conversation]);

  return (
    <div className="relative flex h-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          W
        </span>
        <span className="max-w-xs truncate text-sm font-medium text-foreground">{sessionTitle}</span>
        <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground">
          <CloudIcon className="size-3" />
          <span>Wayang</span>
        </span>

        {/* 右上角：运行中 Worker 概览 + 设置入口 + 会话切换【…】 */}
        <span className="ml-auto flex items-center gap-1">
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
        </span>
      </header>

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
