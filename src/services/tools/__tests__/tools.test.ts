import { describe, it, expect, vi } from 'vitest';
import type { TaskDetail, ControllerSignal } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import { listTasksTool } from '@/services/tools/list-tasks';
import { cancelTaskTool } from '@/services/tools/cancel-task';
import { getTaskDetailTool } from '@/services/tools/get-task-detail';
import { updateTaskTool } from '@/services/tools/update-task';
import { updateProgressTool } from '@/services/tools/update-progress';
import { querySignalsTool } from '@/services/tools/query-signals';
import { doneTool } from '@/services/tools/done';
import { failTool } from '@/services/tools/fail';
import { skipReplyTool } from '@/services/tools/skip-reply';
import { bashTool } from '@/services/tools/bash';

// Helper to call tool execute
async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

const makeTask = (id: string, overrides?: Partial<TaskDetail>): TaskDetail => ({
  id,
  title: `Task ${id}`,
  description: `Description for ${id}`,
  priority: 'normal',
  status: 'pending',
  createdAt: Date.now(),
  ...overrides,
});

// --- add_task ---

describe('addTaskTool', () => {
  it('should add task and return confirmation', async () => {
    const added: TaskDetail[] = [];
    const tool = addTaskTool({ addTask: (t) => added.push(t) });
    const result = await exec(tool, { title: 'Test', description: 'Do something', priority: 'normal' });

    expect(result).toContain('added');
    expect(result).toContain('priority: normal');
    expect(added).toHaveLength(1);
    expect(added[0].title).toBe('Test');
    expect(added[0].status).toBe('pending');
    expect(added[0].workerType).toBe('puppet');
  });

  it('should default to puppet workerType', async () => {
    const added: TaskDetail[] = [];
    const tool = addTaskTool({ addTask: (t) => added.push(t) });
    await exec(tool, { title: 'T', description: 'D' });
    expect(added[0].workerType).toBe('puppet');
  });

  it('should use specified workerType', async () => {
    const added: TaskDetail[] = [];
    const tool = addTaskTool({ addTask: (t) => added.push(t) });
    await exec(tool, { title: 'T', description: 'D', workerType: 'claude-code' });
    expect(added[0].workerType).toBe('claude-code');
  });

  it('should reject invalid workerType via validateWorkerType', async () => {
    const tool = addTaskTool({
      addTask: vi.fn(),
      validateWorkerType: (type) => type === 'bad' ? 'Unknown worker type: bad' : null,
    });
    const result = await exec(tool, { title: 'T', description: 'D', workerType: 'bad' });
    expect(result).toContain('Unknown worker type: bad');
  });

  it('should generate unique task IDs', async () => {
    const added: TaskDetail[] = [];
    const tool = addTaskTool({ addTask: (t) => added.push(t) });
    await exec(tool, { title: 'T1', description: 'D1' });
    await exec(tool, { title: 'T2', description: 'D2' });
    expect(added[0].id).not.toBe(added[1].id);
  });
});

// --- list_tasks ---

describe('listTasksTool', () => {
  it('should return formatted task list', async () => {
    const tasks = [
      makeTask('t1', { status: 'completed', result: 'ok' }),
      makeTask('t2', { status: 'failed', error: 'boom' }),
    ];
    const tool = listTasksTool({ listTasks: () => tasks });
    const result = await exec(tool, {});
    expect(result).toContain('[completed] t1');
    expect(result).toContain('→ ok');
    expect(result).toContain('[failed] t2');
    expect(result).toContain('✗ boom');
  });

  it('should return empty message when no tasks', async () => {
    const tool = listTasksTool({ listTasks: () => [] });
    const result = await exec(tool, {});
    expect(result).toBe('No tasks');
  });

  it('should return empty message with status filter', async () => {
    const tool = listTasksTool({ listTasks: () => [] });
    const result = await exec(tool, { status: 'pending' });
    expect(result).toBe('No pending tasks');
  });

  it('should pass status filter to listTasks', async () => {
    const listTasks = vi.fn(() => []);
    const tool = listTasksTool({ listTasks });
    await exec(tool, { status: 'running' });
    expect(listTasks).toHaveBeenCalledWith('running');
  });
});

// --- cancel_task ---

describe('cancelTaskTool', () => {
  it('should cancel a task', async () => {
    const cancelTask = vi.fn(() => true);
    const tool = cancelTaskTool({ cancelTask });
    const result = await exec(tool, { taskId: 't1' });
    expect(cancelTask).toHaveBeenCalledWith('t1');
    expect(result).toContain('cancelled');
  });

  it('should call abortWorker if provided', async () => {
    const abortWorker = vi.fn();
    const tool = cancelTaskTool({ cancelTask: () => true, abortWorker });
    await exec(tool, { taskId: 't1' });
    expect(abortWorker).toHaveBeenCalledWith('t1');
  });

  it('should return not found when cancel returns false', async () => {
    const tool = cancelTaskTool({ cancelTask: () => false });
    const result = await exec(tool, { taskId: 't1' });
    expect(result).toContain('not found');
  });
});

// --- get_task_detail ---

