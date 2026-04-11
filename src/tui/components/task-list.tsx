import React from 'react';
import { Box, Text } from 'ink';
import type { TaskDetail } from '@/types/task';

/** Max visible tasks in the list. */
const MAX_VISIBLE_TASKS = 10;
/** Max characters for task description. */
const DESC_MAX_LENGTH = 50;
/** Max characters for error message. */
const ERROR_MAX_LENGTH = 40;

const STATUS_COLORS: Record<string, string> = {
  pending: 'yellow',
  running: 'blue',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
};

export function TaskList({ tasks }: { tasks: TaskDetail[] }) {
  if (tasks.length === 0) {
    return <Text dimColor> No tasks</Text>;
  }

  const visible = tasks.slice(-MAX_VISIBLE_TASKS);

  return (
    <Box flexDirection="column">
      <Text bold>Tasks ({tasks.length})</Text>
      {visible.map(task => (
        <TaskRow key={task.id} task={task} />
      ))}
    </Box>
  );
}

function TaskRow({ task }: { task: TaskDetail }) {
  const color = STATUS_COLORS[task.status] ?? 'white';
  const age = task.completedAt
    ? `${Math.round((task.completedAt - task.createdAt) / 1000)}s`
    : `${Math.round((Date.now() - task.createdAt) / 1000)}s`;

  return (
    <Box>
      <Text color={color}>[{task.status.padEnd(9)}]</Text>
      <Text> {task.description.slice(0, DESC_MAX_LENGTH)}</Text>
      <Text dimColor> {age}</Text>
      {task.error && <Text color="red"> FAIL: {task.error.slice(0, ERROR_MAX_LENGTH)}</Text>}
    </Box>
  );
}
