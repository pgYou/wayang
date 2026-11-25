import { useEffect } from 'react';
import {
  useConnectionStatus,
  useBusy,
  usePendingInquiry,
  useContextUsage,
  useActiveWorkers,
  useTasks,
  wayangStore,
} from './lib/store';
import { wayang } from './lib/wayang-api';
import { ChatArea } from './components/chat/chat-area';
import { InputArea } from './components/input-area';
import { InquiryCard } from './components/inquiry-card';
import { StatusBar } from './components/status-bar';

export function App() {
  // Fixed boot sequence (§2.7): snapshot first, then incremental
  // subscription — the first-paint race (a4) dissolves here.
  useEffect(() => {
    void wayangStore.boot().then(() => {
      void wayang.rendererLog({ level: 'info', message: 'renderer store hydrated' }).catch(() => undefined);
    });
  }, []);

  // Per-slice subscriptions: a streaming update re-renders only the
  // streaming section inside ChatArea, never this tree.
  const busy = useBusy();
  const pendingInquiry = usePendingInquiry();
  const contextUsage = useContextUsage();
  const activeWorkers = useActiveWorkers();
  const tasks = useTasks();
  const connection = useConnectionStatus();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-card/80 px-4 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          W
        </span>
        <span className="text-sm font-semibold">Wayang</span>
        <span className="text-xs text-muted-foreground">多智能体编排工作台</span>
      </header>

      {connection.phase === 'crashed' && (
        <div className="border-b border-destructive/30 bg-destructive-soft px-4 py-2 text-xs text-destructive">
          {connection.detail ?? 'server 已退出'}
        </div>
      )}

      <ChatArea busy={busy} />

      {pendingInquiry ? (
        <InquiryCard inquiry={pendingInquiry} onAnswer={(answer) => void wayang.answerInquiry(answer)} />
      ) : (
        <InputArea
          busy={busy}
          onSubmit={(text) => void wayang.sendInput(text)}
          onAbort={() => void wayang.abort()}
        />
      )}

      <StatusBar
        busy={busy}
        activeWorkers={activeWorkers}
        tasks={tasks}
        contextUsage={contextUsage}
        connection={connection}
      />
    </div>
  );
}
