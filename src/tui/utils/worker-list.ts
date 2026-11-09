/**
 * Row formatting for the `/workers` list.
 *
 * The old rows were `workerId [status] → task <id>` — the worker's type, what
 * it is working on and for how long were invisible, which is exactly the
 * "panel does not say what is happening" complaint of issue #49. Rows now show
 * the worker handle, type, parent task (handle + title) and elapsed time; a
 * parked multi-stage worker shows its idle duration and last stage summary
 * instead, so it can never be misread as a task still burning time.
 *
 * What this view cannot show: the worker's current tool, its last transcript
 * activity and a "suspected stuck" verdict. Those live server-side (derived
 * from the worker's transcript by the engine) and are not part of the
 * `ActiveWorkerInfo` snapshot the TUI receives — surfacing them needs an
 * upstream state/RPC change, deliberately out of scope here.
 *
 * Pure formatting only — reads fields the snapshot already carries.
 */

import type { ActiveWorkerInfo } from '@/types/index';
import { formatDuration } from '@/services/worker-transcript';
import { collapseWhitespace, shortId, stringWidth, truncateToWidth } from '@/tui/utils/text-width';

/** Max display columns for the task-title fragment on a row. */
export const WORKER_LIST_TITLE_MAX_WIDTH = 40;

/** Max display columns for an idle worker's last-stage summary. */
export const WORKER_LIST_STAGE_MAX_WIDTH = 40;

export interface WorkerRowOptions {
  /** Epoch ms used as "now" for elapsed times; defaults to Date.now(). */
  now?: number;
  /**
   * Total display-column budget for one row (the overlay panel's inner
   * width). Rows are hard-capped to it so one worker is always one line.
   */
  rowMaxWidth?: number;
}

/**
 * One `/workers` row: `#tail [status] <emoji> <type> · task #tail <title> ·
 * 已运行 <d>` — or, for a parked multi-stage worker, `空闲 <d> · 上阶段: …`.
 */
export function formatWorkerRow(
  worker: ActiveWorkerInfo,
  options: WorkerRowOptions = {},
): string {
  const now = options.now ?? Date.now();
  const type = `${worker.emoji} ${worker.workerType}`.trim();
  const title = truncateToWidth(collapseWhitespace(worker.taskTitle), WORKER_LIST_TITLE_MAX_WIDTH);
  const taskPart = `task #${shortId(worker.taskId ?? '-')}${title ? ` ${title}` : ''}`;

  const idle = worker.status === 'idle';
  let duration: string;
  let stage = '';
  if (idle) {
    duration = `空闲 ${formatDuration(Math.max(0, now - (worker.idleSinceMs ?? worker.startedAt)))}`;
    if (collapseWhitespace(worker.lastStageSummary ?? '')) {
      const digest = truncateToWidth(
        collapseWhitespace(worker.lastStageSummary ?? ''),
        WORKER_LIST_STAGE_MAX_WIDTH,
      );
      stage = ` · 上阶段: ${digest}`;
    }
  } else {
    duration = `已运行 ${formatDuration(Math.max(0, now - worker.startedAt))}`;
  }

  const row = `#${shortId(worker.workerId)} [${worker.status}] ${type} · ${taskPart} · ${duration}${stage}`;
  if (options.rowMaxWidth !== undefined && stringWidth(row) > options.rowMaxWidth) {
    return truncateToWidth(row, options.rowMaxWidth);
  }
  return row;
}

/** Render the whole `/workers` output; an empty list renders `No active workers`. */
export function formatWorkerList(
  workers: readonly ActiveWorkerInfo[],
  options: WorkerRowOptions = {},
): string {
  if (workers.length === 0) return 'No active workers';
  return workers.map(worker => formatWorkerRow(worker, options)).join('\n');
}
