import { z } from 'zod';
import type { ConversationEntry } from '@/types/conversation';
import type { ActiveWorkerInfo, TaskDetail } from '@/types/index';
import { defineTool, safeExecute } from './common';
import {
  MAX_TRANSCRIPT_RESULT_CHARS,
  buildTranscriptHeader,
  buildTruncationNotice,
  buildWindowMeta,
  formatLastActivity,
  isValidWorkerId,
  renderEntriesFitting,
  selectWindow,
  shrinkWindow,
  summarizeTranscript,
  workerTranscriptPath,
  type TranscriptReadOptions,
  type WorkerTranscriptWindow,
} from '@/services/worker-transcript';

/** Output chars reserved for the header, notices and the meta line. */
const OUTPUT_OVERHEAD_CHARS = 1_500;

/** Default number of entries returned (counting back from the newest). */
const DEFAULT_LIMIT = 20;
/** Default per-entry character cap. */
const DEFAULT_MAX_CHARS = 200;

/** Entry types accepted by the `type` filter (`tool` = assistant entries with tool calls). */
const FILTER_TYPES = ['user', 'assistant', 'system', 'signal', 'tool'] as const;

export interface ReadWorkerConversationDeps {
  /** Session directory holding `workers/<workerId>/conversation.jsonl`. */
  sessionDir: string;
  /**
   * Live in-memory conversation of an engine-tracked worker, looked up by
   * worker id. Undefined once the engine no longer tracks the worker.
   */
  getWorkerConversationByWorkerId?: (workerId: string) => ConversationEntry[] | undefined;
  /**
   * The worker instance's own id (agent-…/cw-…) for a worker the engine still
   * tracks — the on-disk transcript directory name.
   */
  getWorkerTranscriptId?: (workerId: string) => string | undefined;
  /**
   * Windowed read of an on-disk transcript (tail-bounded, never the whole
   * file in memory). Null when the file does not exist.
   */
  readTranscriptWindow: (workerId: string, opts: TranscriptReadOptions) => WorkerTranscriptWindow | null;
  /** Active workers — used to tell the failure modes apart. */
  listWorkers?: () => ActiveWorkerInfo[];
  /** Known tasks — finished workers stay referenced via workerSessionId/workerTranscriptId. */
  listTasks?: () => TaskDetail[];
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Same predicate the population filter uses — also drives the read-window growth. */
function typeMatches(entry: ConversationEntry, filter: string): boolean {
  if (filter === 'tool') {
    const calls = (entry as { toolCalls?: unknown[] }).toolCalls;
    return Array.isArray(calls) && calls.length > 0;
  }
  return entry.type === filter;
}

export function readWorkerConversationTool(deps: ReadWorkerConversationDeps) {
  return defineTool({
    description:
      'Read a worker\'s conversation transcript. Layered source: while the engine ' +
      'still tracks the worker (running or idle), its live in-memory conversation is ' +
      'returned (meta source="memory"); once the worker finished/failed/was cancelled ' +
      'or disposed, the append-only on-disk file ' +
      '<sessionDir>/workers/<transcript id>/conversation.jsonl is read instead ' +
      '(meta source="disk") — so it works for running AND completed/failed/cancelled ' +
      'workers. Pagination: offset skips N entries counted back from the newest; ' +
      'output is ordered oldest→newest; type filtering is applied BEFORE pagination. ' +
      'limit (default 20, max entries), maxChars (per-entry cap, default 200), ' +
      'full=true (complete text, all entries — still bounded by a 2 MB read window), ' +
      'type (filter: user/assistant/system/signal/tool). Truncation is always marked ' +
      'explicitly and reported as totalEntries / returnedEntries / offset / truncated, ' +
      'plus incompleteTail (last entry still being written) and readWindowTruncated ' +
      '(older entries exist beyond the read-window cap — page back with offset).',
    parameters: z.object({
      workerId: z.string().describe('Worker ID (e.g. w-1793587065421-6h37)'),
      limit: z.number().int().min(1).optional().describe(`Max entries to return (default ${DEFAULT_LIMIT})`),
      offset: z.number().int().min(0).optional().describe('Skip the newest N entries (default 0)'),
      maxChars: z.number().int().min(1).optional().describe(`Per-entry character cap (default ${DEFAULT_MAX_CHARS})`),
      full: z.boolean().optional().describe('Return complete entry text and all entries (ignores limit/maxChars)'),
      type: z.enum(FILTER_TYPES).optional()
        .describe('Only entries of this type; "tool" = assistant entries that made tool calls'),
    }),
    execute: safeExecute('read_worker_conversation', async ({ workerId, limit, offset, maxChars, full, type }) => {
      const now = deps.now?.() ?? Date.now();
      if (!isValidWorkerId(workerId)) {
        return `Invalid worker id "${workerId}" — worker ids are alphanumeric with dashes/underscores only.`;
      }

      const task = deps.listTasks?.().find((t) => t.workerSessionId === workerId);
      const isActive = deps.listWorkers?.().some((w) => w.workerId === workerId) ?? false;
      const liveTranscriptId = deps.getWorkerTranscriptId?.(workerId);

      const isFull = full === true;
      const requestedLimit = limit ?? DEFAULT_LIMIT;
      const need = isFull ? undefined : (offset ?? 0) + requestedLimit;
      const matches = type === undefined ? undefined : (e: ConversationEntry) => typeMatches(e, type);

      // --- Layer 1: live in-memory conversation (engine still tracks the worker).
      // Independent of the on-disk directory naming, so it works while running.
      const memory = deps.getWorkerConversationByWorkerId?.(workerId);
      if (memory !== undefined && memory.length > 0) {
        return render({ source: 'memory', entries: memory });
      }

      // --- Layer 2: on-disk transcript, resolved through the worker's OWN id
      // (the directory name), never the engine id. Candidates, in order:
      // the task's persisted workerTranscriptId, the live instance id, then
      // the raw id (a controller may genuinely know a cw-…/agent-… id).
      const candidates: string[] = [];
      for (const id of [task?.workerTranscriptId, liveTranscriptId, workerId]) {
        if (typeof id === 'string' && !candidates.includes(id)) candidates.push(id);
      }
      let disk: { id: string; win: WorkerTranscriptWindow } | null = null;
      for (const id of candidates) {
        const win = deps.readTranscriptWindow(id, { need, matches });
        if (win !== null) {
          disk = { id, win };
          break;
        }
      }

      if (disk !== null) {
        return render({
          source: 'disk',
          entries: disk.win.entries,
          transcriptId: disk.id,
          incompleteTail: disk.win.incompleteTail,
          readWindowTruncated: disk.win.windowTruncated,
        });
      }

      // --- No usable conversation. Distinguish the failure modes instead of
      // one vague "no transcript found".
      const known = isActive || task !== undefined || memory !== undefined;
      if (!known) {
        return `Unknown worker ${workerId}: no active worker and no task references it.`;
      }
      if (isActive) {
        return `Worker ${workerId} is running but has not written any transcript entries yet.`;
      }
      const resolved = task?.workerTranscriptId ?? liveTranscriptId;
      if (resolved !== undefined) {
        return `Worker ${workerId} exists but its transcript directory is missing on disk ` +
          `(expected ${workerTranscriptPath(deps.sessionDir, resolved)}).`;
      }
      return `Worker ${workerId} exists but its transcript cannot be located on disk (legacy session id layout?).`;

      // Shared pagination + rendering for both sources.
      function render(src: {
        source: 'memory' | 'disk';
        entries: ConversationEntry[];
        transcriptId?: string;
        incompleteTail?: boolean;
        readWindowTruncated?: boolean;
      }): string {
        const { source, entries } = src;
        const incompleteTail = src.incompleteTail ?? false;
        const readWindowTruncated = src.readWindowTruncated ?? false;

        if (entries.length === 0) {
          const emptyMsg = `Transcript for worker ${workerId} exists but contains no complete entries yet.`;
          return incompleteTail
            ? `${emptyMsg}\n[note: last entry is incomplete — the transcript is still being written]`
            : emptyMsg;
        }

        const filter = type;
        const population = filter === undefined ? entries : entries.filter((e) => typeMatches(e, filter));

        const reqLimit = isFull ? population.length : requestedLimit;
        const perEntryCap = isFull ? null : (maxChars ?? DEFAULT_MAX_CHARS);
        const requested = selectWindow(population, offset ?? 0, reqLimit);
        const rendered = renderEntriesFitting(
          requested.entries,
          requested.startIndex,
          { maxChars: perEntryCap, includeToolDetail: isFull },
          MAX_TRANSCRIPT_RESULT_CHARS - OUTPUT_OVERHEAD_CHARS,
        );
        const win = shrinkWindow(requested, rendered.dropped);
        const body = rendered.lines;

        const base = buildWindowMeta(win, {
          maxChars: perEntryCap,
          full: isFull,
          shortenedEntries: rendered.shortened,
        });
        const meta = {
          workerId,
          source,
          ...(src.transcriptId !== undefined && { transcriptId: src.transcriptId }),
          ...base,
          incompleteTail,
          readWindowTruncated,
          windowTruncated: base.windowTruncated || readWindowTruncated,
          truncated: base.truncated || readWindowTruncated,
          ...(filter !== undefined && { filter, totalEntriesBeforeFilter: entries.length }),
        };

        const summary = summarizeTranscript(entries);
        const headLine = source === 'disk'
          ? `Worker ${workerId} transcript (source=disk, dir id ${src.transcriptId}): ` +
            workerTranscriptPath(deps.sessionDir, src.transcriptId ?? workerId)
          : `Worker ${workerId} conversation (source=memory — live in-memory state of the tracked worker)`;
        const lines = [
          headLine,
          `Last activity: ${formatLastActivity(summary.lastActivityAt, now)}; ` +
            `currentTool: ${summary.currentTool ?? '-'}; terminal marker: ${summary.terminalSubtype ?? '-'}`,
        ];

        let header = buildTranscriptHeader(meta);
        if (readWindowTruncated) {
          header = `Conversation (${meta.totalEntries} entries in read window, showing ` +
            `${meta.startIndex}-${meta.endIndex}; older entries exist beyond the read-window cap):`;
        }
        lines.push(header + (filter !== undefined ? ` [type=${filter}; ${entries.length} entries in transcript]` : ''));
        lines.push(...body);

        if (incompleteTail) {
          lines.push('[note: last entry is incomplete — the transcript is still being written]');
        }
        if (readWindowTruncated) {
          lines.push('[note: transcript read window hit its byte cap — older entries were not read; page back with offset/limit]');
        }
        const notice = buildTruncationNotice(meta);
        if (notice) lines.push(notice);
        lines.push(`[transcript-meta] ${JSON.stringify(meta)}`);
        return lines.join('\n');
      }
    }, { maxResultChars: MAX_TRANSCRIPT_RESULT_CHARS }),
  });
}
