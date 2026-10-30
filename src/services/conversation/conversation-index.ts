/**
 * ConversationIndexBuilder — in-memory turn grouping over one conversation
 * (one JSONL file). Derived, read-only view data; never persisted.
 *
 * Grouping rule: one turn = one agent activation. Entries carry `turnId`
 * (new data). Legacy entries without `turnId` are backfilled in memory:
 * a user entry starts a new derived turn (`legacy-turn-<n>`); everything else
 * attaches to the most recent turn (real or derived), so mixed old/new data
 * in one file groups correctly.
 *
 * Status rule per turn:
 *  - 'running'   — any pending/running sync tool call, or any dispatched task
 *                 (add_task toolCall.taskId) without a terminal signal yet.
 *  - 'failed'    — a sync tool call / tool result failed, an error system
 *                 entry, a consumed worker_failed signal, or a dispatched
 *                 task that terminated as failed.
 *  - 'cancelled' — a dispatched task terminated as cancelled (task_cancelled
 *                 signal) and nothing in the turn failed.
 *  - 'completed' — otherwise.
 */

import type {
  AssistantEntry,
  ConversationEntry,
  ConversationIndex,
  ETurnStatus,
  SignalEntry,
  ToolRecordStatus,
  TurnToolCallView,
  TurnUsage,
  TurnView,
  UserEntry,
} from '@/types/conversation';
import { EEntryType, ESignalSubtype, ESystemSubtype, isCompactMarker } from '@/types/conversation';

/** Internal mutable state tracked per turn. */
interface TurnAccum {
  view: TurnView;
  /** Tasks dispatched by this turn with no terminal signal yet. */
  unfinishedTaskIds: Set<string>;
  /** A sync (non-task) tool call is pending/running. */
  hasSyncRunning: boolean;
  /** Something in this turn failed. */
  hasFailure: boolean;
  /** A task dispatched by this turn was cancelled (not a failure). */
  hasCancelled: boolean;
  /** toolCallId → view tool-call object (for result-status joins). */
  toolCallById: Map<string, TurnToolCallView>;
  /** First actor seen on any entry of the turn. */
  firstActor?: TurnView['actor'];
  /** First actor seen on an assistant/system entry (the acting agent). */
  agentActor?: TurnView['actor'];
}

function emptyUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function newTurn(turnId: string): TurnAccum {
  const view: TurnView = {
    turnId,
    status: 'running',
    steps: [],
    signals: [],
    toolCalls: [],
    usage: emptyUsage(),
    entryIds: [],
  };
  return { view, unfinishedTaskIds: new Set(), hasSyncRunning: false, hasFailure: false, hasCancelled: false, toolCallById: new Map() };
}

/** Earliest/latest ISO bookkeeping: keep the original string of the min/max epoch. */
function trackTimeBounds(view: TurnView, iso: string | undefined, pick: 'start' | 'end'): void {
  if (iso === undefined) return;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return;
  const current = pick === 'start' ? view.startedAt : view.endedAt;
  if (current === undefined) {
    if (pick === 'start') view.startedAt = iso;
    else view.endedAt = iso;
    return;
  }
  const cur = Date.parse(current);
  if (Number.isNaN(cur)) return;
  if (pick === 'start' ? t < cur : t > cur) {
    if (pick === 'start') view.startedAt = iso;
    else view.endedAt = iso;
  }
}

/** Terminal signal subtypes for a dispatched task. */
function terminalSignalForTask(subtype: SignalEntry['subtype']): 'terminal-failed' | 'terminal-cancelled' | 'terminal-ok' | null {
  if (subtype === ESignalSubtype.WorkerFailed) return 'terminal-failed';
  if (subtype === ESignalSubtype.TaskCancelled) return 'terminal-cancelled';
  if (subtype === ESignalSubtype.WorkerCompleted || subtype === ESignalSubtype.WorkerDisposed) return 'terminal-ok';
  return null;
}

