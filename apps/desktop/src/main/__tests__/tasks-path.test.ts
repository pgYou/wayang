import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// connection.ts imports electron at module scope; only the constant table is
// needed here, so stand in a minimal module surface.
vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  utilityProcess: { fork: () => { throw new Error('not used in this test'); } },
}));

import { SUBSCRIBED_PATHS } from '../connection';
import { SLICE } from '../../renderer/src/lib/store';

/**
 * Pin test (§4.1 工作项③): the renderer's slice literal and the main-side
 * subscription table must point at the path core's task engine actually
 * writes — `tasks.history` — never the dead `tasks.completed`. Core source
 * is checked textually because the paths are string literals on both sides.
 */
describe('tasks subscription path ↔ core write path', () => {
  const coreTaskLifecycle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../..', 'packages/core/src/services/task-execute-engine/task-lifecycle.ts'),
    'utf-8',
  );

  it('SLICE and SUBSCRIBED_PATHS both use tasks.history', () => {
    expect(SLICE.tasksHistory).toBe('engine:tasks.history');
    expect(SUBSCRIBED_PATHS).toContainEqual(['engine', 'tasks.history']);
    expect(SUBSCRIBED_PATHS).not.toContainEqual(['engine', 'tasks.completed']);
  });

  it('core writes the subscribed task paths (and never tasks.completed)', () => {
    for (const [target, path] of SUBSCRIBED_PATHS) {
      if (target !== 'engine' || !path.startsWith('tasks.')) continue;
      expect(coreTaskLifecycle).toContain(`'${path}'`);
    }
    expect(coreTaskLifecycle).not.toContain("'tasks.completed'");
  });

  it('the slice key set matches the subscription table one-to-one', () => {
    const subscribed = new Set(SUBSCRIBED_PATHS.map(([target, path]) => `${target}:${path}`));
    expect(subscribed.has(SLICE.tasksHistory)).toBe(true);
    for (const key of Object.values(SLICE)) {
      expect(subscribed.has(key)).toBe(true);
    }
  });
});
