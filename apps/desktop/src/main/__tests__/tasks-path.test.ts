import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATE_SLICE_PATHS } from '../../shared/ipc-contract';
import { SLICE } from '../../renderer/shared/lib/store';

/**
 * Pin test (§4.1 工作项③, kept through 域二): the renderer's slice literal and
 * the contract's subscription table must point at the path core's task
 * engine actually writes — `tasks.history` — never the dead
 * `tasks.completed`. Core source is checked textually because the paths are
 * string literals on both sides.
 */
describe('tasks subscription path ↔ core write path', () => {
  const coreTaskLifecycle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../..', 'packages/core/src/services/task-execute-engine/task-lifecycle.ts'),
    'utf-8',
  );

  it('SLICE and the subscription table both use tasks.history', () => {
    expect(SLICE.tasksHistory).toBe('engine:tasks.history');
    expect(STATE_SLICE_PATHS).toContainEqual(['engine', 'tasks.history']);
    expect(STATE_SLICE_PATHS).not.toContainEqual(['engine', 'tasks.completed']);
  });

  it('core writes the subscribed task paths (and never tasks.completed)', () => {
    for (const [target, path] of STATE_SLICE_PATHS) {
      if (target !== 'engine' || !path.startsWith('tasks.')) continue;
      expect(coreTaskLifecycle).toContain(`'${path}'`);
    }
    expect(coreTaskLifecycle).not.toContain("'tasks.completed'");
  });

  it('the slice key set matches the subscription table one-to-one', () => {
    const subscribed = new Set(STATE_SLICE_PATHS.map(([target, path]) => `${target}:${path}`));
    expect(subscribed.has(SLICE.tasksHistory)).toBe(true);
    for (const key of Object.values(SLICE)) {
      expect(subscribed.has(key)).toBe(true);
    }
  });
});
