import { describe, it, expect } from 'vitest';
import { SLICE, selectTasks } from '../store';
import type { TaskDetail } from '@wayang-ai/protocol';

const task = (id: string, status: TaskDetail['status']): TaskDetail =>
  ({ id, status, description: `task ${id}`, priority: 'normal', createdAt: 1 }) as TaskDetail;

describe('SLICE', () => {
  it('subscribes the task history path core actually writes', () => {
    // Core's TaskExecuteEngine appends terminal tasks to `tasks.history`;
    // the old `tasks.completed` slice was a dead path (counter stuck at 0).
    expect(SLICE.tasksHistory).toBe('engine:tasks.history');
    expect(Object.values(SLICE)).not.toContain('engine:tasks.completed');
  });
});

describe('selectTasks', () => {
  it('counts only cleanly completed tasks out of the history slice', () => {
    const s = {
      [SLICE.tasksPending]: [task('p1', 'pending')],
      [SLICE.tasksRunning]: [task('r1', 'running')],
      [SLICE.tasksHistory]: [
        task('c1', 'completed'),
        task('x1', 'failed'),
        task('x2', 'cancelled'),
        task('c2', 'completed'),
      ],
    };
    expect(selectTasks(s)).toEqual({
      pending: [task('p1', 'pending')],
      running: [task('r1', 'running')],
      completed: [task('c1', 'completed'), task('c2', 'completed')],
    });
  });

  it('falls back to empty arrays when no slice has arrived yet', () => {
    expect(selectTasks({})).toEqual({ pending: [], running: [], completed: [] });
  });
});
