// ControllerTurnRun: the turn execution loop — run()/_run() (turn identity,
// signal ingestion, the streaming loop and its onStep persistence), the
// user-interrupt record and the streaming entry placeholder. Extends
// ControllerAgentBase.

import { ControllerAgentBase } from './agent-base';
import { buildAssistantEntry } from '../utils/build-assistant-entry';
import { applyTurnEnvelope, syncStepTimestamps, type TurnEnvelope } from '../utils/entry-envelope';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { ControllerSignal } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { signalToEntry } from '../utils/signal-to-entry';

export class ControllerTurnRun extends ControllerAgentBase {
  /** Run the controller agent — streams text chunks while updating streamingEntries in state. */
  async run(signals: ControllerSignal[]): Promise<{ text: string }> {
    // Fresh abort channel per turn: an abort (ESC / RPC) applies to
    // THIS run only. Without the reset, the agent-lifetime controller stays
    // aborted forever and every later turn would silently return empty.
    this.resetAbortController();
    this.state.set('dynamicState.busy', true);
    try {
      return await this._run(signals);
    } finally {
      this.state.set('dynamicState.busy', false);
    }
  }

  private async _run(signals: ControllerSignal[]): Promise<{ text: string }> {
    const ts = nowISO();

    // --- Turn identity: one controller activation = one turn ---
    // User input starts a new chain (rootTurnId = this turn); a signal-triggered
    // run inherits the signal's rootTurnId (the user turn that started the
    // chain) and records the triggering signal as its cause.
    const turnId = generateId('turn');
    const hasUserInput = signals.some(s => s.type === 'input');
    const rootTurnId = hasUserInput
      ? turnId
      : signals.find(s => s.rootTurnId !== undefined)?.rootTurnId;
    const causationId = signals[0]?.id;
    const turnEnv: TurnEnvelope = {
      turnId,
      ...(rootTurnId !== undefined && { rootTurnId }),
      ...(causationId !== undefined && { causationId }),
      actor: { kind: 'controller', id: this.id },
      // Controller entries carry the process workspace's slug so they are
      // attributable to a directory just like worker entries. Undefined only
      // when the context carries no workspace directory.
      ...(this.workspaceSlug !== undefined && { workspaceSlug: this.workspaceSlug }),
    };
    this.state.set('dynamicState.currentTurn', turnEnv);
    this.lastTurnId = turnId;
    this.recorder.beginTurn();
    this.turnInterruptRecorded = false;

    // Append incoming signals to conversation. Signal entries keep their own
    // lineage (rootTurnId / causationId / actor from the originating worker)
    // and join the consuming turn via turnId.
    for (const sig of signals) {
      const entry = signalToEntry(sig, ts, this.ctx.sessionId);
      applyTurnEnvelope(entry, turnEnv);
      this.state.append('conversation', entry);
    }

    // Clear stale streaming entries from previous run
    this.state.set('dynamicState.streamingEntries', []);

    // Build a mutable streaming entry to accumulate text chunks
    let streamingEntry = this.createStreamingEntry();

    const gen = this.streamLoop({
      system: this.contextManager.getSystemPrompt(),
      messages: this.contextManager.getMessages(),
      tools: this.tools,
      maxSteps: 50,
      stopTools: ['skip_reply'],
      onStreamError: (err) => {
        // An aborted turn reports AbortError through onError — expected user
        // action, not a provider failure. Keep it out of the error log.
        if (this.abortController.signal.aborted) {
          this.logger.debug({ agent: 'controller', err }, 'LLM stream aborted by user');
          return;
        }
        this.logger.error({ agent: 'controller', err }, 'LLM stream error');
      },
      onStep: (event, meta) => {
        // A late step-finish that lands after this turn's interrupt record
        // was persisted would append a complete step BEHIND the interrupt
        // marker — the turn is over, drop it. Steps landing between the abort
        // and that record are complete (their tools ran to finish) and are
        // persisted below; recordUserAbort's uuid dedup guard reconciles them
        // with any in-flight partial text.
        if (this.turnInterruptRecorded) return;
        const streamingEntries = this.state.get<ConversationEntry[]>('dynamicState.streamingEntries');
        const streamingUuid = streamingEntries?.[0]?.uuid;
        const entry = buildAssistantEntry(event, this.ctx.sessionId, streamingUuid, {
          startedAt: meta?.startedAt,
          firstTokenAt: meta?.firstTokenAt,
          temperature: this.provider.temperature,
          maxOutputTokens: this.provider.maxOutputTokens,
          recordedToolCalls: (toolCallId) => this.recorder.lookup(toolCallId),
        });
        applyTurnEnvelope(entry, turnEnv);
        syncStepTimestamps(entry);
        this.state.append('conversation', entry);
        // Clear streaming for this step; next chunk will start a fresh entry
        this.state.set('dynamicState.streamingEntries', []);
        // Refresh the status bar's context usage from this step's real usage
        this.updateContextUsage({ inputTokens: event.usage?.inputTokens });
      },
    });

    let fullText = '';
    for await (const chunk of gen) {
      if (chunk) {
        // When streamingEntries was cleared by onStep, start a fresh streaming entry
        const current = this.state.get<ConversationEntry[]>('dynamicState.streamingEntries');
        if (!current || current.length === 0) {
          streamingEntry = this.createStreamingEntry();
        }
        streamingEntry.message.content += chunk;
        fullText += chunk;
        this.state.set('dynamicState.streamingEntries', [streamingEntry]);
      }
    }

    // streamLoop returns cleanly on abort (base-agent catch checks the agent
    // signal), so an aborted turn lands here: record the interrupt before the
    // run unwinds.
    if (this.abortController.signal.aborted) {
      this.recordUserAbort(turnEnv);
    }

    // Don't clear streamingEntries here — let the next run clear them
    // to avoid a blank frame between streaming disappearing and conversation appearing
    return { text: fullText };
  }

