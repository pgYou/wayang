import { useState, useMemo } from 'react';
import { useMemoizedFn } from '@/tui/hooks/use-memoized-fn';
import { Box, useStdout } from 'ink';
import { ChatArea } from '@/tui/components/chat-area';
import { InputArea } from '@/tui/components/input-area';
import { InquiryPrompt } from '@/tui/components/inquiry-prompt';
import { StatusBar } from '@/tui/components/status-bar';
import { OverlayPanel } from '@/tui/components/overlay-panel';
import { WorkerListOverlay } from '@/tui/components/worker-list-overlay';
import { useSupervisor } from '@/tui/providers/supervisor-provider';
import { useRouter } from '@/tui/providers/route-provider';
import { useWayangState } from '@/tui/hooks/use-wayang-state';
import { useSlashCommands } from '@/tui/hooks/use-slash-commands';
import type { ConversationEntry } from '@/types/conversation';
import type { ControllerSignal, TaskDetail, InquireQuestion } from '@/types/index';
import type { ActiveWorkerInfo } from '@/types/index';
import type { DisplayItem } from '@/tui/types/display-item';
import type { Overlay } from '@/tui/types/overlay';
import { entryToDisplayItem, signalToDisplayItem } from '@/tui/types/display-item';

interface ControllerPageProps {
  onExit: () => void;
}

export function ControllerPage({ onExit }: ControllerPageProps) {
  const supervisor = useSupervisor();
  const { navigate } = useRouter();
  const { stdout } = useStdout();
  const terminalCols = stdout?.columns ?? 80;
  const chatContentWidth = terminalCols - 4;

  const conversation = useWayangState<ConversationEntry[]>(
    supervisor.controllerAgent, 'conversation',
  );

  const streamingEntries = useWayangState<ConversationEntry[]>(
    supervisor.controllerAgent, 'dynamicState.streamingEntries',
  );

  // Subscribe to signals so useMemo recomputes when signals change
  const signals = useWayangState<ControllerSignal[]>(
    supervisor.signalQueue, 'signals',
  );

  // Subscribe to active workers & tasks for status display
  const activeWorkers = useWayangState<ActiveWorkerInfo[]>(
    supervisor.engine, 'activeWorkers',
  );
  const pendingTasks = useWayangState<TaskDetail[]>(
    supervisor.engine, 'tasks.pending',
  );
  const runningTasks = useWayangState<TaskDetail[]>(
    supervisor.engine, 'tasks.running',
  );

  // Busy state from controller agent (dynamicState = not persisted)
  const agentBusy = useWayangState<boolean>(
    supervisor.controllerAgent, 'dynamicState.busy',
  );

  // Pending inquiry from controller
  const pendingInquiry = useWayangState<InquireQuestion | null>(
    supervisor.controllerAgent, 'runtimeState.pendingInquiry',
  );

  // Build DisplayItem[]: conversation entries (read) + unread signals
  const displayItems = useMemo<DisplayItem[]>(() => {
    const readItems = (conversation ?? []).map(entryToDisplayItem).filter((d): d is DisplayItem => d !== null);
    const unreadSignals = (signals ?? []).filter(s => s.status === 'unread').map(signalToDisplayItem);
    return [...readItems, ...unreadSignals];
  }, [conversation, signals]);

  // Build streaming display items from streamingEntries, deduplicated against conversation
  const streamingItems = useMemo<DisplayItem[]>(() => {
    const entries = streamingEntries ?? [];
    if (entries.length === 0) return [];
    const conversationIds = new Set((conversation ?? []).map(e => e.uuid));
    return entries
      .filter(e => !conversationIds.has(e.uuid))
      .map(entryToDisplayItem)
      .filter((d): d is DisplayItem => d !== null);
  }, [streamingEntries, conversation]);

  const [overlay, setOverlay] = useState<Overlay | null>(null);

  const busy = agentBusy ?? false;

  const dismissOverlay = useMemoizedFn(() => setOverlay(null));

  const slashCtx = useMemo(() => ({
    navigate,
  }), [navigate]);

  const { handleCommand } = useSlashCommands(supervisor, slashCtx);

  const handleSubmit = useMemoizedFn((input: string) => {
    const cmdResult = handleCommand(input);
    if (cmdResult.handled) {
      if (cmdResult.output === '__EXIT__') { onExit(); return; }
      if (cmdResult.navigate) { navigate(cmdResult.navigate); return; }
      if (cmdResult.action === 'workers') {
        setOverlay({
          kind: 'component',
          render: () => (
            <WorkerListOverlay
              workers={activeWorkers ?? []}
              onSelect={(workerId) => { dismissOverlay(); navigate({ page: 'worker', workerId }); }}
              onDismiss={dismissOverlay}
            />
          ),
          hint: '↑↓ select · enter to view · esc to dismiss',
        });
        return;
      }
      if (cmdResult.action === 'compact') {
        setOverlay(cmdResult.output ? { kind: 'text', content: cmdResult.output } : null);
        supervisor.controllerAgent.performCompaction()
          .then(() => setOverlay(null))
          .catch(() => setOverlay({ kind: 'text', content: 'Compaction failed', hint: '(esc to dismiss)' }));
        return;
      }
      if (cmdResult.output) {
        setOverlay({ kind: 'text', content: cmdResult.output, hint: '(esc to dismiss)' });
      }
      return;
    }

    setOverlay(null);
    supervisor.signalQueue.enqueue({
      source: 'user',
      type: 'input',
      payload: { text: input },
    });
    supervisor.sessionManager.onUserInput(input);
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <ChatArea
          items={displayItems}
          busy={busy}
          streamingItems={streamingItems}
          contentWidth={chatContentWidth}
        />
      </Box>
      {overlay && <OverlayPanel overlay={overlay} />}
      {pendingInquiry ? (
        <InquiryPrompt inquiry={pendingInquiry} onAnswer={(answer) => supervisor.resolveInquiry(answer)} />
      ) : (
        <InputArea onSubmit={handleSubmit} onExit={onExit} onEscape={dismissOverlay} busy={busy} />
      )}
      <StatusBar
        activeWorkers={activeWorkers ?? []}
        pendingTasks={pendingTasks ?? []}
        runningTasks={runningTasks ?? []}
      />
    </Box>
  );
}
