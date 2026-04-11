import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useSupervisor } from '@/tui/providers/supervisor-provider';
import { useWayangState } from '@/tui/hooks/use-wayang-state';
import { theme } from '@/tui/theme';
import type { ConversationEntry } from '@/types/conversation';
import type { ActiveWorkerInfo } from '@/types/index';
import type { BaseWayangState } from '@/infra/state/base-state';

/** Max visible entries in worker detail view. */
const MAX_VISIBLE_ENTRIES = 15;
/** Max characters for user/assistant content. */
const CONTENT_MAX_LENGTH = 100;
/** Max characters for tool/sys content. */
const TOOL_CONTENT_MAX_LENGTH = 80;

export function WorkerDetailPage({ workerId, onBack }: { workerId: string; onBack: () => void }) {
  const supervisor = useSupervisor();
  const workerState = supervisor.getWorkerState(workerId);

  if (!workerState) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Worker {workerId} not found</Text>
        <Text color="gray">Press ESC to go back</Text>
      </Box>
    );
  }

  return <WorkerContent workerState={workerState} workerId={workerId} />;
}

function WorkerContent({ workerState, workerId }: { workerState: BaseWayangState; workerId: string }) {
  const supervisor = useSupervisor();
  const taskInfo = useWayangState<any>(workerState, 'runtimeState.task');
  const conversation = useWayangState<ConversationEntry[]>(workerState, 'conversation');
  const activeWorkers = useWayangState<ActiveWorkerInfo[]>(
    supervisor.controllerState, 'runtimeState.activeWorkers',
  );

  const workerInfo = useMemo(
    () => (activeWorkers ?? []).find(w => w.workerId === workerId),
    [activeWorkers, workerId],
  );
  const isRunning = !!workerInfo;

  const emoji = workerInfo?.emoji ?? '?';
  const workerType = workerInfo?.workerType ?? 'puppet';
  const taskTitle = workerInfo?.taskTitle ?? taskInfo?.title ?? 'N/A';

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
        {!isRunning && <Text dimColor>Done</Text>}
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
