import { z } from 'zod';
import type { ActiveWorkerInfo, TaskDetail, WorkerLiveStatus } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { defineTool, safeExecute } from './common';
import {
  MAX_TRANSCRIPT_RESULT_CHARS,
  formatDuration,
  formatLastActivity,
  isValidWorkerId,
  summarizeTranscript,
} from '@/services/worker-transcript';

/**
 * Status of one worker as the controller sees it.
 *
 * Inference basis for the fields the worker objects do not expose directly
 * (documented, because a wrong signal is worse than no signal):
 *  - `lastActivityAt` / `currentTool`: newest entry of the worker transcript
 *    (in-memory conversation for a live worker, on-disk jsonl otherwise).
 *  - `resultReceived` / `streamEnded`: live worker flag when the worker type
 *    implements `getLiveStatus()` (claude-code: `_terminalResult` /
 *    stream-loop exit). Otherwise inferred from the transcript: a trailing
 *    `system` entry with subtype `task_result` / `error` is written only after
 *    the run finishes, so it proves both. A settled task status
 *    (completed/failed/cancelled) is treated the same way. `null` = the
 *    worker type records nothing that answers it (e.g. a live puppet worker).
 *  - `runningForMs`: now - startedAt for a live worker; for a finished worker
 *    the recorded run duration (completedAt - startedAt) when available.
 */
export interface WorkerStatusSnapshot {
  workerId: string;
  /** Worker type label (e.g. 'puppet', 'claude-code'); 'unknown' if untraceable. */
  type: string;
  taskId: string | null;
  status: 'running' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  /** How long the worker has been running / ran (ms); null when unknown. */
  runningForMs: number | null;
  /** Epoch ms of the newest transcript entry; null when there is none. */
  lastActivityAt: number | null;
  /** Milliseconds since the newest transcript entry; null when there is none. */
  lastActivityAgoMs: number | null;
  /** Name of the most recent tool call, or null. */
  currentTool: string | null;
  streamEnded: boolean | null;
  resultReceived: boolean | null;
  /** Epoch ms when an idle (multi-stage) worker parked; null when not idle. */
  idleSince: number | null;
  /** The worker is still tracked by the engine (live in-memory instance). */
  live: boolean;
  /** Type of the newest transcript entry, for a quick sanity check. */
  lastEntryType: string | null;
  /** Number of transcript entries seen. */
  entries: number;
}

export interface GetWorkerStatusDeps {
  /** Currently tracked workers (engine.getActiveWorkers()). */
  listWorkers: () => ActiveWorkerInfo[];
  /** All known tasks — resolves type/taskId/status for finished workers. */
  listTasks: () => TaskDetail[];
  /** Read the worker's on-disk transcript; null when the file does not exist. */
  readTranscript: (workerId: string) => ConversationEntry[] | null;
  /** Live run flags from the in-memory worker instance, when available. */
  getLiveStatus?: (workerId: string) => WorkerLiveStatus | undefined;
  /** Injectable clock (tests). */
  now?: () => number;
}

const SETTLED_TASK_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

function taskStatusToWorkerStatus(status: TaskDetail['status']): WorkerStatusSnapshot['status'] {
  if (status === 'running') return 'running';
  if (SETTLED_TASK_STATUSES.has(status)) return status as WorkerStatusSnapshot['status'];
  return 'unknown';
}

/** Build one snapshot, or null when nothing (active worker, task, transcript) proves the id exists. */
function buildSnapshot(
  workerId: string,
  deps: GetWorkerStatusDeps,
  now: number,
): WorkerStatusSnapshot | null {
  const active = deps.listWorkers().find((w) => w.workerId === workerId);
  const tasks = deps.listTasks();
  const task = active
    ? tasks.find((t) => t.id === active.taskId)
    : tasks.find((t) => t.workerSessionId === workerId);
  const entries = deps.readTranscript(workerId);

  if (!active && !task && entries === null) return null;

  const summary = summarizeTranscript(entries ?? []);
  const live = deps.getLiveStatus?.(workerId);
  const workerType = active?.workerType ?? task?.workerType ?? 'unknown';
  const settled = task ? SETTLED_TASK_STATUSES.has(task.status) : false;
  // Puppet workers write no terminal marker and expose no SDK result flag, so
  // the transcript cannot prove either fact while they are still running.
  const terminalTracked = workerType !== 'puppet';
  const inferredTerminal = summary.hasTerminalEntry || settled;

  let runningForMs: number | null = null;
  if (active) {
    runningForMs = Math.max(0, now - active.startedAt);
  } else if (task?.startedAt) {
    runningForMs = Math.max(0, (task.completedAt ?? now) - task.startedAt);
  }

  return {
    workerId,
    type: workerType,
    taskId: active?.taskId ?? task?.id ?? null,
    status: active?.status ?? (task ? taskStatusToWorkerStatus(task.status) : 'unknown'),
    runningForMs,
    lastActivityAt: summary.lastActivityAt,
    lastActivityAgoMs: summary.lastActivityAt === null ? null : Math.max(0, now - summary.lastActivityAt),
    currentTool: summary.currentTool,
    streamEnded: live?.streamEnded ?? (inferredTerminal ? true : terminalTracked ? false : null),
    resultReceived: live?.resultReceived ?? (inferredTerminal ? true : terminalTracked ? false : null),
    idleSince: active?.status === 'idle' ? (active.idleSinceMs ?? null) : null,
    live: active !== undefined,
    lastEntryType: summary.lastEntryType,
    entries: summary.totalEntries,
  };
}

