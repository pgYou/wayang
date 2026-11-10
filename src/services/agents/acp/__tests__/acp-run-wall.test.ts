/**
 * Worker run wall-time limit (#76) — priority resolution, watchdog and the
 * structured timeout report. Commit 1 covers the pure resolution; the
 * watchdog/report tests live here too (same module).
 */

import { describe, expect, it } from 'vitest';
import type { TaskDetail } from '@/types/task';
import type { WayangConfig } from '@/types/config';
import { TURN_LIMITS } from '@/services/agents/acp/turn-attribution';
import { resolveRunWallLimitMs } from '@/services/agents/acp/acp-run-wall';

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { id: 't', title: 'T', description: 'D', priority: 'normal', status: 'pending', createdAt: 0, ...overrides };
}

function makeConfig(overrides: Partial<WayangConfig> = {}): WayangConfig {
  return { providers: {}, controller: { provider: 'p' }, worker: { provider: 'p', maxConcurrency: 1 }, ...overrides } as WayangConfig;
}

describe('resolveRunWallLimitMs (#76 priority chain)', () => {
  it('defaults to the 60-minute budget when neither task nor config declares one', () => {
    expect(resolveRunWallLimitMs(makeTask(), makeConfig())).toBe(TURN_LIMITS.MAX_RUN_WALL_MS);
    expect(TURN_LIMITS.MAX_RUN_WALL_MS).toBe(3_600_000);
  });

  it('global workerRunTimeoutMs overrides the default', () => {
    expect(resolveRunWallLimitMs(makeTask(), makeConfig({ workerRunTimeoutMs: 1_800_000 }))).toBe(1_800_000);
  });

  it('the task runTimeoutMs overrides the global config', () => {
    expect(
      resolveRunWallLimitMs(makeTask({ runTimeoutMs: 600_000 }), makeConfig({ workerRunTimeoutMs: 1_800_000 })),
    ).toBe(600_000);
  });

  it('the task runTimeoutMs also wins when only it is set', () => {
    expect(resolveRunWallLimitMs(makeTask({ runTimeoutMs: 600_000 }), makeConfig())).toBe(600_000);
  });
});