export class ConversationIndexBuilder {
  private accs: TurnAccum[] = [];
  private byTurnId = new Map<string, TurnAccum>();
  private byEntryIdMap = new Map<string, TurnView>();
  /** taskId → turn that dispatched it (for terminal-signal resolution). */
  private taskDispatchTurn = new Map<string, TurnAccum>();
  /** Sequence for derived legacy turn ids. */
  private legacySeq = 0;
  /** Turn id derived for the most recent entry lacking an explicit turnId. */
  private currentDerivedTurnId: string | undefined;

  constructor(entries?: ConversationEntry[]) {
    for (const entry of entries ?? []) this.onAppend(entry);
  }

  /**
   * Feed one more entry. O(1) amortized (a terminal signal also updates the
   * dispatching turn). Duplicate uuids are ignored, making append feeds
   * idempotent.
   */
  onAppend(entry: ConversationEntry): void {
    if (entry.uuid !== undefined && this.byEntryIdMap.has(entry.uuid)) return;

    const turnId = this.resolveTurnId(entry);
    let acc = this.byTurnId.get(turnId);
    if (!acc) {
      acc = newTurn(turnId);
      this.accs.push(acc);
      this.byTurnId.set(turnId, acc);
    }
    const { view } = acc;

    // --- Common bookkeeping ---
    this.byEntryIdMap.set(entry.uuid, view);
    view.entryIds.push(entry.uuid);
    trackTimeBounds(view, entry.startedAt ?? entry.timestamp, 'start');
    trackTimeBounds(view, entry.endedAt ?? entry.timestamp, 'end');
    if (view.rootTurnId === undefined && entry.rootTurnId !== undefined) {
      view.rootTurnId = entry.rootTurnId;
    }
    if (entry.actor !== undefined) {
      if (acc.firstActor === undefined) acc.firstActor = entry.actor;
      if (
        acc.agentActor === undefined
        && (entry.type === EEntryType.Assistant || entry.type === EEntryType.System)
      ) {
        acc.agentActor = entry.actor;
      }
    }
    // Prefer the acting agent's actor; fall back to the first actor seen.
    view.actor = acc.agentActor ?? acc.firstActor;

    switch (entry.type) {
      case EEntryType.User:
        this.applyUserEntry(acc, entry as UserEntry);
        break;
      case EEntryType.Assistant:
        this.applyAssistantEntry(acc, entry as AssistantEntry);
        break;
      case EEntryType.Signal:
        this.applySignalEntry(acc, entry as SignalEntry);
        break;
      case EEntryType.System:
        this.applySystemEntry(acc, entry);
        break;
    }

    this.recomputeStatus(acc);
  }

  /** Read-only index snapshot (live objects — callers must not mutate). */
  getIndex(): ConversationIndex {
    return { turns: this.accs.map(a => a.view), byEntryId: this.byEntryIdMap };
  }

  /** Look up a turn by id. */
  getTurn(turnId: string): TurnView | undefined {
    return this.byTurnId.get(turnId)?.view;
  }

  /** Look up the turn an entry belongs to. */
  getTurnByEntryId(entryId: string): TurnView | undefined {
    return this.byEntryIdMap.get(entryId);
  }

  get turnCount(): number {
    return this.accs.length;
  }

  // --- Internals ---

  /**
   * Resolve the turn an entry belongs to. New data carries `turnId`; legacy
   * data is backfilled: a user entry starts a new derived turn, anything else
   * attaches to the most recent turn.
   */
  private resolveTurnId(entry: ConversationEntry): string {
    if (entry.turnId !== undefined && entry.turnId !== null) {
      this.currentDerivedTurnId = entry.turnId;
      return entry.turnId;
    }
    if (entry.type === EEntryType.User || this.currentDerivedTurnId === undefined) {
      this.currentDerivedTurnId = `legacy-turn-${this.legacySeq++}`;
    }
    return this.currentDerivedTurnId;
  }

  private applyUserEntry(acc: TurnAccum, entry: UserEntry): void {
    if (acc.view.userEntry === undefined) acc.view.userEntry = entry;
  }