describe('getTaskDetailTool', () => {
  it('should return detailed task info', async () => {
    const task = makeTask('t1', {
      status: 'completed',
      result: 'done',
      startedAt: Date.now(),
      completedAt: Date.now(),
      workerSessionId: 'w-1',
    });
    const tool = getTaskDetailTool({ getTask: () => task });
    const result = await exec(tool, { taskId: 't1' });
    expect(result).toContain('ID: t1');
    expect(result).toContain('Status: completed');
    expect(result).toContain('Result: done');
    expect(result).toContain('Worker: w-1');
  });

  it('should return not found for missing task', async () => {
    const tool = getTaskDetailTool({ getTask: () => undefined });
    const result = await exec(tool, { taskId: 'missing' });
    expect(result).toContain('not found');
  });

  it('should include worker conversation if provided', async () => {
    const task = makeTask('t1', { status: 'running' });
    const tool = getTaskDetailTool({
      getTask: () => task,
      getWorkerConversation: () => [
        { type: 'user', message: { content: 'hello' } },
        { type: 'assistant', content: 'world' },
      ],
    });
    const result = await exec(tool, { taskId: 't1' });
    expect(result).toContain('Conversation (2 entries)');
  });
});

// --- update_task ---

describe('updateTaskTool', () => {
  it('should update task description', async () => {
    const updateTask = vi.fn(() => true);
    const tool = updateTaskTool({ updateTask });
    const result = await exec(tool, { taskId: 't1', description: 'new desc' });
    expect(updateTask).toHaveBeenCalledWith('t1', { description: 'new desc' });
    expect(result).toContain('updated');
  });

  it('should update task priority', async () => {
    const updateTask = vi.fn(() => true);
    const tool = updateTaskTool({ updateTask });
    await exec(tool, { taskId: 't1', priority: 'high' });
    expect(updateTask).toHaveBeenCalledWith('t1', { priority: 'high' });
  });

  it('should return nothing-to-update when no fields', async () => {
    const tool = updateTaskTool({ updateTask: vi.fn() });
    const result = await exec(tool, { taskId: 't1' });
    expect(result).toContain('Nothing to update');
  });

  it('should return not found when update returns false', async () => {
    const tool = updateTaskTool({ updateTask: () => false });
    const result = await exec(tool, { taskId: 't1', description: 'x' });
    expect(result).toContain('not found');
  });
});

// --- update_progress ---

describe('updateProgressTool', () => {
  it('should report progress with message', async () => {
    const reportProgress = vi.fn();
    const tool = updateProgressTool({ reportProgress });
    const result = await exec(tool, { message: 'Working on it' });
    expect(reportProgress).toHaveBeenCalledWith('Working on it', undefined);
    expect(result).toContain('Working on it');
  });

  it('should report progress with percent', async () => {
    const reportProgress = vi.fn();
    const tool = updateProgressTool({ reportProgress });
    const result = await exec(tool, { message: 'Half done', percent: 50 });
    expect(reportProgress).toHaveBeenCalledWith('Half done', 50);
    expect(result).toContain('50%');
  });
});

// --- query_signals ---

describe('querySignalsTool', () => {
  const makeSignal = (id: string, overrides?: Partial<ControllerSignal>): ControllerSignal => ({
    id,
    source: 'worker',
    type: 'completed',
    status: 'unread',
    payload: { taskId: 't1', workerId: 'w1', taskTitle: 'Task', workerType: 'puppet', emoji: '🧸', summary: 'ok' },
    timestamp: Date.now(),
    ...overrides,
  } as ControllerSignal);

  it('should return formatted signal list', async () => {
    const signals = [makeSignal('s1'), makeSignal('s2')];
    const tool = querySignalsTool({ querySignals: () => signals });
    const result = await exec(tool, {});
    expect(result).toContain('[unread] worker/completed s1');
    expect(result).toContain('[unread] worker/completed s2');
  });

  it('should return empty message when no signals', async () => {
    const tool = querySignalsTool({ querySignals: () => [] });
    const result = await exec(tool, {});
    expect(result).toBe('No matching signals');
  });

  it('should pass filter to querySignals', async () => {
    const querySignals = vi.fn(() => []);
    const tool = querySignalsTool({ querySignals });
    await exec(tool, { status: 'unread', source: 'worker' });
    expect(querySignals).toHaveBeenCalledWith({ status: 'unread', source: 'worker' });
  });
});

// --- done ---

describe('doneTool', () => {
  it('should call onComplete with summary', async () => {
    const onComplete = vi.fn();
    const tool = doneTool({ onComplete });
    const result = await exec(tool, { summary: 'All done!' });
    expect(onComplete).toHaveBeenCalledWith('All done!');
    expect(result).toContain('completed');
    expect(result).toContain('All done!');
  });
});

// --- fail ---

describe('failTool', () => {
  it('should call onFail with error', async () => {
    const onFail = vi.fn();
    const tool = failTool({ onFail });
    const result = await exec(tool, { error: 'Something broke' });
    expect(onFail).toHaveBeenCalledWith('Something broke');
    expect(result).toContain('failed');
    expect(result).toContain('Something broke');
  });
});

// --- skip_reply ---

describe('skipReplyTool', () => {
  it('should return skipped message', async () => {
    const tool = skipReplyTool();
    const result = await exec(tool, {});
    expect(result).toBe('(skipped)');
  });
});

// --- bash ---

describe('bashTool', () => {
  it('should execute command and return output', async () => {
    const tool = bashTool({});
    const result = await exec(tool, { command: 'echo hello' });
    expect(result.trim()).toBe('hello');
  });

  it('should return no output for empty result', async () => {
    const tool = bashTool({});
    const result = await exec(tool, { command: 'true' });
    expect(result).toBe('(no output)');
  });

  it('should handle command failure', async () => {
    const tool = bashTool({});
    const result = await exec(tool, { command: 'exit 1' });
    expect(result).toContain('Exit code 1');
  });

  it('should use cwd if provided', async () => {
    const tool = bashTool({ cwd: '/tmp' });
    const result = await exec(tool, { command: 'pwd' });
    // /tmp is symlinked to /private/tmp on macOS
    expect(result.trim()).toMatch(/\/tmp$/);
  });
});
