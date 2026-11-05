// ClaudeWorkerStream: SDK stream message processing — assistant/user/result
// messages, buffered tool steps, debounced progress and the usage record.
// Extends ClaudeWorkerPermissionGate.

import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EEntryType } from '@/types/index';
import type { AssistantEntry, ConversationEntry, ToolCallRecord } from '@/types/conversation';
import { toolUseBlockToRecord, toolResultBlockToRecord, type SdkToolUseBlock, type SdkToolResultBlock } from '../utils/claude-tool-records';
import { applyTurnEnvelope } from '../utils/entry-envelope';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { ClaudeWorkerPermissionGate } from './worker-permission';

export class ClaudeWorkerStream extends ClaudeWorkerPermissionGate {
  /**
   * Progress debounce mechanism.
   *
   * Claude Code SDK streams assistant messages before the final result message.
   * The last assistant message often contains a summary that duplicates the result.
   * To avoid showing the user two near-identical signals (progress + completed):
   *   1. Each assistant text is buffered for PROGRESS_DEBOUNCE_MS
   *   2. If a result message arrives before the timer fires, the pending progress is discarded
   *   3. If the timer fires (no result yet), the progress is emitted normally
   */
  private static readonly PROGRESS_DEBOUNCE_MS = 500;

  // --- Stream message processing ---

  protected processStreamMessage(message: SDKMessage, onProgress?: (msg: string) => void): void {
    if (message.type === 'assistant') {
      this.handleAssistantMessage(message, onProgress);
    } else if (message.type === 'user') {
      this.handleUserMessage(message);
    } else if (message.type === 'result') {
      this.handleResultMessage(message);
    }
    // Ignore other message types (system, status, stream events, etc.)
  }

  /** Append one entry to the conversation under the current turn envelope. */
  private appendConversationEntry(entry: ConversationEntry): void {
    this.state.append('conversation', applyTurnEnvelope(entry, this._currentTurnEnv ?? undefined));
  }

  /**
   * Drop a debounced progress delivery: cancel the timer and the buffered
   * text. Called when a result supersedes the progress, when the run is
   * aborted, and when the stream loop exits (all paths — the run is over, so
   * nothing may be delivered afterwards).
   */
  protected clearPendingProgress(): void {
    if (this._progressTimer) {
      clearTimeout(this._progressTimer);
      this._progressTimer = null;
    }
    this._pendingProgress = null;
  }

