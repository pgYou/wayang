import { BaseAgent } from './base-agent';
import { ContextManager, COMPACT_MAX_RETRIES } from './context-manager';
import { ControllerAgentState } from '@/services/agents/controller-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { applyTurnEnvelope, syncStepTimestamps, type TurnEnvelope } from './utils/entry-envelope';
import { ToolCallRecorder, recordToolCalls } from './utils/tool-call-recorder';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { ControllerSignal, ProviderConfig, TaskDetail, WayangConfig, InputSignalPayload, CompletedSignalPayload, FailedSignalPayload, ProgressSignalPayload, HeartbeatSignalPayload, PermissionRequestSignalPayload, PreviousSessionTasksSignalPayload, CancelledSignalPayload, TaskCancelledSignalPayload, TaskQueuedSignalPayload, WorkerStartedSignalPayload, WorkerInquirySignalPayload, InquiryTimeoutSignalPayload, MessageUndeliveredSignalPayload, ContextUsage, ContextLastUsage } from '@/types/index';
import type { ConversationEntry, ConversationIndex, SignalEntry, TurnView } from '@/types/conversation';
import { EEntryType, ESignalSubtype, ESystemSubtype } from '@/types/index';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import type { Subscribable } from '@/infra/state/subscribable';
import { generateText } from 'ai';
import type { ToolSet } from 'ai';
import { buildSummaryInput } from './utils/summarizer-input';

import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerPrompt,
  buildControllerSystemPrompt,
} from './prompts/index';
import { createControllerTools } from '@/services/tools/index';
import { readWorkerTranscript, readWorkerTranscriptWindow } from '@/services/worker-transcript';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { SystemContext } from '@/infra/system-context';
import type { TaskExecuteEngine } from '@/services/task-execute-engine';
import type { SignalQueue } from '@/services/signal/signal-queue';

/**
 * Share of the context window (in characters) the summarizer input may use —
 * leaves room for the summarizer prompt and its output.
 */
const SUMMARIZER_INPUT_RATIO = 0.5;

export class ControllerAgent extends BaseAgent implements Subscribable {
  private readonly state: ControllerAgentState;
  private readonly contextManager: ContextManager;
  private readonly tools: ToolSet;
  private readonly logger: Logger;
  private readonly ctx: SystemContext;
  private readonly provider: ProviderConfig;
  /** Live tool execution records — merged into entries at step finish. */
  private readonly recorder: ToolCallRecorder;
  /** Turn id of the most recent run — used to stamp late error entries. */
  private lastTurnId: string | null = null;
  /**
   * True once THIS turn's interrupt record has been persisted
   * (recordUserAbort). Step finishes landing after that point would append
   * behind the interrupt marker — the turn is closed, drop them. Checked by
   * the onStep guard INSTEAD of the abort signal: the signal flips the moment
   * the user presses ESC, but a step that was already executing completes
   * normally afterwards (ai SDK enqueues finish-step only after the step's
   * tools ran to completion), so it still carries complete toolCalls +
   * toolResults and must be persisted (design §3.5) — dropping it would lose
   * the add_task toolCall/taskId link and make the interrupted turn look
   * cancelled while its workers are still running.
   */
  private turnInterruptRecorded = false;

  constructor(
    ctx: SystemContext,
    state: ControllerAgentState,
    provider: ProviderConfig,
    tools: ToolSet,
    skills: import('@/services/skills/registry').SkillRegistry,
    recorder: ToolCallRecorder = new ToolCallRecorder(),
  ) {
    super(provider);
    this.ctx = ctx;
    this.state = state;
    this.provider = provider;
    this.recorder = recorder;
    this.tools = recordToolCalls(tools, recorder);
    this.logger = ctx.logger;

    this.contextManager = new ContextManager(
      state,
      buildControllerSystemPrompt(this.ctx, skills),
      provider.contextWindowTokens,
    );
    this.setHooks({
      beforeLLM: ({ messages }) => {
        this.logger.debug({ messages }, 'LLM call start');
      },
      afterLLM: ({ step, usage, durationMs }) => {
        this.logger.info({ agent: 'controller', step, usage, durationMs }, 'LLM call done');
      },
    });

  }