  /**
   * Persist a user interrupt (ESC while busy) of the current turn:
   *  - the in-flight partial text, if any, becomes a truncated assistant
   *    entry (`interrupted: true`). Empty/whitespace partials are dropped —
   *    an empty assistant message risks provider rejection on replay and
   *    carries no information;
   *  - an `interrupted` system marker is always appended (the zero-output
   *    case leaves only this marker), replayed to the next turn as an
   *    explicit [USER INTERRUPT] system message;
   *  - streaming entries are cleared so the live region stops rendering.
   *
   * Dedup guard: a partial whose uuid is already in the conversation was
   * recorded by onStep (abort landed just after step finish) — never append
   * it twice.
   */
  private recordUserAbort(turnEnv: TurnEnvelope): void {
    // From here the turn is closed: any step finish racing in after this
    // point would land behind the interrupt marker and is dropped by the
    // onStep guard. Set BEFORE the appends so nothing interleaves.
    this.turnInterruptRecorded = true;
    const ts = nowISO();
    const streaming = this.state.get<ConversationEntry[]>('dynamicState.streamingEntries') ?? [];
    const inFlight = streaming[0];
    const partialText = inFlight?.type === EEntryType.Assistant ? inFlight.message.content : '';
    const recordedUuids = new Set(
      (this.state.get<ConversationEntry[]>('conversation') ?? []).map(e => e.uuid),
    );

    if (inFlight && inFlight.type === EEntryType.Assistant && partialText.trim() && !recordedUuids.has(inFlight.uuid)) {
      const truncated: ConversationEntry = {
        ...inFlight,
        interrupted: true,
        timing: { startedAt: inFlight.timestamp, endedAt: ts },
        startedAt: inFlight.timestamp,
        endedAt: ts,
      };
      applyTurnEnvelope(truncated, turnEnv);
      this.state.append('conversation', truncated);
    }

    const marker: ConversationEntry = {
      type: EEntryType.System,
      uuid: generateId('sys-abort'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: ts,
      subtype: ESystemSubtype.Interrupted,
      content: 'Response interrupted by user.',
      startedAt: ts,
      endedAt: ts,
      actor: { kind: 'user', id: 'user' },
    };
    applyTurnEnvelope(marker, turnEnv);
    this.state.append('conversation', marker);

    this.state.set('dynamicState.streamingEntries', []);
  }

  /** Create a fresh streaming entry placeholder. */
  private createStreamingEntry() {
    return {
      type: EEntryType.Assistant as const,
      uuid: generateId('s'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: nowISO(),
      message: { role: 'assistant' as const, content: '' },
    };
  }
}
