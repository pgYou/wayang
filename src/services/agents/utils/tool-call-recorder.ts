/**
 * ToolCallRecorder — live bookkeeping of tool executions, keyed by toolCallId.
 *
 * Tool sets are wrapped (recordToolCalls) so each execute() call registers
 * its start and finish. When a step finishes, buildAssistantEntry merges the
 * recorded status/timing/taskId back into the persisted ToolCallRecord /
 * ToolResultRecord by toolCallId.
 *
 * Records are consumed within the same run (a step's onStepFinish fires after
 * that step's tools have executed), so beginTurn() clears leftovers from a
 * previous run to keep the map bounded.
 */

import type { ToolRecordStatus } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { nowISO } from '@/utils/time';

/** Live record of one tool execution. */
export interface RecordedToolCall {
  toolCallId: string;
  toolName: string;
  /** Task dispatched by this call (async tools like add_task). */
  taskId?: string;
  status: ToolRecordStatus;
  startedAt: string;
  endedAt?: string;
  errorType?: string;
}

export class ToolCallRecorder {
  private records = new Map<string, RecordedToolCall>();

  /**
   * @param logger Optional logger — used for debug diagnostics (e.g. an
   * attachTask call that finds no live record). Absent in unit tests.
   */
  constructor(private readonly logger?: Logger) {}

  /** Clear records from previous runs. Call at the start of each agent run. */
  beginTurn(): void {
    this.records.clear();
  }

  start(toolCallId: string, toolName: string): void {
    this.records.set(toolCallId, { toolCallId, toolName, status: 'running', startedAt: nowISO() });
  }

  finish(toolCallId: string, status: ToolRecordStatus, errorType?: string): void {
    const rec = this.records.get(toolCallId);
    if (!rec) return;
    rec.status = status;
    rec.endedAt = nowISO();
    if (errorType) rec.errorType = errorType;
  }

  /**
   * Attach an async task dispatched by this call (e.g. add_task) and mark the
   * call as 'running': the tool returned, but the dispatched task is what
   * stays in flight. Terminal state arrives later via signal entries —
   * append-only storage means this record is never updated afterwards.
   */
  attachTask(toolCallId: string, taskId: string): void {
    const rec = this.records.get(toolCallId);
    if (!rec) {
      // Known benign case (e.g. the dispatch raced past turn cleanup) —
      // debug level so it never floods the log.
      this.logger?.debug({ toolCallId, taskId }, 'attachTask: no live tool-call record for toolCallId');
      return;
    }
    rec.taskId = taskId;
    rec.status = 'running';
    rec.endedAt = nowISO();
  }

  /** Look up a live record (used by the assistant-entry builder). */
  lookup(toolCallId: string): RecordedToolCall | undefined {
    return this.records.get(toolCallId);
  }
}

/** Error-string prefix produced by the safeExecute wrapper (common.ts). */
const TOOL_ERROR_PREFIX = '[ERROR]';

/**
 * Wrap a tool set so every execute() is timed and status-tracked by `recorder`.
 *
 * Behavior-preserving: the original execute is invoked with the same arguments
 * and options; only bookkeeping is added. Tools without an execute function
 * pass through untouched.
 */
export function recordToolCalls(
  tools: Record<string, any>,
  recorder: ToolCallRecorder,
): Record<string, any> {
  const wrapped: Record<string, any> = {};
  for (const [name, def] of Object.entries(tools)) {
    if (!def || typeof def.execute !== 'function') {
      wrapped[name] = def;
      continue;
    }
    const original = def.execute;
    wrapped[name] = {
      ...def,
      execute: async (args: any, options?: { toolCallId?: string }) => {
        const toolCallId = options?.toolCallId
          ?? `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        recorder.start(toolCallId, name);
        try {
          const result = await original(args, options);
          // safeExecute (used by all Wayang tools) converts thrown errors into
          // "[ERROR] ..." result strings — treat those as failed executions.
          if (typeof result === 'string' && result.startsWith(TOOL_ERROR_PREFIX)) {
            recorder.finish(toolCallId, 'failed', 'ToolError');
          } else {
            recorder.finish(toolCallId, 'succeeded');
          }
          return result;
        } catch (err: any) {
          recorder.finish(toolCallId, 'failed', err?.constructor?.name ?? 'Error');
          throw err;
        }
      },
    };
  }
  return wrapped;
}