  /**
   * Factory — create a ControllerAgent wired to the given services.
   *
   * The agent creates its own ControllerAgentState internally.
   */
  static create(opts: {
    ctx: SystemContext;
    provider: ProviderConfig;
    config: WayangConfig;
    engine: TaskExecuteEngine;
    signalQueue: SignalQueue;
    skills: import('@/services/skills/registry').SkillRegistry;
  }): ControllerAgent {
    const { ctx, provider, engine, signalQueue, skills } = opts;
    const state = new ControllerAgentState(ctx);
    // Recorder gets the logger so attachTask misses (no live tool-call
    // record) surface as debug logs instead of silent no-ops.
    const recorder = new ToolCallRecorder(ctx.logger);

    // Derive the read scope for controller file access. The wayang data dir
    // lives at <userHome>/.wayang, so its parent is the user's home — the home
    // the read policy anchors on (denylisting ~/.wayang inside it in turn).
    // Ad-hoc session dirs (hand-built temp dirs in tests) don't follow the
    // `<wayangDir>/sessions/<id>` layout, so fall back to the OS home rather
    // than guessing a parent.
    const wayangDir = wayangDirForSessionDir(ctx.sessionDir);
    const homeDir =
      wayangDir && basename(wayangDir) === '.wayang' ? dirname(wayangDir) : homedir();

    const tools = createControllerTools({
      addTask: (task: TaskDetail) => engine.add(task),
      validateWorkerType: (type: string) => engine.validateWorkerType(type),
      assignToWorker: (workerId: string, task: TaskDetail) => engine.assignToExistingWorker(workerId, task),
      validateIdleWorker: (workerId: string) => engine.validateIdleWorker(workerId),
      validateWorkerWorkspace: (workerId: string, workspacePath: string) => engine.validateWorkerWorkspace(workerId, workspacePath),
      listTasks: (status?: TaskDetail['status']) => engine.list(status),
      getTask: (taskId: string) => engine.get(taskId),
      getWorkerConversation: (taskId: string) => engine.getWorkerConversation(taskId),
      // On-disk transcript access (issue #16): survives worker disposal, so a
      // finished/cancelled worker's scene stays readable by the controller.
      readTranscript: (workerId: string) => readWorkerTranscript(ctx.sessionDir, workerId),
      // Layered transcript access (issue #16 review): while the engine tracks
      // the worker, its live in-memory conversation is the source; the on-disk
      // jsonl lives under the worker instance's OWN id (agent-/cw-…), which
      // the engine exposes and tasks persist as workerTranscriptId.
      getWorkerConversationByWorkerId: (workerId: string) => engine.getWorkerConversationByWorkerId(workerId),
      getWorkerTranscriptId: (workerId: string) => engine.getWorkerTranscriptId(workerId),
      readTranscriptWindow: (workerId: string, opts) => readWorkerTranscriptWindow(ctx.sessionDir, workerId, opts),
      sessionDir: ctx.sessionDir,
      getActiveWorkers: () => engine.getActiveWorkers(),
      getWorkerLiveStatus: (workerId: string) => engine.getWorkerLiveStatus(workerId),
      cancelTask: (taskId: string) => engine.cancel(taskId),
      abortWorker: (taskId: string) => engine.abortByTaskId(taskId),
      updateTask: (taskId, updates) => engine.updatePending(taskId, updates),
      queryMessages: (filter) => signalQueue.query(filter),
      cwd: ctx.workspaceDir,
      homeDir,
      getNotebook: () => state.get<string>('runtimeState.notebook') ?? '',
      setNotebook: (content, mode) => {
        const current = state.get<string>('runtimeState.notebook') ?? '';
        state.set('runtimeState.notebook', mode === 'append' ? (current ? current + '\n' + content : content) : content);
      },
      inquire: (question) => state.askInquiry(question),
      sendMessageToWorker: (workerId, message) => engine.sendMessageToWorker(workerId, message),
      resolvePermission: (requestId, approved, reason) => engine.resolvePermission(requestId, approved, reason),
      resolveInquiry: (inquiryId, answer) => engine.resolveInquiry(inquiryId, answer),
      registry: skills,
      disposeWorker: (workerId) => engine.abortByWorkerId(workerId),
      // Turn lineage for tasks created by add_task (read from dynamicState,
      // which run() sets at the start of every controller activation).
      getTurnContext: () => state.get<TurnEnvelope | null>('dynamicState.currentTurn') ?? undefined,
      // toolCall→task audit link, consumed when the step entry is built.
      onTaskDispatched: ({ toolCallId, taskId }) => {
        if (toolCallId) recorder.attachTask(toolCallId, taskId);
      },
      // Default workspace for tasks created by add_task; a declared workspace
      // is stamped instead and the engine executes the task there.
      workspaceDir: ctx.workspaceDir,
      wayangDir,
    });

    return new ControllerAgent(ctx, state, provider, tools, skills, recorder);
  }

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