  protected handleAssistantMessage(msg: SDKAssistantMessage, onProgress?: (msg: string) => void): void {
    // Split the message's content blocks: text becomes the entry's text,
    // tool_use blocks become its toolCalls (puppet-shaped records).
    const textParts: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const ts = nowISO();
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push(toolUseBlockToRecord(block as SdkToolUseBlock, ts));
      }
    }
    const text = textParts.join('\n');

    // Nothing sayable and nothing ran — not worth an entry (existing behavior).
    if (!text && toolCalls.length === 0) return;

    const entry: AssistantEntry = {
      type: EEntryType.Assistant,
      uuid: generateId('a'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: ts,
      startedAt: ts,
      message: {
        role: 'assistant',
        content: text,
        usage: {
          inputTokens: msg.message.usage?.input_tokens ?? 0,
          outputTokens: msg.message.usage?.output_tokens ?? 0,
          ...(msg.message.usage?.cache_read_input_tokens != null && {
            cachedInputTokens: msg.message.usage.cache_read_input_tokens,
          }),
        },
      },
      ...(toolCalls.length > 0 && { toolCalls }),
    };

    if (this._pendingToolSteps.length > 0 || toolCalls.length > 0) {
      // A tool-carrying step must wait for its results (they arrive in a
      // later user message) so text + toolCalls + toolResults land on ONE
      // entry. Steps without tools queue only while older steps are still
      // waiting — that keeps file order == arrival order in every case.
      // endedAt is stamped at flush time (when the step's results landed).
      this._pendingToolSteps.push(entry);
    } else {
      // Pure text step — nothing to wait for, write it now.
      entry.endedAt = ts;
      this.appendConversationEntry(entry);
    }

    // Debounced progress: delay 500ms, cancel if result arrives first.
    // Fires off the assistant text at message time — independent of when the
    // conversation entry itself is written.
    if (text && onProgress) {
      this._pendingProgress = text.slice(0, 200);
      if (this._progressTimer) clearTimeout(this._progressTimer);
      this._progressTimer = setTimeout(() => {
        this._progressTimer = null;
        // The run may have ended between the message and this callback
        // (abort, error, stream close). Never deliver a progress after that:
        // the controller already saw the worker finish, and a late signal
        // would claim work that no longer exists.
        if (
          this._pendingProgress === null
          || this.abortController.signal.aborted
          || this._streamEnded
          || this._terminalResult !== null
        ) {
          this._pendingProgress = null;
          return;
        }
        const pending = this._pendingProgress;
        this._pendingProgress = null;
        onProgress(pending);
      }, ClaudeWorkerStream.PROGRESS_DEBOUNCE_MS);
    }
  }

  /**
   * SDK user messages carry the tool_result blocks for the preceding
   * assistant step's tool_use calls. Each result is merged into the buffered
   * entry that issued the matching id; completed steps are then written,
   * oldest first.
   *
   * User messages WITHOUT tool_result blocks (echoes of the task prompt or of
   * controller messages this worker itself injected) are ignored — the task
   * entry is written by run() and controller messages are audited elsewhere,
   * so writing them here would duplicate entries.
   */
  private handleUserMessage(msg: SDKUserMessage): void {
    const content = msg.message.content;
    if (!Array.isArray(content)) return;
    const ts = nowISO();

    for (const block of content) {
      if (!block || (block as SdkToolResultBlock).type !== 'tool_result') continue;
      const resultBlock = block as SdkToolResultBlock;
      // Find the buffered step that issued this tool_use id.
      const owner = this._pendingToolSteps.find(
        (step) => step.toolCalls?.some((tc) => tc.toolCallId === resultBlock.tool_use_id),
      );
      if (!owner) {
        // No buffered step owns this id (duplicate or late result) — drop it
        // with a debug log rather than inventing an entry for it.
        this.logger.debug(
          { toolUseId: resultBlock.tool_use_id },
          'tool_result with no matching pending tool_use — dropped',
        );
        continue;
      }
      const call = owner.toolCalls!.find((tc) => tc.toolCallId === resultBlock.tool_use_id)!;
      const result = toolResultBlockToRecord(resultBlock, call.toolName, ts);
      (owner.toolResults ??= []).push(result);
      // Close the matching call record (the entry is still unwritten, so this
      // is not a post-hoc mutation of persisted data).
      call.status = result.status;
      call.endedAt = ts;
    }

    this.flushCompletedToolSteps();
  }

  /**
   * Write buffered steps whose tool calls have ALL received results, from the
   * head of the queue (order-preserving). Steps still missing results stay
   * buffered — a later user message or the end-of-stream flush resolves them.
   */
  private flushCompletedToolSteps(): void {
    while (this._pendingToolSteps.length > 0) {
      const head = this._pendingToolSteps[0];
      const callIds = new Set(head.toolCalls?.map((tc) => tc.toolCallId) ?? []);
      const resultIds = new Set(head.toolResults?.map((tr) => tr.toolCallId) ?? []);
      let complete = true;
      for (const id of callIds) {
        if (!resultIds.has(id)) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
      this._pendingToolSteps.shift();
      head.endedAt = nowISO();
      this.appendConversationEntry(head);
    }
  }

  /**
   * End-of-stream fallback: write every still-buffered step so nothing is
   * lost. Tool calls that never received a result (abort, CLI death mid-tool)
   * are marked 'cancelled' instead of claiming to run forever.
   */
  protected flushAllToolSteps(): void {
    if (this._pendingToolSteps.length === 0) return;
    const ts = nowISO();
    for (const entry of this._pendingToolSteps) {
      const resultIds = new Set(entry.toolResults?.map((tr) => tr.toolCallId) ?? []);
      for (const tc of entry.toolCalls ?? []) {
        if (!resultIds.has(tc.toolCallId)) {
          tc.status = 'cancelled';
          if (tc.endedAt === undefined) tc.endedAt = ts;
        }
      }
      entry.endedAt = ts;
      this.appendConversationEntry(entry);
    }
    this._pendingToolSteps = [];
  }

  private handleResultMessage(msg: SDKResultSuccess | SDKResultError): void {
    // Cancel any pending progress — result supersedes it. The message queue
    // is NOT flushed here: leftover controller messages are reported by the
    // engine (message_undelivered) instead of vanishing silently.
    this.clearPendingProgress();

    if (msg.subtype === 'success') {
      this._terminalResult = {
        status: 'completed',
        summary: msg.result,
      };
    } else {
      this._terminalResult = {
        status: 'failed',
        error: msg.errors.join('\n') || `Claude Code error: ${msg.subtype}`,
      };
    }

    // Wake a prompt iterator that may be parked in `_messageResolve`. It
    // re-evaluates: a message that raced in before this result was processed
    // is still delivered as its own turn; otherwise the iterator returns
    // done, which makes SDK streamInput end and endInput() close the child's
    // stdin (issue #15 — without this wake the CLI waits for stdin EOF and
    // the stream never finishes).
    if (this._messageResolve) {
      const resolve = this._messageResolve;
      this._messageResolve = null;
      resolve();
    }

    // Record usage in runtime state
    const prev = this.state.get<Record<string, unknown>>('runtimeState');
    this.state.set('runtimeState', {
      ...prev,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        costUsd: msg.total_cost_usd,
        turns: msg.num_turns,
        durationMs: msg.duration_ms,
      },
    });

    this.logger.info(
      {
        subtype: msg.subtype,
        turns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
      },
      'ClaudeCodeWorker result',
    );
  }
}
