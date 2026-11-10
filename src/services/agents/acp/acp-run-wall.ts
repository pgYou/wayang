/**
 * Worker run wall-time limit (#76) — pure resolution, watchdog and the
 * structured timeout report. Kept out of acp-worker-run.ts so the run spine
 * stays lean: the run layer only arms/clears the watchdog and swaps the bare
 * 'run wall time exceeded' wording for the report built here.
 */

import type { TaskDetail } from '@/types/task';
import type { WayangConfig } from '@/types/config';
import { TURN_LIMITS } from './turn-attribution';

/**
 * Effective wall-time limit (ms) of one worker run (#76).
 * Priority: task `runTimeoutMs` > config `workerRunTimeoutMs` >
 * `TURN_LIMITS.MAX_RUN_WALL_MS` (default 60 min). Both override sources are
 * validated upstream (add_task / validateConfig); this resolver only picks.
 */
export function resolveRunWallLimitMs(task: TaskDetail, config: WayangConfig): number {
  return task.runTimeoutMs ?? config.workerRunTimeoutMs ?? TURN_LIMITS.MAX_RUN_WALL_MS;
}
