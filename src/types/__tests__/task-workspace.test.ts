import { describe, it, expect } from 'vitest';
import type { TaskDetail } from '@/types/task';

/** A task with every required field and no optional ones. */
function makeTask(): TaskDetail {
  return {
    id: 't-1',
    title: 'Do the thing',
    description: 'Do it carefully',
    priority: 'normal',
    status: 'pending',
    createdAt: 1000,
  };
}

describe('TaskDetail workspace', () => {
  it('round-trips a task carrying a workspace through JSON', () => {
    const task: TaskDetail = {
      ...makeTask(),
      workspace: { path: '/repo/my-project', slug: 'my-project' },
    };

    const parsed = JSON.parse(JSON.stringify(task)) as TaskDetail;
    expect(parsed.workspace).toEqual({ path: '/repo/my-project', slug: 'my-project' });
    expect(parsed).toEqual(task);
  });

  it('serializes a task without a workspace, leaving the field absent', () => {
    const task = makeTask();
    const roundTripped = JSON.parse(JSON.stringify(task)) as TaskDetail;

    expect('workspace' in roundTripped).toBe(false);
    expect(roundTripped.workspace).toBeUndefined();
    expect(roundTripped).toEqual(task);
  });

  it('keeps other optional fields intact alongside a workspace', () => {
    const task: TaskDetail = {
      ...makeTask(),
      status: 'completed',
      startedAt: 2000,
      completedAt: 3000,
      result: 'done',
      workerType: 'claude-code',
      workerTranscriptId: 'cw-1',
      workspace: { path: '/repo/a', slug: 'a' },
    };

    const parsed = JSON.parse(JSON.stringify(task)) as TaskDetail;
    expect(parsed).toEqual(task);
    expect(parsed.workspace?.slug).toBe('a');
    expect(parsed.workerTranscriptId).toBe('cw-1');
  });

  it('reads a task written before workspaces existed', () => {
    // Shape of a persisted task from an older version.
    const legacy = {
      id: 't-old',
      title: 'Old',
      description: 'legacy task',
      priority: 'high',
      status: 'completed',
      createdAt: 1,
      result: 'ok',
    } as TaskDetail;

    expect(legacy.workspace).toBeUndefined();
    expect(legacy.id).toBe('t-old');
  });
});
