import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { useSupervisor } from '@/tui/providers/supervisor-provider';
import { useWayangState } from '@/tui/hooks/use-wayang-state';
import { theme } from '@/tui/theme';
import type { ConversationEntry } from '@/types/conversation';
import type { ActiveWorkerInfo } from '@/types/index';
import type { TaskDetail } from '@/types/task';
import type { Subscribable } from '@/infra/state/subscribable';

/** Max visible entries in worker detail view. */
const MAX_VISIBLE_ENTRIES = 15;
/** Max characters for user/assistant content. */
const CONTENT_MAX_LENGTH = 100;
/** Max characters for tool/sys content. */
const TOOL_CONTENT_MAX_LENGTH = 80;

export function WorkerDetailPage({ workerId, onBack }: { workerId: string; onBack: () => void }) {
  const supervisor = useSupervisor();
  const liveWorker = supervisor.engine.getWorkerState(workerId);
  const [cachedWorker, setCachedWorker] = useState<Subscribable | null>(null);

  // Cache the worker so it survives removal from the engine's workers Map.
  // When the worker finishes, removeWorkerTracking deletes it after setTimeout(0),
  // causing getWorkerState() to return null. We keep the last-known worker to
  // continue rendering the completed worker's conversation and result.
  useEffect(() => {
    if (liveWorker) {
      setCachedWorker(liveWorker);
    }
  }, [liveWorker]);

  const worker = liveWorker ?? cachedWorker;

  if (!worker) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Worker {workerId} not found</Text>
        <Text color="gray">Press ESC to go back</Text>
      </Box>
    );
  }

  return <WorkerContent worker={worker} workerId={workerId} />;
}

function WorkerContent({ worker, workerId }: { worker: Subscribable; workerId: string }) {
  const supervisor = useSupervisor();
  const taskInfo = useWayangState<any>(worker, 'runtimeState.task');
  const conversation = useWayangState<ConversationEntry[]>(worker, 'conversation');
  const activeWorkers = useWayangState<ActiveWorkerInfo[]>(
    supervisor.engine, 'activeWorkers',
  );

  // Cache the last known workerInfo so header (emoji, type, title) survives removal
  const lastWorkerInfo = useRef<ActiveWorkerInfo | undefined>(undefined);
  const workerInfo = useMemo(
    () => (activeWorkers ?? []).find(w => w.workerId === workerId),
    [activeWorkers, workerId],
  );
  if (workerInfo) {
    lastWorkerInfo.current = workerInfo;
  }
  const displayInfo = workerInfo ?? lastWorkerInfo.current;
  const isRunning = !!workerInfo;

  // Look up the task in history to get completion status and result/error
  const taskHistory = useWayangState<TaskDetail[]>(supervisor.engine, 'tasks.history');
  const completedTask = useMemo(
    () => (taskHistory ?? []).find(t => t.workerSessionId === workerId),
    [taskHistory, workerId],
  );

  const emoji = displayInfo?.emoji ?? '?';
  const workerType = displayInfo?.workerType ?? 'puppet';
  const taskTitle = displayInfo?.taskTitle ?? taskInfo?.title ?? 'N/A';

  // Derive completion info from the task history
  const taskStatus = completedTask?.status;
  const isCompleted = taskStatus === 'completed';
  const isFailed = taskStatus === 'failed' || taskStatus === 'cancelled';

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="bold" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold>{emoji} {workerType}</Text>
        <Text dimColor> · </Text>
        <Text bold>{taskTitle}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} padding={1}>
        <Text bold>Task:</Text>
        <Text>  {taskInfo?.description ?? 'N/A'}</Text>
        <Text bold>Conversation ({conversation?.length ?? 0} entries):</Text>
        {(conversation ?? []).slice(-MAX_VISIBLE_ENTRIES).map((entry, i) => (
          <ConversationRow key={`${entry.uuid}-${i}`} entry={entry} />
        ))}
      </Box>

      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>Press Esc to go back</Text>
        {isRunning && <WorkerTimer startedAt={workerInfo!.startedAt} />}
        {!isRunning && isCompleted && (
          <Text color="green">Done — {completedTask?.result ?? ''}</Text>
        )}
        {!isRunning && isFailed && (
          <Text color="red">Failed — {completedTask?.error ?? 'Unknown error'}</Text>
        )}
        {!isRunning && !isCompleted && !isFailed && <Text dimColor>Done</Text>}
      </Box>
    </Box>
  );
}

/** Spinner + elapsed timer for running workers. */
function WorkerTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      setFrame(f => (f + 1) % theme.spinner.frames.length);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.round((now - startedAt) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;

  return (
    <Text>
      <Text color={theme.assistant.prefixColor} bold>{theme.spinner.frames[frame]} </Text>
      <Text dimColor>Running {timeStr}</Text>
    </Text>
  );
}

function ConversationRow({ entry }: { entry: ConversationEntry }) {
  switch (entry.type) {
    case 'user':
      return <Text><Text color="cyan" bold>&gt; </Text>{entry.message?.content?.slice(0, CONTENT_MAX_LENGTH)}</Text>;
    case 'assistant': {
      const items: React.ReactNode[] = [];
      if (entry.message?.content) {
        items.push(
          <Text key="text"><Text color="green">  </Text>{entry.message.content.slice(0, CONTENT_MAX_LENGTH)}</Text>,
        );
      }
      if (entry.toolCalls?.length) {
        for (const tc of entry.toolCalls) {
          items.push(
            <Text key={`tc-${tc.toolCallId}`} dimColor>  [{tc.toolName}] {tc.arguments.slice(0, TOOL_CONTENT_MAX_LENGTH)}</Text>,
          );
        }
      }
      if (entry.toolResults?.length) {
        for (const tr of entry.toolResults) {
          items.push(
            <Text key={`tr-${tr.toolCallId}`} dimColor>  [{tr.toolName}] {tr.output.value.slice(0, TOOL_CONTENT_MAX_LENGTH)}</Text>,
          );
        }
      }
      return items.length > 0 ? <>{items}</> : null;
    }
    case 'signal':
      return <Text color="yellow">  [sig] {entry.content?.slice(0, TOOL_CONTENT_MAX_LENGTH)}</Text>;
    case 'system':
      return <Text color="gray">  [sys] {entry.content?.slice(0, TOOL_CONTENT_MAX_LENGTH)}</Text>;
    default:
      return null;
  }
}
