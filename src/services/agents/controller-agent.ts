import { BaseAgent } from './base-agent';
import { ContextManager, COMPACT_MAX_RETRIES } from './context-manager';
import { ControllerAgentState } from '@/services/agents/controller-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { applyTurnEnvelope, syncStepTimestamps, type TurnEnvelope } from './utils/entry-envelope';
import { ToolCallRecorder, recordToolCalls } from './utils/tool-call-recorder';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { ControllerSignal, ProviderConfig, TaskDetail, WayangConfig, InputSignalPayload, CompletedSignalPayload, FailedSignalPayload, ProgressSignalPayload, HeartbeatSignalPayload, PermissionRequestSignalPayload, PreviousSessionTasksSignalPayload, CancelledSignalPayload, TaskCancelledSignalPayload, ContextUsage, ContextLastUsage } from '@/types/index';
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
    const { ctx, provider, config, engine, signalQueue, skills } = opts;
    const state = new ControllerAgentState(ctx);
    // Recorder gets the logger so attachTask misses (no live tool-call
    // record) surface as debug logs instead of silent no-ops.
    const recorder = new ToolCallRecorder(ctx.logger);

    const tools = createControllerTools({
      addTask: (task: TaskDetail) => engine.add(task),
      validateWorkerType: (type: string) => engine.validateWorkerType(type),
      assignToWorker: (workerId: string, task: TaskDetail) => engine.assignToExistingWorker(workerId, task),
      validateIdleWorker: (workerId: string) => engine.validateIdleWorker(workerId),
      listTasks: (status?: TaskDetail['status']) => engine.list(status),
      getTask: (taskId: string) => engine.get(taskId),
      getWorkerConversation: (taskId: string) => engine.getWorkerConversation(taskId),
      cancelTask: (taskId: string) => engine.cancel(taskId),
      abortWorker: (taskId: string) => engine.abortByTaskId(taskId),
      updateTask: (taskId, updates) => engine.updatePending(taskId, updates),
      queryMessages: (filter) => signalQueue.query(filter),
      cwd: ctx.workspaceDir,
      getNotebook: () => state.get<string>('runtimeState.notebook') ?? '',
      setNotebook: (content, mode) => {
        const current = state.get<string>('runtimeState.notebook') ?? '';
        state.set('runtimeState.notebook', mode === 'append' ? (current ? current + '\n' + content : content) : content);
      },
      inquire: (question) => state.askInquiry(question),
      sendMessageToWorker: (workerId, message) => engine.sendMessageToWorker(workerId, message),
      resolvePermission: (requestId, approved, reason) => engine.resolvePermission(requestId, approved, reason),
      registry: skills,
      disposeWorker: (workerId) => engine.abortByWorkerId(workerId),
      // Turn lineage for tasks created by add_task (read from dynamicState,
      // which run() sets at the start of every controller activation).
      getTurnContext: () => state.get<TurnEnvelope | null>('dynamicState.currentTurn') ?? undefined,
      // toolCall→task audit link, consumed when the step entry is built.
      onTaskDispatched: ({ toolCallId, taskId }) => {
        if (toolCallId) recorder.attachTask(toolCallId, taskId);
      },
    });

    return new ControllerAgent(ctx, state, provider, tools, skills, recorder);
  }

  /** Run the controller agent — streams text chunks while updating streamingEntries in state. */
  async run(signals: ControllerSignal[]): Promise<{ text: string }> {
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
        this.logger.error({ agent: 'controller', err }, 'LLM stream error');
      },
      onStep: (event, meta) => {
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

    // Don't clear streamingEntries here — let the next run clear them
    // to avoid a blank frame between streaming disappearing and conversation appearing
    return { text: fullText };
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
      content: message,
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
                model: this.model as any, // WayangModel opaque boundary
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
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerProgress,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.message,
    };
  },

  heartbeat: (sig, ts, sessionId) => {
    const p = sig.payload as HeartbeatSignalPayload;
    const workerSummary = p.workers
      .map((w) => `${w.taskTitle} (${w.workerType}, running ${Math.round(w.runningForMs / 1000)}s)`)
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
      content: `[PERMISSION REQUEST] Worker ${p.workerId} (task: ${p.taskTitle}) wants to run ${p.toolName}.\nDescription: ${p.description}\nRequest ID: ${p.requestId}\nUse respond_permission to approve or deny.`,
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

  cancelled: (sig, ts, sessionId) => {
    const p = sig.payload as CancelledSignalPayload;
    return {
      ...signalBase(ts, sessionId),
      subtype: ESignalSubtype.WorkerDisposed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: 'worker_disposed',
      content: `[WORKER DISPOSED] Idle (multi-stage) worker ${p.workerId} was disposed (reaped by timeout or manually). No task failed — its last stage already completed. If you still need this worker's context, create a fresh multi-stage task instead.`,
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
