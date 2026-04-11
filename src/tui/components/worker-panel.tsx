import React from 'react';
import { Box, Text } from 'ink';

interface WorkerInfo {
  workerId: string;
  taskId: string;
  startedAt: number;
}

export function WorkerPanel({ workers }: { workers: WorkerInfo[] }) {
  if (workers.length === 0) {
    return <Text dimColor> No active workers</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold>Workers ({workers.length})</Text>
      {workers.map(w => (
        <WorkerRow key={w.workerId} worker={w} />
      ))}
    </Box>
  );
}

function WorkerRow({ worker }: { worker: WorkerInfo }) {
  const elapsed = Math.round((Date.now() - worker.startedAt) / 1000);
  return (
    <Box>
      <Text color="blue">W</Text>
      <Text> {worker.workerId.slice(0, 12)}</Text>
      <Text dimColor> task:{worker.taskId.slice(0, 12)} {elapsed}s</Text>
    </Box>
  );
}
