/**
 * add_task runTimeoutMs declaration (#76) — a task may tighten or widen its
 * own worker-run wall-time budget. Same numeric rules as the global
 * `workerRunTimeoutMs`: positive integer of milliseconds, 6h cap; an invalid
 * value fails the whole call so no task is created with a bogus budget.
 */

import { describe, expect, it } from 'vitest';
import type { TaskDetail } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import { MAX_RUN_TIMEOUT_MS } from '@/types/config';

function makeTool(added: TaskDetail[]) {
  return addTaskTool({
    addTask: (t) => { added.push(t); return 'w-1'; },
    workspaceDir: '/tmp/wayang-run-timeout-ws',
  });
}

describe('addTaskTool — runTimeoutMs declaration (#76)', () => {
  it('stores a valid runTimeoutMs on the created task', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await tool.execute({
      title: 'T', description: 'D', runTimeoutMs: 1_800_000,
    } as any);

    expect(result).toContain('added');
    expect(added).toHaveLength(1);
    expect(added[0].runTimeoutMs).toBe(1_800_000);
  });

  it('omits the field when the call declares none', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    await tool.execute({ title: 'T', description: 'D' } as any);

    expect(added).toHaveLength(1);
    expect(added[0].runTimeoutMs).toBeUndefined();
  });

  it.each([0, -5, 1.5, Number.NaN, MAX_RUN_TIMEOUT_MS + 1])('rejects %s with a clear error and creates no task', async (bad) => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await tool.execute({
      title: 'T', description: 'D', runTimeoutMs: bad,
    } as any);

    expect(result).toContain(`Invalid runTimeoutMs ${JSON.stringify(bad)}`);
    expect(result).toContain(`at most ${MAX_RUN_TIMEOUT_MS} (6 hours)`);
    expect(result).toContain('NOT created');
    expect(added).toHaveLength(0);
  });

  it('accepts the 6h cap boundary itself', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await tool.execute({
      title: 'T', description: 'D', runTimeoutMs: MAX_RUN_TIMEOUT_MS,
    } as any);

    expect(result).toContain('added');
    expect(added[0].runTimeoutMs).toBe(MAX_RUN_TIMEOUT_MS);
  });
});