  /** Restore persisted state (conversation, runtime). Called by Supervisor. */
  async restore(): Promise<void> {
    await this.state.restore();
    // Backfill the restored summary into the context manager so getMessages()
    // prepends it and the verbatim zone covers the sliced window.
    const summary = this.state.get<string>('compactSummary');
    if (summary) {
      this.contextManager.restoreCompact(summary);
    }
    // Seed the compaction check with the last real prompt size, so the cold
    // start check (supervisor) sees real usage instead of only the estimate.
    // Skipped when a compaction happened after that step — its usage
    // describes the pre-compaction prompt and would re-trigger compaction.
    const seeded = this.lastUsageSinceCompaction();
    if (seeded) this.contextManager.reportRealUsage(seeded.inputTokens);
    // Seed the status bar's context usage from the restored history.
    this.updateContextUsage(seeded ? { inputTokens: seeded.inputTokens } : undefined);
  }

  /**
   * Provider usage of the newest assistant step that comes after the last
   * compaction marker, if any.
   */
  private lastUsageSinceCompaction(): ContextLastUsage | undefined {
    const conversation = this.state.get<ConversationEntry[]>('conversation') ?? [];
    for (let i = conversation.length - 1; i >= 0; i--) {
      const entry = conversation[i]!;
      if (entry.type === EEntryType.System && entry.subtype === ESystemSubtype.Compact && entry.compactMeta) {
        return undefined;
      }
      if (entry.type !== EEntryType.Assistant) continue;
      const usage = this.toLastUsage(entry.message.usage);
      if (usage) return usage;
    }
    return undefined;
  }

  /**
   * Refresh dynamicState.contextUsage for the status bar.
   *
   * Prefers the real prompt size reported by the provider (inputTokens of the
   * step that just finished); falls back to the local estimate when usage is
   * unavailable. Ratio stays raw (not clamped to 1) so over-budget states
   * remain visible. dynamicState is never persisted.
   */
  private updateContextUsage(stepUsage?: { inputTokens?: number }): void {
    const contextWindowTokens = this.contextManager.getContextWindowTokens();
    const reported = stepUsage?.inputTokens;
    const hasReported = typeof reported === 'number' && Number.isFinite(reported) && reported > 0;
    if (hasReported) {
      // Feed the real prompt size to the context manager so compaction
      // triggers on real usage, not the (under)estimator.
      this.contextManager.reportRealUsage(reported);
    }
    const usedTokens = hasReported ? reported : this.contextManager.getEstimatedTokens();
    // Last provider usage: prefer the newest assistant entry in the conversation
    // (which already covers the step that just finished AND restore), falling
    // back to the step usage handed in when the entry has no usage yet.
    const lastUsage = this.findLastStepUsage() ?? this.toLastUsage(stepUsage);
    const usage: ContextUsage = {
      usedTokens,
      contextWindowTokens,
      ratio: contextWindowTokens > 0 ? usedTokens / contextWindowTokens : 0,
      source: hasReported ? 'usage' : 'estimate',
      breakdown: this.contextManager.getContextBreakdown(),
      ...(lastUsage && { lastUsage }),
    };
    this.state.set('dynamicState.contextUsage', usage);
  }

  /** Newest provider-reported usage in the conversation, if any. */
  private findLastStepUsage(): ContextLastUsage | undefined {
    const conversation = this.state.get<ConversationEntry[]>('conversation') ?? [];
    for (let i = conversation.length - 1; i >= 0; i--) {
      const entry = conversation[i]!;
      if (entry.type !== EEntryType.Assistant) continue;
      const usage = this.toLastUsage(entry.message.usage);
      if (usage) return usage;
    }
    return undefined;
  }

