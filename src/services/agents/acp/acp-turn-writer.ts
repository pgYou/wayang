/**
 * Turn-scoped transcript writer for ACP workers.
 *
 * The conversation schema stores one LLM step atomically on a single
 * AssistantEntry (text + toolCalls + toolResults), while storage is
 * append-only JSONL — so a tool-carrying step is buffered in memory until its
 * results arrive, exactly like the claude-code worker's `_pendingToolSteps`
 * (see utils/claude-tool-records.ts). This module carries that buffering for
 * ACP mapped events:
 *
 * - consecutive `agent-text` chunks accumulate into one open text segment,
 *   flushed as its own entry when a tool call starts or the turn ends;
 * - every tool call owns a buffered entry; a terminal `tool-result` attaches
 *   to it and completed entries flush head-first (file order == arrival
 *   order);
 * - `finishTurn()` writes everything still buffered, marking calls that never
 *   received a result 'cancelled' instead of claiming to run forever.
 *
 * Transcript isomorphism (02 §7, hard constraint): entries are shaped exactly
 * like puppet/claude-code ones so the read side (`worker-transcript.ts`,
 * `read_worker_conversation`, `get_worker_status`) needs no provider fork.
 */

import type { AssistantEntry, ConversationEntry, ToolCallRecord, ToolResultRecord } from '@/types/index';
import { EEntryType } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';

/** Buffered assistant step whose tool results may still be in flight. */
interface PendingToolStep {
  entry: AssistantEntry;
}

export class AcpTurnWriter {
  private readonly append: (entry: ConversationEntry) => void;
  private readonly sessionId: string;
  private openTextParts: string[] = [];
  private pendingToolSteps: PendingToolStep[] = [];
  private lastFlushedText: string | null = null;

  constructor(append: (entry: ConversationEntry) => void, sessionId: string) {
    this.append = append;
    this.sessionId = sessionId;
  }

  /** Reset per-turn buffers (a run may execute several turns). */
  reset(): void {
    this.openTextParts = [];
    this.pendingToolSteps = [];
    this.lastFlushedText = null;
  }

  /** Accumulate one agent-text chunk into the open segment. */
  addText(text: string): void {
    if (text.length > 0) this.openTextParts.push(text);
  }

  /** The last completed text segment — the turn summary (02 §3 step 8). */
  lastText(): string | null {
    return this.lastFlushedText;
  }

  /**
   * Read-only view of the OPEN text segment: every `agent-text` chunk the run
   * has aggregated since the last flush. This is the single text source for
   * progress reporting (the degraded path must never keep a second copy).
   */
  openText(): string {
    return this.openTextParts.join('');
  }

  /**
   * Buffer a tool call. A same-id record (running → terminal evolution of one
   * call) replaces the previous one inside its owning step instead of piling
   * up duplicates — the entry is still unwritten, so this is not a post-hoc
   * mutation of persisted data.
   */
  addToolCall(record: ToolCallRecord): void {
    for (const step of this.pendingToolSteps) {
      const calls = step.entry.toolCalls ?? [];
      const index = calls.findIndex((call) => call.toolCallId === record.toolCallId);
      if (index >= 0) {
        calls[index] = record;
        return;
      }
    }
    // A new call closes the open text segment first so entry order matches
    // arrival order.
    this.flushOpenText();
    const timestamp = nowISO();
    this.pendingToolSteps.push({
      entry: {
        type: EEntryType.Assistant,
        uuid: generateId('a'),
        parentUuid: null,
        sessionId: this.sessionId,
        timestamp,
        startedAt: timestamp,
        message: { role: 'assistant', content: '' },
        toolCalls: [record],
      },
    });
  }

  /**
   * Attach a tool result to the buffered step that issued the call. Unknown
   * ids (duplicate or late results) are dropped — no entry is invented for
   * them.
   */
  addToolResult(record: ToolResultRecord): void {
    const owner = this.pendingToolSteps.find((step) =>
      (step.entry.toolCalls ?? []).some((call) => call.toolCallId === record.toolCallId),
    );
    if (!owner) return;
    (owner.entry.toolResults ??= []).push(record);
    const call = (owner.entry.toolCalls ?? []).find((tc) => tc.toolCallId === record.toolCallId);
    if (call) {
      call.status = record.status;
      call.endedAt = record.endedAt;
      if (record.isError) call.errorType = record.errorType;
    }
    this.flushCompletedSteps();
  }

  /** Write the open text segment (if any) as its own entry. */
  flushOpenText(): void {
    if (this.openTextParts.length === 0) return;
    const text = this.openTextParts.join('');
    this.openTextParts = [];
    this.lastFlushedText = text;
    const timestamp = nowISO();
    this.append({
      type: EEntryType.Assistant,
      uuid: generateId('a'),
      parentUuid: null,
      sessionId: this.sessionId,
      timestamp,
      startedAt: timestamp,
      endedAt: timestamp,
      message: { role: 'assistant', content: text },
    } as ConversationEntry);
  }

  /** Write buffered steps whose calls have ALL received results, head first. */
  private flushCompletedSteps(): void {
    while (this.pendingToolSteps.length > 0) {
      const head = this.pendingToolSteps[0];
      const callIds = new Set((head.entry.toolCalls ?? []).map((call) => call.toolCallId));
      const resultIds = new Set((head.entry.toolResults ?? []).map((result) => result.toolCallId));
      let complete = true;
      for (const id of callIds) {
        if (!resultIds.has(id)) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
      this.pendingToolSteps.shift();
      head.entry.endedAt = nowISO();
      this.append(head.entry);
    }
  }

  /**
   * End of turn: flush the open text, then write every still-buffered step.
   * Calls that never received a result (cancel, agent death mid-tool) are
   * marked 'cancelled'.
   */
  finishTurn(): void {
    this.flushOpenText();
    if (this.pendingToolSteps.length === 0) return;
    const timestamp = nowISO();
    for (const step of this.pendingToolSteps) {
      const resultIds = new Set((step.entry.toolResults ?? []).map((result) => result.toolCallId));
      for (const call of step.entry.toolCalls ?? []) {
        if (!resultIds.has(call.toolCallId)) {
          call.status = 'cancelled';
          if (call.endedAt === undefined) call.endedAt = timestamp;
        }
      }
      step.entry.endedAt = timestamp;
      this.append(step.entry);
    }
    this.pendingToolSteps = [];
  }

  /** Number of steps still waiting for results (diagnostics/tests). */
  get bufferedSteps(): number {
    return this.pendingToolSteps.length;
  }
}