function boolLabel(v: boolean | null): string {
  return v === null ? 'unknown' : String(v);
}

/** Multi-line, human-readable rendering of one snapshot. */
function formatSnapshot(s: WorkerStatusSnapshot, now: number): string[] {
  return [
    `Worker ${s.workerId} (${s.type})`,
    `  task: ${s.taskId ?? '-'}`,
    `  status: ${s.status}${s.live ? ' (tracked)' : ' (no longer tracked)'}`,
    `  runningForMs: ${s.runningForMs === null ? 'unknown' : `${s.runningForMs} (${formatDuration(s.runningForMs)})`}`,
    `  lastActivityAt: ${formatLastActivity(s.lastActivityAt, now)}`,
    `  currentTool: ${s.currentTool ?? '-'}`,
    `  streamEnded: ${boolLabel(s.streamEnded)}`,
    `  resultReceived: ${boolLabel(s.resultReceived)}`,
    `  idleSince: ${s.idleSince === null ? '-' : formatLastActivity(s.idleSince, now)}`,
    `  entries: ${s.entries} (last: ${s.lastEntryType ?? '-'})`,
  ];
}

/** One-line rendering for the "all workers" listing. */
function formatSnapshotLine(s: WorkerStatusSnapshot): string {
  const activity = s.lastActivityAgoMs === null ? 'none' : `${formatDuration(s.lastActivityAgoMs)} ago`;
  return `  [${s.status}] ${s.workerId} (${s.type}) task=${s.taskId ?? '-'} ` +
    `runningFor=${s.runningForMs === null ? 'unknown' : formatDuration(s.runningForMs)} ` +
    `lastActivity=${activity} tool=${s.currentTool ?? '-'} ` +
    `streamEnded=${boolLabel(s.streamEnded)} resultReceived=${boolLabel(s.resultReceived)}`;
}

export function getWorkerStatusTool(deps: GetWorkerStatusDeps) {
  return defineTool({
    description:
      'Get the liveness of one worker (workerId given) or of all current workers (omitted). ' +
      'Reports status, runningForMs, lastActivityAt (epoch ms of the newest transcript entry; ' +
      'lastActivityAgoMs is how long ago that was), currentTool, streamEnded, resultReceived and idleSince ' +
      '— use it to tell "still working" from "stuck / already finished and just not released" ' +
      'before deciding to wait, chat, or cancel. ' +
      'Unknown worker ids return a not-found message instead of throwing. ' +
      'A machine-readable [worker-status] line carries the same data as JSON.',
    parameters: z.object({
      workerId: z.string().optional().describe('Worker ID; omit to list all current workers'),
    }),
    execute: safeExecute('get_worker_status', async ({ workerId }) => {
      const now = deps.now?.() ?? Date.now();

      if (workerId !== undefined && !isValidWorkerId(workerId)) {
        return `Invalid worker id "${workerId}" — worker ids are alphanumeric with dashes/underscores only.`;
      }

      if (workerId === undefined) {
        const workers = deps.listWorkers();
        if (workers.length === 0) {
          return 'No workers are running or idle.\n[worker-status] []';
        }
        const snapshots = workers
          .map((w) => buildSnapshot(w.workerId, deps, now))
          .filter((s): s is WorkerStatusSnapshot => s !== null);
        const lines = [`Workers (${snapshots.length}):`, ...snapshots.map(formatSnapshotLine)];
        lines.push(`[worker-status] ${JSON.stringify(snapshots)}`);
        return lines.join('\n');
      }

      const snapshot = buildSnapshot(workerId, deps, now);
      if (!snapshot) {
        return `Worker ${workerId} not found (not tracked, no task references it, no transcript on disk).`;
      }
      return [...formatSnapshot(snapshot, now), `[worker-status] ${JSON.stringify(snapshot)}`].join('\n');
    }, { maxResultChars: MAX_TRANSCRIPT_RESULT_CHARS }),
  });
}
