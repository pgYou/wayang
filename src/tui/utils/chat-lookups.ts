/**
 * Cross-row lookups for the chat area.
 *
 * Some rows only carry an id that points at context rendered elsewhere in the
 * conversation: a `respond_permission` call carries a requestId (the request
 * itself is an earlier signal row), a `chat_worker` call carries a workerId.
 * These maps let such rows show WHAT they refer to instead of a bare id.
 *
 * Built from the full item list (read + unread). Derived view data only —
 * never persisted.
 */
import type { PermissionRequestMeta, WorkerInquiryMeta } from '@/types/conversation';
import type { DisplayItem } from '@/tui/types/display-item';

/** Display context of one worker, collected from its signal rows. */
export interface WorkerContext {
  workerId: string;
  emoji?: string;
  workerType?: string;
  /** Title of the task the worker last reported on. */
  taskTitle?: string;
}

/** A permission request plus the worker that raised it. */
export interface PermissionRequestContext {
  meta: PermissionRequestMeta;
  worker?: WorkerContext;
}

/** A worker inquiry plus the worker that raised it. */
export interface WorkerInquiryContext {
  meta: WorkerInquiryMeta;
  worker?: WorkerContext;
}

export interface ChatLookups {
  /** requestId → original permission request. */
  permissionRequests: Map<string, PermissionRequestContext>;
  /** inquiryId → original worker inquiry. */
  inquiries: Map<string, WorkerInquiryContext>;
  /** workerId → worker display context. */
  workers: Map<string, WorkerContext>;
  /** workerType → display emoji (first one seen). */
  workerTypeEmoji: Map<string, string>;
}

export const EMPTY_CHAT_LOOKUPS: ChatLookups = {
  permissionRequests: new Map(),
  inquiries: new Map(),
  workers: new Map(),
  workerTypeEmoji: new Map(),
};

/** Build the lookups from the chat's display items. */
export function buildChatLookups(items: readonly DisplayItem[]): ChatLookups {
  const permissionRequests = new Map<string, PermissionRequestContext>();
  const inquiries = new Map<string, WorkerInquiryContext>();
  const workers = new Map<string, WorkerContext>();
  const workerTypeEmoji = new Map<string, string>();

  for (const item of items) {
    if (item.role !== 'signal') continue;

    if (item.workerType && item.emoji && !workerTypeEmoji.has(item.workerType)) {
      workerTypeEmoji.set(item.workerType, item.emoji);
    }

    let worker: WorkerContext | undefined;
    if (item.workerId) {
      const prev = workers.get(item.workerId);
      // Later signals win for the task title: a multi-stage worker moves on
      // to new tasks, and the latest one is what the next row refers to.
      worker = {
        workerId: item.workerId,
        emoji: item.emoji ?? prev?.emoji,
        workerType: item.workerType ?? prev?.workerType,
        taskTitle: item.taskTitle ?? prev?.taskTitle,
      };
      workers.set(item.workerId, worker);
    }

    const requestId = item.permissionMeta?.requestId;
    if (item.permissionMeta && requestId) {
      permissionRequests.set(requestId, { meta: item.permissionMeta, ...(worker && { worker }) });
    }

    const inquiryId = item.inquiryMeta?.inquiryId;
    if (item.inquiryMeta && inquiryId) {
      inquiries.set(inquiryId, { meta: item.inquiryMeta, ...(worker && { worker }) });
    }
  }

  return { permissionRequests, inquiries, workers, workerTypeEmoji };
}

/**
 * Worker tag for secondary lines: "🧸 <task title> · w:abcd".
 * Parts that are unknown are omitted; empty string when nothing is known.
 */
export function formatWorkerTag(ctx: { workerId?: string; emoji?: string; taskTitle?: string }): string {
  const parts: string[] = [];
  if (ctx.taskTitle) parts.push(ctx.taskTitle);
  if (ctx.workerId) parts.push(`w:${ctx.workerId.slice(-4)}`);
  const body = parts.join(' · ');
  return [ctx.emoji, body].filter(Boolean).join(' ');
}
