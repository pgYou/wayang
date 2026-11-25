import { useMemo } from 'react';
import {
  useWayangSlices,
  useConnectionStatus,
  buildDisplayItems,
  selectBusy,
  selectPendingInquiry,
  selectContextUsage,
  selectActiveWorkers,
  selectTasks,
} from './lib/store';
import { wayang } from './lib/wayang-api';
import { ChatArea } from './components/chat/chat-area';
import { InputArea } from './components/input-area';
import { InquiryCard } from './components/inquiry-card';
import { StatusBar } from './components/status-bar';

export function App() {
  const slices = useWayangSlices();
  const connection = useConnectionStatus();

  const items = useMemo(() => buildDisplayItems(slices), [slices]);
  const busy = selectBusy(slices);
  const pendingInquiry = selectPendingInquiry(slices);
  const contextUsage = selectContextUsage(slices);
  const activeWorkers = selectActiveWorkers(slices);
  const tasks = selectTasks(slices);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-surface/80 px-4 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
          W
        </span>
        <span className="text-sm font-semibold">Wayang</span>
        <span className="text-xs text-muted-foreground">多智能体编排工作台</span>
      </header>

      {connection.phase === 'crashed' && (
        <div className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-xs text-danger">
          {connection.detail ?? 'server 已退出'}
        </div>
      )}

      <ChatArea items={items} busy={busy} streamingItems={[]} />

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
