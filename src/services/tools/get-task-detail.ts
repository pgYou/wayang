import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { defineTool, safeExecute } from './common';
import {
  MAX_TRANSCRIPT_RESULT_CHARS,
  buildTranscriptHeader,
  buildTruncationNotice,
  buildWindowMeta,
  renderEntriesFitting,
  selectWindow,
  shrinkWindow,
  type TranscriptReadOptions,
  type WorkerTranscriptWindow,
} from '@/services/worker-transcript';

/** Output chars reserved for headers, notices and the meta line. */
const OUTPUT_OVERHEAD_CHARS = 1_500;

/** Default number of entries returned (counting back from the newest). */
const DEFAULT_LIMIT = 10;
/** Default per-entry character cap. */
const DEFAULT_MAX_CHARS = 200;

export interface GetTaskDetailDeps {
  /** Get a single task by id. */
  getTask: (taskId: string) => TaskDetail | undefined;
  /** Get worker conversation entries for a running/completed task (in-memory). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors TaskExecuteEngine.getWorkerConversation's defensive any[] (mixed-vintage entries read defensively below)
  getWorkerConversation?: (taskId: string) => any[];
  /**
   * Windowed read of a worker's on-disk transcript (by the worker's own
   * directory id). Used as a fallback when the in-memory conversation is gone
   * (worker finished / cancelled), so the controller can still see the scene
   * it was blind to before issue #16. Null when the file does not exist.
   */
  readTranscriptWindow?: (workerId: string, opts: TranscriptReadOptions) => WorkerTranscriptWindow | null;
}

export function getTaskDetailTool(deps: GetTaskDetailDeps) {
  return defineTool({
    description:
      'Get detailed information about a specific task, including its worker conversation. ' +
      'The conversation comes from the worker\'s live in-memory state while it runs, and from ' +
      'its on-disk transcript after the worker ended (marked [from transcript]). ' +
      'The conversation is paginated and truncation is always marked explicitly: ' +
      'offset skips N entries counted back from the newest; output is ordered oldest→newest; ' +
      'type filtering is applied BEFORE pagination. ' +
      'limit (default 10 entries, counted back from the newest), maxChars (per-entry character ' +
      'cap, default 200) and full=true (complete text, all entries). ' +
      'A machine-readable meta line reports totalEntries / returnedEntries / offset / truncated.',
    parameters: z.object({
      taskId: z.string().describe('Task ID'),
      limit: z.number().int().min(1).optional().describe(`Max entries to return (default ${DEFAULT_LIMIT})`),
      offset: z.number().int().min(0).optional().describe('Skip the newest N entries (default 0)'),
      maxChars: z.number().int().min(1).optional().describe(`Per-entry character cap (default ${DEFAULT_MAX_CHARS})`),
      full: z.boolean().optional().describe('Return complete entry text and all entries (ignores limit/maxChars)'),
    }),
    // Full reports can be far longer than the default tool-output cap.
    execute: safeExecute('get_task_detail', async ({ taskId, limit, offset, maxChars, full }) => {
      const task = deps.getTask(taskId);
      if (!task) return `Task ${taskId} not found`;

      const lines = [
        `ID: ${task.id}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority}`,
        `Description: ${task.description}`,
        `Created: ${new Date(task.createdAt).toISOString()}`,
      ];
      if (task.startedAt) lines.push(`Started: ${new Date(task.startedAt).toISOString()}`);
      if (task.completedAt) lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`);
      if (task.result) lines.push(`Result: ${task.result}`);
      if (task.error) lines.push(`Error: ${task.error}`);
      if (task.workerSessionId) lines.push(`Worker: ${task.workerSessionId}`);
      // Workspace identity (path + slug); legacy tasks simply have none.
      if (task.workspace) lines.push(`Workspace: ${task.workspace.path} (slug: ${task.workspace.slug})`);
      // Extra directories granted to this task only (absent unless declared).
      if (task.taskAllowedDirs && task.taskAllowedDirs.length > 0) {
        lines.push(`Allowed dirs: ${task.taskAllowedDirs.join(', ')}`);
      }

      const isFull = full === true;
      const requestedLimit = limit ?? DEFAULT_LIMIT;

      // In-memory conversation first (a live worker), then the on-disk
      // transcript (a worker that already ended and left the engine's map).
      // The disk transcript lives under the worker instance's OWN id —
      // task.workerTranscriptId — never the engine id in workerSessionId.
      let entries: ConversationEntry[] = [];
      let source: 'memory' | 'transcript' | 'none' = 'none';
      let incompleteTail = false;
      let readWindowTruncated = false;
      if (deps.getWorkerConversation) {
        entries = deps.getWorkerConversation(taskId) as ConversationEntry[];
        if (entries.length > 0) source = 'memory';
      }
      if (entries.length === 0 && deps.readTranscriptWindow) {
        const diskIds = [task.workerTranscriptId, task.workerSessionId]
          .filter((id): id is string => typeof id === 'string');
        for (const id of [...new Set(diskIds)]) {
          const win = deps.readTranscriptWindow(id, {
            need: isFull ? undefined : (offset ?? 0) + requestedLimit,
          });
          if (win && win.entries.length > 0) {
            entries = win.entries;
            source = 'transcript';
            incompleteTail = win.incompleteTail;
            readWindowTruncated = win.windowTruncated;
            break;
          }
        }
      }

      if (entries.length === 0) return lines.join('\n');

      const perEntryCap = isFull ? null : (maxChars ?? DEFAULT_MAX_CHARS);
      const requested = selectWindow(entries, offset ?? 0, isFull ? entries.length : requestedLimit);
      // Render newest-first under the tool-output budget: if the requested
      // window cannot fit, the oldest entries are dropped and reported, so the
      // meta can never claim more than the caller actually sees.
      const rendered = renderEntriesFitting(
        requested.entries,
        requested.startIndex,
        { maxChars: perEntryCap, includeToolDetail: isFull },
        MAX_TRANSCRIPT_RESULT_CHARS - OUTPUT_OVERHEAD_CHARS,
      );
      const win = shrinkWindow(requested, rendered.dropped);
      const body = rendered.lines;

      const base = buildWindowMeta(win, { maxChars: perEntryCap, full: isFull, shortenedEntries: rendered.shortened });
      const meta = {
        ...base,
        source,
        incompleteTail,
        readWindowTruncated,
        windowTruncated: base.windowTruncated || readWindowTruncated,
        truncated: base.truncated || readWindowTruncated,
      };
      lines.push('');
      let header = buildTranscriptHeader(meta);
      if (readWindowTruncated) {
        header = `Conversation (${meta.totalEntries} entries in read window, showing ` +
          `${meta.startIndex}-${meta.endIndex}; older entries exist beyond the read-window cap)`;
      }
      lines.push(`${header}${source === 'transcript' ? ' [from transcript]' : ''}`);
      lines.push(...body);
      if (incompleteTail) {
        lines.push('[note: last entry is incomplete — the transcript is still being written]');
      }
      if (readWindowTruncated) {
        lines.push('[note: transcript read window hit its byte cap — older entries were not read; page back with offset/limit]');
      }
      const notice = buildTruncationNotice(meta);
      if (notice) lines.push(notice);
      lines.push(`[conversation-meta] ${JSON.stringify(meta)}`);

      return lines.join('\n');
    }, { maxResultChars: MAX_TRANSCRIPT_RESULT_CHARS }),
  });
}
