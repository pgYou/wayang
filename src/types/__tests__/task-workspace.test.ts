/**
 * TaskDetail.workspace persistence — exercises the real production read/write
 * path (TaskPoolState + JSONFileHelper) instead of hand-rolled JSON round-trips.
 * A task is written through `state.set`, then reloaded by a fresh state via
 * `restore()`, which is exactly how the engine persists and recovers tasks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskPoolState } from '@/services/task/task-pool-state';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import type { TaskDetail } from '@/types/task';

let sessionDir: string;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-task-ws-'));
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

/** Write tasks through production state, then read them back via restore(). */
async function writeThenRestore(bucket: 'pending' | 'running' | 'history', tasks: TaskDetail[]): Promise<TaskDetail[]> {
  const writer = new TaskPoolState(createMockCtx({ sessionDir }));
  writer.set(`tasks.${bucket}`, tasks);

  const reader = new TaskPoolState(createMockCtx({ sessionDir }));
  await reader.restore();
  return reader.get<TaskDetail[]>(`tasks.${bucket}`);
}

describe('TaskDetail workspace persistence (TaskPoolState)', () => {
  it('persists and reloads a task carrying a workspace', async () => {
    const task = makeTask('t-1', { workspace: { path: '/repo/my-project', slug: 'my-project' } });

    const restored = await writeThenRestore('pending', [task]);

    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(task);
    expect(restored[0].workspace).toEqual({ path: '/repo/my-project', slug: 'my-project' });
  });

  it('leaves the workspace field absent for a task that never had one', async () => {
    const task = makeTask('t-2');

    const restored = await writeThenRestore('running', [task]);

    expect('workspace' in restored[0]).toBe(false);
    expect(restored[0].workspace).toBeUndefined();
    expect(restored[0]).toEqual(task);
  });

  it('keeps other optional fields intact alongside a workspace', async () => {
    const task = makeTask('t-3', {
      status: 'completed',
      startedAt: 2000,
      completedAt: 3000,
      result: 'done',
      workerType: 'claude-code',
      workerTranscriptId: 'cw-1',
      workspace: { path: '/repo/a', slug: 'a' },
    });

    const restored = await writeThenRestore('history', [task]);

    expect(restored[0]).toEqual(task);
    expect(restored[0].workspace?.slug).toBe('a');
    expect(restored[0].workerTranscriptId).toBe('cw-1');
  });

  it('reads a legacy tasks.json written before workspaces existed', async () => {
    // Seed the on-disk shape an older Wayang version produced (no workspace
    // key), then read it through the production restore path.
    // tasks.json holds the `tasks` object itself (JSONFileHelper replaces it
    // wholesale), so the legacy document is the three buckets, unwrapped.
    const legacy = {
      pending: [],
      running: [],
      history: [
        {
          id: 't-old',
          title: 'Old',
          description: 'legacy task',
          priority: 'high',
          status: 'completed',
          createdAt: 1,
          result: 'ok',
        },
      ],
    };
    fs.writeFileSync(path.join(sessionDir, 'tasks.json'), JSON.stringify(legacy, null, 2));

    const reader = new TaskPoolState(createMockCtx({ sessionDir }));
    await reader.restore();
    const restored = reader.get<TaskDetail[]>('tasks.history');

    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('t-old');
    expect(restored[0].workspace).toBeUndefined();
  });
});
