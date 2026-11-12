/**
 * add_task's `runTimeoutMs` is deprecated (v0.9.7 removed run-duration
 * limits). Old controller prompts still carry the param: it must never fail
 * the call — it is ignored, with ONE deprecation warn per process.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TaskDetail } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import { createMockLogger } from '@/__tests__/helpers';

describe('add_task runTimeoutMs (deprecated, v0.9.7)', () => {
  it('accepts the param without error, warns exactly once, and creates no task field', async () => {
    const added: TaskDetail[] = [];
    const logger = createMockLogger();
    const tool = addTaskTool({
      addTask: (t) => { added.push(t); return 'w-rt'; },
      workspaceDir: '/tmp/wayang-run-timeout-ws',
      logger,
    });

    const first = await tool.execute({ title: 'a', description: 'd', runTimeoutMs: 60_000 });
    expect(first).toContain('Task ');
    expect(added).toHaveLength(1);
    expect((added[0] as unknown as Record<string, unknown>).runTimeoutMs).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.warn).mock.calls[0][1])).toContain('deprecated');

    // Second call: still succeeds, but the warn fires only once per process.
    await tool.execute({ title: 'b', description: 'd', runTimeoutMs: 60_000 });
    expect(added).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
