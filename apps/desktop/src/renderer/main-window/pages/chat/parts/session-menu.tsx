import { useEffect, useState } from 'react';
import { EllipsisIcon, HistoryIcon, LoaderIcon, PlusIcon } from 'lucide-react';
import type { SessionIndexEntry } from '@/shared/ipc-contract';
import { wayang } from '@/renderer/shared/lib/wayang-api';
import { wayangStore } from '@/renderer/shared/lib/store';
import { beginNewSession, cancelLazyNewSession } from '@/renderer/shared/lib/session-lazy';
import { Badge } from '@/renderer/shared/components/ui/badge';
import { Button } from '@/renderer/shared/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/shared/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/shared/components/ui/dropdown-menu';
import { ScrollArea } from '@/renderer/shared/components/ui/scroll-area';
import { Skeleton } from '@/renderer/shared/components/ui/skeleton';

/**
 * 会话切换入口：header 右上角【…】下拉，
 * 两项——【新会话】（确认后经 new-session 通道开新会话）与【历史会话】
 * （弹框：list-sessions 时间/摘要列表，选中确认 → switch-session →
 * store.rehydrate 快照重放恢复目标会话）。
 */

function formatTime(ts: number): string {
  const date = new Date(ts);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

interface SessionMenuProps {
  /** Disable while a turn is running or a switch is in flight. */
  disabled?: boolean;
}

export function SessionMenu({ disabled }: SessionMenuProps) {
  const [confirmNew, setConfirmNew] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionIndexEntry[] | null>(null);
  const [selected, setSelected] = useState<SessionIndexEntry | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the session index when the history dialog opens.
  useEffect(() => {
    if (!historyOpen) return;
    setSessions(null);
    setError(null);
    void wayang
      .listSessions()
      .then((entries) => setSessions(entries))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [historyOpen]);

  /** 「新会话」走懒加载：本地清空即完成，server 会话等首条消息再创建。 */
  const startLazyNew = (): void => {
    beginNewSession();
    setConfirmNew(false);
    setSelected(null);
  };

  /** Switch (target) then rehydrate the renderer store. */
  const runSwitch = async (action: () => Promise<unknown>): Promise<void> => {
    setSwitching(true);
    setError(null);
    // 切换即取消懒新会话态：恢复旧会话视图后，下一条输入不得被误判为新会话首条消息。
    cancelLazyNewSession();
    try {
      await action();
      await wayangStore.rehydrate();
      setConfirmNew(false);
      setHistoryOpen(false);
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" data-testid="session-menu-trigger" aria-label="会话菜单" disabled={disabled}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>会话</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="session-menu-new" onSelect={() => setConfirmNew(true)}>
            <PlusIcon />
            新会话
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="session-menu-history" onSelect={() => setHistoryOpen(true)}>
            <HistoryIcon />
            历史会话…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 新会话确认 */}
      <Dialog open={confirmNew} onOpenChange={setConfirmNew}>
        <DialogContent className="max-w-sm" data-testid="session-new-dialog">
          <DialogHeader>
            <DialogTitle>开启新会话？</DialogTitle>
            <DialogDescription>当前会话将保留在历史中，切换后可随时回来。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" data-testid="session-new-cancel" onClick={() => setConfirmNew(false)} disabled={switching}>
              取消
            </Button>
            <Button data-testid="session-new-confirm" onClick={startLazyNew} disabled={switching}>
              开新会话
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 历史会话弹框：时间 / 摘要列表 */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-md" data-testid="session-history-dialog">
          <DialogHeader>
            <DialogTitle>历史会话</DialogTitle>
            <DialogDescription>选择一个会话切换（当前界面将重放恢复目标会话内容）。</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-72">
            <div className="flex flex-col gap-2 pr-2">
              {sessions === null && !error && (
                <>
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </>
              )}
              {error && <p className="px-1 text-sm text-destructive">{error}</p>}
              {sessions?.length === 0 && <p className="px-1 py-4 text-sm text-muted-foreground">暂无历史会话</p>}
              {sessions?.map((entry) => (
                <button
                  key={entry.sessionId}
                  type="button"
                  data-testid="session-item"
                  data-id={entry.sessionId}
                  aria-pressed={entry.sessionId === selected?.sessionId}
                  onClick={() => setSelected(entry)}
                  className="flex flex-col items-start gap-1 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="font-medium">{entry.title ?? '（无摘要）'}</span>
                    {entry.sessionId === selected?.sessionId && <Badge className="ml-auto">已选中</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    最近活跃 {formatTime(entry.lastActiveAt)} · 创建于 {formatTime(entry.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="ghost" data-testid="session-history-cancel" onClick={() => setHistoryOpen(false)} disabled={switching}>
              取消
            </Button>
            <Button
              data-testid="session-switch-confirm"
              onClick={() => selected && void runSwitch(() => wayang.switchSession(selected.sessionId))}
              disabled={switching || selected === null}
            >
              {switching && <LoaderIcon className="animate-spin" />}
              切换到所选会话
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