  private applyAssistantEntry(acc: TurnAccum, entry: AssistantEntry): void {
    const { view } = acc;
    view.steps.push(entry);

    // Usage accumulation (single-step values are summed here).
    const u = entry.message?.usage;
    if (u) {
      view.usage.inputTokens += u.inputTokens ?? 0;
      view.usage.outputTokens += u.outputTokens ?? 0;
      view.usage.cachedInputTokens += u.cachedInputTokens ?? 0;
      view.usage.reasoningTokens += u.reasoningTokens ?? 0;
      // Older entries carry no totalTokens — derive from in+out for those.
      view.usage.totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    }

    // Tool calls
    if (entry.toolCalls) {
      for (const tc of entry.toolCalls) {
        const vtc: TurnToolCallView = {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          ...(tc.taskId !== undefined && { taskId: tc.taskId }),
          ...(tc.status !== undefined && { status: tc.status }),
          ...(tc.startedAt !== undefined && { startedAt: tc.startedAt }),
          ...(tc.endedAt !== undefined && { endedAt: tc.endedAt }),
        };
        view.toolCalls.push(vtc);
        acc.toolCallById.set(tc.toolCallId, vtc);

        if (tc.status === 'failed') acc.hasFailure = true;
        if (tc.status === 'pending' || tc.status === 'running') {
          if (tc.taskId !== undefined) {
            // Async dispatch: unfinished until a terminal signal for the task.
            acc.unfinishedTaskIds.add(tc.taskId);
            this.taskDispatchTurn.set(tc.taskId, acc);
          } else {
            acc.hasSyncRunning = true;
          }
        }
      }
    }

    // Tool results → join result status onto the matching view tool call
    if (entry.toolResults) {
      for (const tr of entry.toolResults) {
        const status: ToolRecordStatus | undefined =
          tr.status ?? (tr.isError ? 'failed' : 'succeeded');
        const vtc = acc.toolCallById.get(tr.toolCallId);
        if (vtc && status !== undefined) vtc.resultStatus = status;
        if (tr.isError || status === 'failed') acc.hasFailure = true;
      }
    }
  }

  private applySignalEntry(acc: TurnAccum, entry: SignalEntry): void {
    const { view } = acc;
    view.signals.push(entry);

    const terminal = terminalSignalForTask(entry.subtype);
    if (terminal !== null && entry.taskId !== undefined) {
      // The consuming turn registers failure for worker_failed only — a
      // task_cancelled signal is informational, not a failure of the
      // controller run that observes it.
      if (terminal === 'terminal-failed') acc.hasFailure = true;
      // …and the dispatching turn's unfinished task resolves.
      const dispatchAcc = this.taskDispatchTurn.get(entry.taskId);
      if (dispatchAcc) {
        dispatchAcc.unfinishedTaskIds.delete(entry.taskId);
        if (terminal === 'terminal-failed') dispatchAcc.hasFailure = true;
        if (terminal === 'terminal-cancelled') dispatchAcc.hasCancelled = true;
        this.recomputeStatus(dispatchAcc);
      }
    }
  }

  private applySystemEntry(acc: TurnAccum, entry: ConversationEntry): void {
    // Error system entries (controller loop crash, third-party worker failure)
    // mark the turn failed. Compact markers are chain boundaries, not failures.
    if (!isCompactMarker(entry) && (entry as { subtype?: string }).subtype === ESystemSubtype.Error) {
      acc.hasFailure = true;
    }
  }

  private recomputeStatus(acc: TurnAccum): void {
    let status: ETurnStatus;
    if (acc.unfinishedTaskIds.size > 0 || acc.hasSyncRunning) {
      status = 'running';
    } else if (acc.hasFailure) {
      status = 'failed';
    } else if (acc.hasCancelled) {
      status = 'cancelled';
    } else {
      status = 'completed';
    }
    acc.view.status = status;
  }
}

/** Build a full index in one scan. */
export function buildConversationIndex(entries: ConversationEntry[]): ConversationIndexBuilder {
  return new ConversationIndexBuilder(entries);
}
