import React, { useMemo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { TaskDetail, ActiveWorkerInfo } from '@/types/index';

export function StatusBar({
  activeWorkers,
  pendingTasks,
  runningTasks,
}: {
  activeWorkers: ActiveWorkerInfo[];
  pendingTasks: TaskDetail[];
  runningTasks: TaskDetail[];
}) {
  const [now, setNow] = useState(() => Date.now());

  // Refresh every 5s to update elapsed time
  useEffect(() => {
    if (activeWorkers.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeWorkers.length]);

  const workerRows = useMemo(() => {

    return activeWorkers.map(w => {
      const task = runningTasks.find(t => t.id === w.taskId);
      const elapsed = Math.round((now - w.startedAt) / 1000);
      const label = task ? ((task.title || task.description).slice(0, 20)) : w.taskId.slice(0, 8);
      return { workerId: w.workerId, label, elapsed };
    })
  },
    [activeWorkers, runningTasks, now],
  );

  if (activeWorkers.length === 0 && pendingTasks.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (pendingTasks.length > 0) {
    parts.push(`pending tasks:${pendingTasks.length}`);
  }
  if (activeWorkers.length > 0) {
    parts.push(`active workers:${activeWorkers.length}`);
  }

  return (
    <Box paddingX={1} marginTop={0}>
      <Text dimColor> {parts.join(' │ ')} </Text>
      {workerRows.map((r, i) => (
        <React.Fragment key={r.workerId}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text dimColor color="blue">{r.label} ({r.elapsed}s)</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