  /** Normalize a step usage payload, or undefined when the provider gave none. */
  private toLastUsage(usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  }): ContextLastUsage | undefined {
    if (!usage) return undefined;
    const { inputTokens, outputTokens, cachedInputTokens } = usage;
    if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) {
      return undefined;
    }
    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cachedInputTokens: cachedInputTokens ?? 0,
    };
  }

  /** Initialize session metadata. Called by Supervisor at start. */
  initSession(session: { id: string; startedAt: number }): void {
    this.state.set('runtimeState.session', session);
  }

  /** Resolve a pending inquiry with the user's answer. */
  resolveInquiry(answer: string): void {
    this.state.resolveInquiry(answer);
  }

  /** Surface an error in the UI as a system conversation entry. */
  reportError(message: string): void {
    this.state.set('dynamicState.streamingEntries', []);
    const errTs = nowISO();
    const entry: ConversationEntry = {
      type: EEntryType.System,
      uuid: generateId('err'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: errTs,
      subtype: ESystemSubtype.Error,
      content: `${message}\n详情: ${this.ctx.sessionDir}/wayang.log`,
      // Point-in-time event: startedAt/endedAt share the recording moment.
      startedAt: errTs,
      endedAt: errTs,
    };
    // Attach to the most recent turn so the error is grouped with the run that
    // failed (reportError fires from the controller loop's catch path).
    applyTurnEnvelope(entry, this.lastTurnId !== null
      ? { turnId: this.lastTurnId, actor: { kind: 'controller', id: this.id } }
      : undefined);
    this.state.append('conversation', entry);
  }

  /** Read-only turn index over the controller conversation. */
  getConversationIndex(): ConversationIndex {
    return this.state.getConversationIndex();
  }

  /** Look up one turn by id. */
  getTurn(turnId: string): TurnView | undefined {
    return this.state.getTurn(turnId);
  }

  // --- Subscribable ---

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.state.on(path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.state.get(path);
  }

  /** Check if context needs compaction. */
  needsCompaction(): boolean {
    return this.contextManager.isFull();
  }

  /**
   * Run compaction — uses the LLM to summarize conversation entries.
   *
   * Retries up to COMPACT_MAX_RETRIES times on failure.
   * Falls back to truncating half of the history in memory (file preserved).
   */
  async performCompaction(): Promise<void> {
    try {
      // Capture the previous summary before compact() replaces it — the
      // summarizer folds it in so repeated compactions stay incremental.
      const previousSummary = this.contextManager.getCompactSummary();
      const entryCount = this.state.get<ConversationEntry[]>('conversation').length;

      await this.contextManager.compact(
        async (entries) => {
          // Budget the summarizer input in characters against the model
          // window: CJK text runs close to one token per character, so a
          // character budget never underestimates the request size.
          const budget = Math.floor(this.contextManager.getContextWindowTokens() * SUMMARIZER_INPUT_RATIO)
            - (previousSummary?.length ?? 0);
          const entryTexts = buildSummaryInput(entries, Math.max(budget, 0));
          if (previousSummary) {
            entryTexts.unshift(`[Previous Summary]\n${previousSummary}`);
          }

          let lastError: unknown;
          for (let attempt = 0; attempt <= COMPACT_MAX_RETRIES; attempt++) {
            try {
              const { text } = await generateText({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WayangModel (custom provider wrapper) deliberately crossing into the SDK's LanguageModel type here; opaque boundary
                model: this.model as any,
                system: SUMMARIZER_SYSTEM_PROMPT,
                prompt: buildSummarizerPrompt(entryTexts),
              });
              return text;
            } catch (err) {
              lastError = err;
              this.logger.warn({ attempt: attempt + 1, error: String(err) }, 'Compaction summarizer failed');
            }
          }
          throw lastError;
        },
        { model: this.provider.modelName },
      );
      this.logger.info(
        { model: this.provider.modelName, summarizedEntries: entryCount },
        'Compaction done',
      );
    } catch (err) {
      // All retries failed — fallback: truncate half of history in memory only.
      // Truncation goes through the context manager so its verbatim-zone index
      // and real-usage mark stay consistent with the shortened array.
      this.logger.warn({ error: String(err) }, 'Compaction failed, falling back to half-truncation');
      const total = this.state.get<ConversationEntry[]>('conversation').length;
      if (total > 4) {
        const half = Math.floor(total / 2);
        this.contextManager.truncateHistory(half);
        this.logger.info({ kept: half, total }, 'History truncated (half) as compaction fallback');
      }
    }
    // Refresh the status bar / `/context` right away instead of waiting for
    // the next LLM step to report usage.
    this.updateContextUsage();
  }
}

// ---------------------------------------------------------------------------
// Signal → ConversationEntry converters
// ---------------------------------------------------------------------------

/** Common fields for all SignalEntry variants. */
function signalBase(ts: string, sessionId: string): Omit<SignalEntry, 'subtype' | 'content' | 'taskTitle'> {
  return {
    type: EEntryType.Signal,
    uuid: generateId('sig'),
    parentUuid: null,
    sessionId,
    timestamp: ts,
  };
}

