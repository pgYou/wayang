import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '@/tui/theme';
import type { ActiveWorkerInfo } from '@/types/index';

interface WorkerListOverlayProps {
  workers: ActiveWorkerInfo[];
  onSelect: (workerId: string) => void;
  onDismiss: () => void;
}

export function WorkerListOverlay({ workers, onSelect, onDismiss }: WorkerListOverlayProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_ch, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }
    if (key.return && workers.length > 0) {
      onSelect(workers[selectedIndex]!.workerId);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(i => (i - 1 + workers.length) % workers.length);
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(i => (i + 1) % workers.length);
      return;
    }
  });

  if (workers.length === 0) {
    return (
      <Box paddingX={1} borderStyle="single" borderColor="gray">
        <Text dimColor>No active workers</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold dimColor>Workers ({workers.length})</Text>
      {workers.map((w, i) => {
        const isSelected = i === selectedIndex;
        const elapsed = Math.round((Date.now() - w.startedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;

        return (
          <Box key={w.workerId}>
            <Text color={isSelected ? theme.baseToken.color.accent : undefined}>
              {isSelected ? '▸ ' : '  '}
            </Text>
            <Text bold={isSelected} color={isSelected ? theme.baseToken.color.accent : theme.baseToken.color.textNormal}>
              {w.emoji} {w.taskTitle}
            </Text>
            <Text dimColor> {w.workerType} · {w.taskId} · {timeStr}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
