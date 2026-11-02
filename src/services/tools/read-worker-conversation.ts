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
  /** Read the worker's on-disk transcript; null when the file does not exist. */
  readTranscript: (workerId: string) => ConversationEntry[] | null;
  /** Active workers — used to tell "no transcript yet" from "unknown worker". */
  listWorkers?: () => ActiveWorkerInfo[];
  /** Known tasks — a finished worker can still be referenced by workerSessionId. */
  listTasks?: () => TaskDetail[];
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Does any live record prove this worker id existed in this session? */
function workerKnown(workerId: string, deps: ReadWorkerConversationDeps): boolean {
  const active = deps.listWorkers?.().some((w) => w.workerId === workerId) ?? false;
  if (active) return true;
  return deps.listTasks?.().some((t) => t.workerSessionId === workerId) ?? false;
}

export function readWorkerConversationTool(deps: ReadWorkerConversationDeps) {
  return defineTool({
    description:
      'Read a worker\'s own conversation transcript directly from disk ' +
      '(<sessionDir>/workers/<workerId>/conversation.jsonl). Works for running AND for ' +
      'completed/failed/cancelled workers, because it does not depend on the engine\'s ' +
      'in-memory worker map. Entries are printed in chronological order. ' +
      'Pagination: limit (default 20, counted back from the newest), offset (default 0, ' +
      'skip the newest N), maxChars (per-entry cap, default 200), full=true (complete text, ' +
      'all entries), type (filter: user/assistant/system/signal/tool). ' +
      'Truncation is always marked explicitly and reported as ' +
      'totalEntries / returnedEntries / offset / truncated.',
    parameters: z.object({
      workerId: z.string().describe('Worker ID (e.g. cw-1793587065421-6h37)'),
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
      const all = deps.readTranscript(workerId);

      if (all === null) {
        if (!workerKnown(workerId, deps)) {
          return `Worker ${workerId} not found (no worker with this id in session ${deps.sessionDir}).`;
        }
        return `no transcript found for worker ${workerId} (session dir: ${deps.sessionDir}) — ` +
          `expected ${workerTranscriptPath(deps.sessionDir, workerId)}`;
      }

      const filter = type;
      const population = filter === undefined
        ? all
        : filter === 'tool'
          ? all.filter((e) => Array.isArray((e as { toolCalls?: unknown }).toolCalls)
            && ((e as { toolCalls?: unknown[] }).toolCalls?.length ?? 0) > 0)
          : all.filter((e) => e.type === filter);

      const isFull = full === true;
      const requestedLimit = isFull ? population.length : (limit ?? DEFAULT_LIMIT);
      const perEntryCap = isFull ? null : (maxChars ?? DEFAULT_MAX_CHARS);
      const requested = selectWindow(population, offset ?? 0, requestedLimit);
      const rendered = renderEntriesFitting(
        requested.entries,
        requested.startIndex,
        { maxChars: perEntryCap, includeToolDetail: isFull },
        MAX_TRANSCRIPT_RESULT_CHARS - OUTPUT_OVERHEAD_CHARS,
      );
      const win = shrinkWindow(requested, rendered.dropped);
      const body = rendered.lines;

      const meta = {
        workerId,
        ...buildWindowMeta(win, { maxChars: perEntryCap, full: isFull, shortenedEntries: rendered.shortened }),
        ...(filter !== undefined && { filter, totalEntriesBeforeFilter: all.length }),
      };

      const summary = summarizeTranscript(all);
      const lines = [
        `Worker ${workerId} transcript: ${workerTranscriptPath(deps.sessionDir, workerId)}`,
        `Last activity: ${formatLastActivity(summary.lastActivityAt, now)}; ` +
          `currentTool: ${summary.currentTool ?? '-'}; terminal marker: ${summary.terminalSubtype ?? '-'}`,
        buildTranscriptHeader(meta)
          + (filter !== undefined ? ` [type=${filter}; ${all.length} entries in transcript]` : ''),
        ...body,
      ];

      const notice = buildTruncationNotice(meta);
      if (notice) lines.push(notice);
      lines.push(`[transcript-meta] ${JSON.stringify(meta)}`);
      return lines.join('\n');
    }, { maxResultChars: MAX_TRANSCRIPT_RESULT_CHARS }),
  });
}