/** ISO string from a signal's epoch-ms timestamp. */
function isoMs(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * One-line activity tail for worker-produced signals (issue #16).
 * `lastActivityAt` is an epoch-ms stamp; null/undefined means "no entries yet".
 */
function signalActivityTail(currentTool?: string | null, lastActivityAt?: number | null): string | null {
  const parts: string[] = [];
  if (currentTool) parts.push(`tool=${currentTool}`);
  if (typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt)) {
    // Second precision keeps the tail short in the transcript/UI.
    parts.push(`lastEntry=${new Date(lastActivityAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  }
  return parts.length > 0 ? `[activity: ${parts.join(', ')}]` : null;
}

type SignalConverter = (sig: ControllerSignal, ts: string, sessionId: string) => ConversationEntry;

const signalConverters: Record<string, SignalConverter> = {
  input: (sig, ts, sessionId) => ({
    type: EEntryType.User,
    uuid: generateId('u'),
    parentUuid: null,
    sessionId,
    timestamp: ts,
    actor: { kind: 'user', id: 'user' },
    startedAt: isoMs(sig.timestamp),
    // Delivery/processing of the input is complete when it is recorded here.
    endedAt: ts,
    message: { role: 'user' as const, content: (sig.payload as InputSignalPayload).text },
  }),

  completed: (sig, ts, sessionId) => {
    const p = sig.payload as CompletedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerCompleted,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.summary ?? JSON.stringify(sig.payload),
    };
  },

  failed: (sig, ts, sessionId) => {
    const p = sig.payload as FailedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerFailed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.error,
    };
  },

  progress: (sig, ts, sessionId) => {
    const p = sig.payload as ProgressSignalPayload;
    // Activity tail (issue #16): the controller can judge "still moving" from
    // the signal itself, without an extra get_worker_status call.
    const activity = signalActivityTail(p.currentTool, p.lastActivityAt);
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerProgress,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: activity ? `${p.message}\n${activity}` : p.message,
    };
  },

  heartbeat: (sig, ts, sessionId) => {
    const p = sig.payload as HeartbeatSignalPayload;
    const workerSummary = p.workers
      .map((w) => {
        const tool = w.currentTool ? `, tool ${w.currentTool}` : '';
        const idle = w.lastActivityAgoMs !== null && w.lastActivityAgoMs !== undefined
          ? `, last activity ${Math.round(w.lastActivityAgoMs / 1000)}s ago`
          : '';
        return `${w.taskTitle} [${w.workerId}] (${w.workerType}, running ${Math.round(w.runningForMs / 1000)}s${tool}${idle})`;
      })
      .join(', ');
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.Heartbeat,
      taskTitle: 'heartbeat',
      content: `[HEARTBEAT] ${p.reason}\nIdle: ${Math.round(p.idleSinceMs / 1000)}s\nWorkers: ${workerSummary}\nPending tasks: ${p.pendingTaskCount}`,
    };
  },

  permission_request: (sig, ts, sessionId) => {
    const p = sig.payload as PermissionRequestSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.PermissionRequest,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[PERMISSION REQUEST] The worker running task "${p.taskTitle}" wants to run ${p.toolName}.\nDescription: ${p.description}\nRequest ID: ${p.requestId}\nUse respond_permission to approve or deny.`,
      // Structured copy for per-tool summary rendering (content stays as the
      // LLM-facing flattened text — do not remove).
      permissionMeta: {
        requestId: p.requestId,
        toolName: p.toolName,
        toolArgs: p.toolArgs,
        description: p.description,
      },
    };
  },

  worker_inquiry: (sig, ts, sessionId) => {
    const p = sig.payload as WorkerInquirySignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerInquiry,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[WORKER INQUIRY] The worker running task "${p.taskTitle}" is blocked and asks:${'\n'}${p.question}` +
        `${p.context ? `\nContext: ${p.context}` : ''}\nInquiry ID: ${p.inquiryId}\nUse respond_inquiry to answer; the worker is waiting and will continue on its own after a 5-minute timeout.`,
      inquiryMeta: {
        inquiryId: p.inquiryId,
        question: p.question,
        ...(p.context !== undefined && { context: p.context }),
      },
    };
  },

  inquiry_timeout: (sig, ts, sessionId) => {
    const p = sig.payload as InquiryTimeoutSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.InquiryTimeout,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[INQUIRY TIMEOUT] The worker running task "${p.taskTitle}" got no answer within 5 minutes and continued on its own judgment. Question was: ${p.question}`,
    };
  },

  message_undelivered: (sig, ts, sessionId) => {
    const p = sig.payload as MessageUndeliveredSignalPayload;
    const lines = p.messages.map(m => `- ${m}`);
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.MessageUndelivered,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle ?? 'message_undelivered',
      content: `[MESSAGES NOT DELIVERED] The worker ${p.reason === 'worker_disposed' ? 'was disposed (idle)' : 'finished its task'} before reading your message(s):${'\n'}${lines.join('\n')}\nThey were never seen by the worker. If still relevant, re-dispatch as a follow-up task.`,
    };
  },

  cancelled: (sig, ts, sessionId) => {
    const p = sig.payload as CancelledSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerDisposed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: 'worker_disposed',
      content: `[WORKER DISPOSED] An idle (multi-stage) worker was disposed (reaped by timeout or manually). No task failed — its last stage already completed. If you still need this worker's context, create a fresh multi-stage task instead.`,
    };
  },

  task_cancelled: (sig, ts, sessionId) => {
    const p = sig.payload as TaskCancelledSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.TaskCancelled,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle ?? 'task_cancelled',
      content: `[TASK CANCELLED] Task ${p.taskId}${p.taskTitle ? ` (${p.taskTitle})` : ''} was cancelled by the user/controller. This is not a failure — the task terminated as cancelled.`,
    };
  },

  task_queued: (sig, ts, sessionId) => {
    const p = sig.payload as TaskQueuedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.TaskQueued,
      workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[TASK QUEUED] ${p.message}`,
    };
  },

  worker_started: (sig, ts, sessionId) => {
    const p = sig.payload as WorkerStartedSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerStarted,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: `[WORKER STARTED${p.reused ? ' (reused idle worker)' : ''}] ${p.message}`,
    };
  },

  previous_session_tasks: (sig, ts, sessionId) => {
    const p = sig.payload as PreviousSessionTasksSignalPayload;
    const lines = p.tasks.map(t => `- [${t.status}] ${t.title} (id: ${t.taskId}): ${t.description}`);
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.PreviousSessionTasks,
      taskTitle: 'previous_session_tasks',
      content: `[PREVIOUS SESSION] ${p.tasks.length} unfinished task(s) from session ${p.sessionId} (last active ${new Date(p.lastActiveAt).toLocaleString()}):\n${lines.join('\n')}\nWorkers were NOT resumed. Decide: re-dispatch with add_task, treat as stale, or ask the user.`,
    };
  },
};

/** Convert a ControllerSignal to a ConversationEntry. */
function signalToEntry(sig: ControllerSignal, ts: string, sessionId: string): ConversationEntry {
  const converter = signalConverters[sig.type];
  let entry: ConversationEntry;
  if (converter) {
    entry = converter(sig, ts, sessionId);
  } else {
    // Fallback for unknown/cancelled signals
    const p = sig.payload as FailedSignalPayload;
    entry = {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerFailed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle ?? sig.type,
      content: JSON.stringify(sig.payload),
    } as SignalEntry;
  }

  // Stamp signal lineage onto SignalEntry records: the originating worker's
  // chain (rootTurnId / causationId) plus the queue id. turnId is NOT copied —
  // the entry joins the controller turn that consumes the signal (set by
  // applyTurnEnvelope at the call site); the worker's own turn lives in the
  // worker's conversation file. endedAt marks the delivery moment: the signal
  // was consumed and recorded by this controller run.
  if (entry.type === EEntryType.Signal) {
    const s = entry as SignalEntry;
    s.signalId = sig.id;
    if (sig.rootTurnId !== undefined) s.rootTurnId = sig.rootTurnId;
    if (sig.causationId !== undefined) s.causationId = sig.causationId;
    s.startedAt = isoMs(sig.timestamp);
    s.endedAt = ts;
    const payload = sig.payload as unknown as Record<string, unknown>;
    if (sig.source === 'worker' && typeof payload.workerId === 'string') {
      s.actor = {
        kind: 'worker',
        id: payload.workerId,
        ...(typeof payload.taskId === 'string' && { taskId: payload.taskId }),
      };
    } else if (sig.source === 'system') {
      s.actor = { kind: 'system', id: 'system' };
    }
  }
  return entry;
}
