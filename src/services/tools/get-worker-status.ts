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
 *  - `lastActivityAt` / `currentTool` / `entries` / `lastEntryType` come from
 *    the same layered source `read_worker_conversation` uses: the live
 *    in-memory conversation while the engine tracks the worker
 *    (`activitySource: 'memory'`), otherwise the on-disk jsonl resolved
 *    through the worker instance's OWN id (the `workers/<agent-…|cw-…>/`
 *    directory name — via the task's `workerTranscriptId` or the engine's
 *    `getWorkerTranscriptId`), the raw id only as a last resort
 *    (`activitySource: 'disk'`). `activitySource: 'none'` means the worker
 *    has no transcript entries at all — which is what `null` activity fields
 *    then mean. That is deliberately distinct from `streamEnded` /
 *    `resultReceived` being `null`, which means the worker TYPE records
 *    nothing that answers the question.
 *  - `resultReceived` / `streamEnded`: live worker flag when the worker type
 *    implements `getLiveStatus()` (claude-code: `_terminalResult` /
 *    stream-loop exit). Otherwise inferred from the transcript: a trailing
 *    `system` entry with subtype `task_result` / `error` is written only after
 *    the run finishes, so it proves both. A settled task status
 *    (completed/failed/cancelled) is treated the same way.
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
  /**
   * Where the activity fields came from. 'memory' = live in-memory
   * conversation of a tracked worker; 'disk' = on-disk transcript (worker no
   * longer tracked, or it has written nothing yet); 'none' = no transcript
   * exists — the nulls below then mean "no entries", not "type unknown".
   */
  activitySource: 'memory' | 'disk' | 'none';
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
  /**
   * Read a worker's on-disk transcript by TRANSCRIPT DIRECTORY id; null when
   * the file does not exist. The engine worker id (w-…) is NOT a directory
   * name — resolve via `getWorkerTranscriptId` / `task.workerTranscriptId`.
   */
  readTranscript: (workerId: string) => ConversationEntry[] | null;
  /**
   * Live in-memory conversation of an engine-tracked worker, by ENGINE worker
   * id. Undefined once the worker is no longer tracked. Same source (and
   * freshness) as read_worker_conversation's "memory" layer.
   */
  getWorkerConversationByWorkerId?: (workerId: string) => ConversationEntry[] | undefined;
  /**
   * The worker instance's own id (agent-…/cw-…) — the on-disk transcript
   * directory name — while the engine still tracks the worker.
   */
  getWorkerTranscriptId?: (workerId: string) => string | undefined;
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

/** Resolved activity data plus where it came from. */
interface ActivityData {
  entries: ConversationEntry[];
  source: 'memory' | 'disk' | 'none';
}

/**
 * Resolve the entries behind the activity fields — the SAME layered source
 * read_worker_conversation reads, so the two tools can never disagree:
 *  1. the live in-memory conversation while the engine tracks the worker
 *     (freshest: the worker state appends to memory and disk together);
 *  2. the on-disk jsonl under the worker instance's OWN id — via the task's
 *     persisted `workerTranscriptId`, the live instance id, then the raw id
 *     (a controller may genuinely know a cw-…/agent-… id).
 *
 * The engine worker id (w-…) is never a transcript directory name (see
 * TaskDetail.workerSessionId), so skipping step 2's id resolution is exactly
 * how this tool used to report null activity for busy workers.
 */
function resolveActivity(
  workerId: string,
  deps: GetWorkerStatusDeps,
  active: ActiveWorkerInfo | undefined,
  task: TaskDetail | undefined,
): ActivityData {
  // Layer 1: live in-memory conversation (engine still tracks the worker).
  // Non-empty check mirrors read_worker_conversation: a tracked worker that
  // has written nothing yet falls through to disk (which will also be empty).
  const memory = deps.getWorkerConversationByWorkerId?.(workerId);
  if (memory !== undefined && memory.length > 0) {
    return { entries: memory, source: 'memory' };
  }

  // Layer 2: on-disk transcript, resolved through the directory-name ids.
  const candidates = [task?.workerTranscriptId, active !== undefined ? deps.getWorkerTranscriptId?.(workerId) : undefined, workerId];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const entries = deps.readTranscript(id);
    if (entries !== null) return { entries, source: 'disk' };
  }

  return { entries: [], source: 'none' };
}

/** Build one snapshot, or null when nothing (active worker, task, transcript) proves the id exists. */
function buildSnapshot(
  workerId: string,
  deps: GetWorkerStatusDeps,
  now: number,
): WorkerStatusSnapshot | null {
  const active = deps.listWorkers().find((w) => w.workerId === workerId);
  const tasks = deps.listTasks();
  // Match by engine worker id (workerSessionId) or the instance's own id
  // (workerTranscriptId) — the controller may legitimately pass either.
  const task = active
    ? tasks.find((t) => t.id === active.taskId)
    : tasks.find((t) => t.workerSessionId === workerId || t.workerTranscriptId === workerId);

  const activity = resolveActivity(workerId, deps, active, task);
  const entries = activity.entries;
  // An unknown id is one where no active worker, task, or on-disk transcript
  // proves it exists. A tracked worker with no entries yet IS known (it is
  // 'running' with nothing written) — it must return a snapshot, not
  // not-found.
  if (!active && !task && activity.source === 'none') return null;

  const summary = summarizeTranscript(entries);
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
    activitySource: activity.source,
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
    `  activity: source=${s.activitySource} ${formatLastActivity(s.lastActivityAt, now)}`,
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
    `lastActivity=${activity} (src=${s.activitySource}) tool=${s.currentTool ?? '-'} ` +
    `streamEnded=${boolLabel(s.streamEnded)} resultReceived=${boolLabel(s.resultReceived)}`;
}

export function getWorkerStatusTool(deps: GetWorkerStatusDeps) {
  return defineTool({
    description:
      'Get the liveness of one worker (workerId given) or of all current workers (omitted). ' +
      'Reports status, runningForMs, lastActivityAt (epoch ms of the newest transcript entry; ' +
      'lastActivityAgoMs is how long ago that was), currentTool, streamEnded, resultReceived and idleSince ' +
      '— use it to tell "still working" from "stuck / already finished and just not released" ' +
      'before deciding to wait, chat, or cancel. Activity fields come from the same layered source ' +
      'read_worker_conversation reads (live memory first, on-disk jsonl otherwise) and report ' +
      'activitySource memory/disk/none; null activity + source=none means "no entries yet", while ' +
      'streamEnded/resultReceived null means the worker type does not track that fact. ' +
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
