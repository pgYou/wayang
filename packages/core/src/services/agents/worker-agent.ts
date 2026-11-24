import { BaseAgent } from './base-agent';
import { ContextManager } from './context-manager';
import { compactContext, truncateHistoryHalf, MAX_COMPACTIONS_PER_RUN } from './context/compaction';
import { WorkerState, type InboxMessage } from './worker-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { applyTurnEnvelope, syncStepTimestamps, type TurnEnvelope } from './utils/entry-envelope';
import { ToolCallRecorder, recordToolCalls } from './utils/tool-call-recorder';
import { controllerMessageContent, createInboxInjection } from './utils/inbox-injection';
import { generateId } from '../../utils/id';
import { nowISO } from '../../utils/time';
import type { WorkerResult, TaskDetail, ToolChoice, WorkerLiveStatus, ContextUsage, ContextLastUsage } from '@wayang-ai/protocol';
import type { ResolvedModel } from '../config/model-resolution';
import type { IWorkerInstance } from './worker-instance';
import type { ConversationEntry } from '@wayang-ai/protocol/types/conversation';
import { EEntryType } from '@wayang-ai/protocol';
import type { Logger } from '../../infra/logger';
import type { StateEvent } from '../../infra/state/base-state';
import type { ModelMessage, PrepareStepFunction, ToolSet } from 'ai';
import { resolveMaxTurns } from './max-turns';
import { checkControllerMessagesTool } from '../tools/check-messages';

import { buildWorkerSystemPrompt } from './prompts/index';
import { SystemContext } from '../../infra/system-context';
import type { SkillRegistry } from '../skills/registry';
import { resolveWorkspaceRef } from '../../infra/workspace-registry';
import type { WorkspaceRef } from '../../infra/workspace-registry';

/**
 * Request-only turn seeded after a compaction leaves nothing verbatim: the
 * provider rejects an empty messages array, and the model still needs a turn
 * to answer. It is never written to the conversation. The wording names the
 * summary's location and tells the model to re-inspect state instead of
 * re-running finished work from memory — the verbatim zone may be empty, so
 * "don't repeat" alone would leave the model guessing what is already done.
 *
 * Kept identical to COMPACTION_CONTINUATION in conversation-to-sdk-messages.ts;
 * change both together.
 */
const COMPACTION_CONTINUATION =
  '[Conversation compacted] The context has just been compacted: the summary of completed work is the user message that begins with [Conversation Summary]. '
  + 'If that summary is not enough to continue safely, re-inspect the necessary state first — '
  + 'do not re-run an operation that already succeeded just because you do not remember its result.';

export class WorkerAgent extends BaseAgent implements IWorkerInstance {
  private readonly state: WorkerState;
  private readonly logger: Logger;
  private _terminalResult: WorkerResult | null = null;
  /** Workspace this worker executes in — fixed at construction (IWorkerInstance). */
  readonly workspaceDir: string;
  private readonly toolChoice: ToolChoice | undefined;
  private contextManager: ContextManager;
  private readonly ctx: SystemContext;
  /** Live tool execution records — merged into entries at step finish. */
  private readonly recorder = new ToolCallRecorder();
  /**
   * Registry identity of the workspace this worker executes in. Reused for the
   * `workspaceSlug` stamped on turn envelopes, so a conversation entry is
   * attributable to a directory even when the task carried no explicit
   * workspace stamp.
   */
  private readonly workspaceRef?: WorkspaceRef;
  /**
   * Summarizing compactions performed in the current run (issue #90). Capped
   * at MAX_COMPACTIONS_PER_RUN: past the limit a full context degrades to
   * truncation only, so a context that refills after every compaction cannot
   * keep the worker in a summarize loop.
   */
  private compactionsThisRun = 0;
  /**
   * True once THIS run compacted or truncated its context. From that point on
   * every later step sends the messages rebuilt from the conversation — the
   * SDK's own message list still holds the pre-compaction history and would
   * silently undo the compaction. Reset per run; a compaction carried over
   * from an earlier stage is already baked into the run's initial messages.
   */
  private contextOverriddenThisRun = false;
  /**
   * Description of the task the CURRENT run executes (#90). The task prompt
   * is appended as a user entry in run(); a compaction between two steps
   * summarizes everything before its marker, including that entry. To keep the
   * model aware of what it is doing, the description is excluded from the
   * summarizer input and re-injected into every rebuilt post-compaction
   * request (see rebuiltStep()). Reset per run.
   */
  private currentTaskDescription?: string;
  /** uuid of the current run's task-description entry (excluded from summaries). */
  private currentTaskEntryUuid?: string;

  constructor(
    model: ResolvedModel,
    ctx: SystemContext,
    skills: SkillRegistry,
    /** Tool-choice mode (worker.toolChoice in config). Falls back to 'auto' —
     *  thinking endpoints (DeepSeek/GLM) reject `tool_choice: "required"` with
     *  HTTP 400, so the safe default lets the model decide; the system prompt
     *  still instructs workers to finish via done/fail. */
    toolChoice?: ToolChoice,
    /** Workspace the worker's task executes in — `task.workspace.path` as
     *  resolved by the engine (canonical). Falls back to `ctx.workspaceDir`
     *  for callers without a task context (legacy tasks, direct construction). */
    workspaceDir?: string,
  ) {
    super(model);
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.workspaceDir = workspaceDir ?? ctx.workspaceDir;
    this.toolChoice = toolChoice;
    // Workspace identity is stamped into runtime-state so a worker's records
    // stay attributable after it finished (registry slug keeps it stable). The
    // same ref feeds the turn envelope's `workspaceSlug`.
    this.workspaceRef = resolveWorkspaceRef(ctx.storagePaths.dataDir, this.workspaceDir);
    this.state = new WorkerState(
      ctx.sessionDir,
      this.id,
      ctx.logger,
      this.workspaceRef,
    );
    // The model's context window drives worker-side compaction (issue #90):
    // ContextManager compares it against the real per-step usage and the
    // local estimate. The prompt is built for THIS worker's workspace, not
    // the process workspace: project rules (AGENTS.md) and the Environment
    // section must describe the directory the worker's tools actually run in.
    this.contextManager = new ContextManager(
      this.state,
      buildWorkerSystemPrompt(this.ctx, skills, this.workspaceDir),
      model.contextWindowTokens,
    );
  }

  /**
   * Execute a task.
   *
   * Multi-stage safe: this method may be called more than once on the same
   * instance (via the engine's assignToExistingWorker path). Each call resets
   * the terminal result and appends the new task description as a user message,
   * so the worker's accumulated conversation carries forward across stages.
   */
  async run(
    task: TaskDetail & { workerId: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- implements IWorkerInstance.run's tools param; heterogeneous zod-inferred tool set (see common.ts)
    tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult> {
    // Digest only (issue #52 hygiene): the full TaskDetail carries absolute
    // paths (workspace.path, taskAllowedDirs) and result/error text that must
    // not land in the log file. Path identity goes out as the registry slug.
    this.logger.debug(
      {
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        multiStage: task.multiStage ?? false,
        ...(task.workspace && { workspace: task.workspace.slug }),
      },
      'WorkerAgent run called',
    );
    // Set task info in state
    this.state.set('runtimeState.task', { id: task.id, description: task.description });

    // Reset terminal result for this run
    this._terminalResult = null;
    // Per-run compaction bookkeeping: a new run starts with a fresh budget and
    // no step override (a compaction from an earlier stage already lives in
    // this run's initial messages).
    this.compactionsThisRun = 0;
    this.contextOverriddenThisRun = false;
    // The current task description is re-injected after a compaction, so it
    // must be tracked per run (a multi-stage worker runs several tasks).
    this.currentTaskDescription = task.description;
    this.currentTaskEntryUuid = generateId('u');

    // --- Turn identity: one worker run = one turn ---
    // The engine passes the task's execution turn id; rootTurnId is inherited
    // from the task (tracing back to the user turn that created it) and the
    // task itself is the direct cause of this activation.
    // `workspaceSlug` attributes every entry of this run to the directory the
    // task executes in: the task's own stamp (add_task resolves it through the
    // registry) when present, else the slug of the directory this worker was
    // built for. It is always available here, so worker entries never leave it
    // undefined.
    const workspaceSlug = task.workspace?.slug ?? this.workspaceRef?.slug;
    const turnEnv: TurnEnvelope = {
      turnId: task.executionTurnId ?? generateId('turn'),
      ...((task.rootTurnId ?? task.turnId) !== undefined && { rootTurnId: task.rootTurnId ?? task.turnId }),
      causationId: task.id,
      actor: { kind: 'worker', id: task.workerId, taskId: task.id },
      ...(workspaceSlug !== undefined && { workspaceSlug }),
    };
    this.recorder.beginTurn();

    // Add task description as initial user message. The task prompt is written
    // by the orchestration engine, not the human user — actor reflects that.
    const promptTs = nowISO();
    this.state.append('conversation', applyTurnEnvelope({
      type: EEntryType.User,
      uuid: this.currentTaskEntryUuid,
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: promptTs,
      actor: { kind: 'system', id: 'engine', taskId: task.id },
      // Delivery of the task prompt completes at write time.
      endedAt: promptTs,
      message: { role: 'user', content: task.description },
    } satisfies ConversationEntry, turnEnv));

    // Multi-stage opening: unread controller messages parked in the inbox
    // during a previous stage are written into the conversation now —
    // getMessages() below rebuilds from it, so they reach the model at once.
    for (const m of this.drainInbox()) {
      this.appendControllerMessageEntry(m.content, turnEnv);
    }

    // Publish the opening context snapshot (estimate) so the usage state is
    // never null while the task runs; every step refreshes it with real usage.
    this.updateContextUsage();

    // Controller-message injection (see utils/inbox-injection): before each
    // LLM step, newly arrived inbox messages become `[Controller message]`
    // user messages AND conversation entries (the entry makes them survive
    // context rebuilds and future stages). The hook re-merges everything
    // injected so far into each later step's request AT ITS ARRIVAL POSITION
    // — right before the assistant reply of the step the message arrived in —
    // so instructions stay in context exactly once, never as a tail duplicate.
    const injection = createInboxInjection({
      drainInbox: () => this.drainInbox(),
      onInject: (content) => this.appendControllerMessageEntry(content, turnEnv),
    });

    // Add internal tools for controller communication; wrap everything with
    // the recorder so per-call status/timing lands on the step entries.
    const allTools = recordToolCalls({
      ...tools,
      // Deprecated stub — messages arrive via prepareStep injection now.
      check_controller_messages: checkControllerMessagesTool(),
    }, this.recorder);

    // Turn cap: config `worker.maxTurns`, unset or invalid = unlimited
    // (resolveMaxTurns warns once on invalid values). Infinity is folded to
    // undefined so no never-matching step condition is armed at all.
    const maxTurns = resolveMaxTurns(this.ctx.config.worker?.maxTurns, this.logger, 'worker.maxTurns');

    // streamLoop handles abort internally — collectLoop returns cleanly
    const result = await this.collectLoop({
      system: this.contextManager.getSystemPrompt(),
      messages: this.contextManager.getMessages(),
      tools: allTools,
      toolChoice: this.toolChoice ?? 'auto',
      maxSteps: maxTurns === Infinity ? undefined : maxTurns,
      stopTools: ['done', 'fail'],
      prepareStep: (step) => this.prepareStep(step, injection),
      onStreamError: (err) => {
        this.logger.error({ workerId: this.id, err }, 'LLM stream error');
      },
      onStep: (event, meta) => {
        const entry = buildAssistantEntry(event, this.ctx.sessionId, undefined, {
          startedAt: meta?.startedAt,
          firstTokenAt: meta?.firstTokenAt,
          temperature: this.resolvedModel.temperature,
          maxOutputTokens: this.resolvedModel.maxOutputTokens,
          recordedToolCalls: (toolCallId) => this.recorder.lookup(toolCallId),
        });
        applyTurnEnvelope(entry, turnEnv);
        syncStepTimestamps(entry);
        this.state.append('conversation', entry);

        // Feed this step's real prompt size to the context manager and refresh
        // the usage snapshot. The next prepareStep reads it and compacts when
        // the context is full (issue #90).
        this.updateContextUsage(event.usage);

        // Log step details for debugging
        const toolNames = entry.toolCalls?.map(tc => tc.toolName) ?? [];
        const hasError = entry.toolResults?.some(tr => tr.isError);
        this.logger.debug({
          workerId: this.id,
          step: event.finishReason,
          toolCalls: toolNames,
          hasError,
          textLength: event.text?.length ?? 0,
        }, 'Worker step finished');

        if (event.text && onProgress) {
          onProgress(event.text.slice(0, 200));
        }
      },
    });

    // done/fail callback already set the result
    if (this._terminalResult) {
      return this._terminalResult;
    }

    // External abort (Ctrl+C / supervisor shutdown)
    if (this.abortController.signal.aborted) {
      return { status: 'failed', error: 'Aborted' };
    }

    // Loop ended without done/fail — the worker never declared success, so
    // this is a failure, never a completion. A finite cap that was hit is a
    // hard stop; otherwise the model simply stopped calling tools.
    const stepCount = result.steps ?? '?';
    const finish = result.finishReason ?? 'unknown';
    const lastTools = result.toolResults?.map(tr => tr.toolCallId).filter(Boolean) ?? [];
    const capped = maxTurns !== Infinity && result.steps !== undefined && result.steps >= maxTurns;
    this.logger.warn({
      workerId: this.id,
      steps: stepCount,
      finishReason: finish,
      lastToolCount: lastTools.length,
      capped,
      text: result.text?.slice(0, 200) || '(empty)',
    }, capped ? 'Worker reached its step limit without done/fail' : 'Worker finished without done/fail');
    return {
      status: 'failed',
      error: capped
        ? `Reached step limit ${maxTurns} without done/fail (finishReason=${finish})`
        : `Worker loop ended without done/fail (steps=${stepCount}, finishReason=${finish})`,
    };
  }

  /**
   * prepareStep hook (issue #90): the point between two steps of the SDK's
   * step loop — it runs right after the previous step's onStepFinish (which
   * reported that step's usage) and before the next request goes out.
   *
   * A full context is compacted here; from then on every later step must send
   * the messages rebuilt from the conversation, because the SDK re-derives
   * each step's base from its own append-only response list and would silently
   * resurrect the pre-compaction history.
   *
   * Stays synchronous (and byte-identical to the injection hook) unless a
   * compaction is actually needed, so runs that never fill up pay nothing.
   */
  private prepareStep(
    step: Parameters<PrepareStepFunction<ToolSet>>[0],
    injection: ReturnType<typeof createInboxInjection>,
  ): ReturnType<PrepareStepFunction<ToolSet>> {
    // Inbox first: a message injected now is part of the context the compaction
    // decision is made on.
    const injected = injection.prepareStep(step);
    if (this.contextManager.isFull()) {
      return this.compactForNextStep();
    }
    if (this.contextOverriddenThisRun) {
      return this.rebuiltStep();
    }
    return injected;
  }

  /** Messages + system prompt for a step served from the compacted context. */
  private rebuiltStep(): { messages: ModelMessage[]; system: string } {
    const messages = this.contextManager.getMessages();
    // A compaction between two steps leaves the verbatim zone empty (the
    // summary lives in the system prompt) — providers reject an empty messages
    // array, and a truncated window may start mid-turn. Seed a request-only
    // continuation turn in that case; it is not persisted, so the next rebuild
    // is driven by the reply alone.
    const needsSeed = messages.length === 0 || messages[0]?.role !== 'user';
    if (needsSeed) {
      return {
        messages: [{ role: 'user', content: this.seedContent() }, ...messages],
        system: this.contextManager.getSystemPrompt(),
      };
    }
    // The verbatim zone starts with a user turn (e.g. after a truncation that
    // kept the task prompt). If the CURRENT task description was still cut,
    // re-inject it ahead of the surviving history so the model always knows
    // what it is working on.
    if (this.currentTaskDescription !== undefined && !this.messagesContainTask(messages)) {
      return {
        messages: [{ role: 'user', content: `[Current task]\n${this.currentTaskDescription}` }, ...messages],
        system: this.contextManager.getSystemPrompt(),
      };
    }
    return { messages, system: this.contextManager.getSystemPrompt() };
  }

  /** The seed's text: the compaction notice plus the current task description. */
  private seedContent(): string {
    return this.currentTaskDescription === undefined
      ? COMPACTION_CONTINUATION
      : `${COMPACTION_CONTINUATION}\n\n[Current task]\n${this.currentTaskDescription}`;
  }

  /** Is the current task description already in the verbatim messages? */
  private messagesContainTask(messages: ModelMessage[]): boolean {
    const task = this.currentTaskDescription;
    if (task === undefined) return true;
    return messages.some((message) => message.role === 'user' && message.content === task);
  }

  /**
   * Compact (or, past the per-run limit, truncate) before the next step and
   * hand back the rebuilt request. Summarizing uses a separate generateText
   * call, so it never counts against the run's maxTurns step budget.
   */
  private async compactForNextStep(): Promise<{ messages: ModelMessage[]; system: string }> {
    if (this.compactionsThisRun >= MAX_COMPACTIONS_PER_RUN) {
      this.logger.warn(
        { workerId: this.id, compactions: this.compactionsThisRun, limit: MAX_COMPACTIONS_PER_RUN },
        'Compaction limit reached — truncating history instead of summarizing',
      );
      truncateHistoryHalf({
        state: this.state,
        contextManager: this.contextManager,
        logger: this.logger,
      });
    } else {
      const result = await compactContext({
        state: this.state,
        contextManager: this.contextManager,
        model: this.model,
        modelName: this.resolvedModel.modelName,
        logger: this.logger,
        // The current task description is re-injected into the rebuilt request
        // (see rebuiltStep), so it is left out of the summarizer input: a
        // summary could otherwise paraphrase it away while the verbatim zone is
        // empty, leaving the model unable to say what its task is.
        excludeEntryUuids: this.currentTaskEntryUuid !== undefined ? [this.currentTaskEntryUuid] : [],
      });
      // A no-op (too few entries) must not burn the per-run budget.
      if (result.outcome === 'skipped') return this.rebuiltStep();
      this.compactionsThisRun++;
    }
    this.contextOverriddenThisRun = true;
    this.updateContextUsage();
    return this.rebuiltStep();
  }

  /**
   * Refresh dynamicState.contextUsage (same shape as the controller's).
   *
   * Prefers the real prompt size reported by the provider (inputTokens of the
   * step that just finished); falls back to the local estimate when usage is
   * unavailable. The real value also feeds the context manager so compaction
   * triggers on real usage, not the (under)estimator.
   */
  private updateContextUsage(stepUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  }): void {
    const contextWindowTokens = this.contextManager.getContextWindowTokens();
    const reported = stepUsage?.inputTokens;
    const hasReported = typeof reported === 'number' && Number.isFinite(reported) && reported > 0;
    if (hasReported) {
      this.contextManager.reportRealUsage(reported);
    }
    const usedTokens = hasReported ? reported : this.contextManager.getEstimatedTokens();
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

  /** Called by done tool callback — saves result. Loop stops via stopWhen. */
  complete(summary: string): void {
    this.logger.debug({ summary }, 'WorkerAgent complete called');
    this._terminalResult = { status: 'completed', summary };
  }

  /** Called by fail tool callback — saves result. Loop stops via stopWhen. */
  fail(error: string): void {
    this.logger.debug({ error }, 'WorkerAgent fail called');
    this._terminalResult = { status: 'failed', error };
  }

  /** Get state for UI rendering. */
  getState() {
    return this.state;
  }

  /**
   * Live run flags (issue #16). A puppet worker has no SDK result/stream
   * concept: `resultReceived` means the model already called done/fail, and
   * `streamEnded` is not tracked (null), so status readers fall back to the
   * transcript / task state instead of guessing.
   */
  getLiveStatus(): WorkerLiveStatus {
    return { resultReceived: this._terminalResult !== null, streamEnded: null };
  }

  /** Get conversation entries. */
  getConversation(): ConversationEntry[] {
    return this.state.get<ConversationEntry[]>('conversation') ?? [];
  }

  // --- Subscribable ---

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.state.on(path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.state.get(path);
  }

  /**
   * Accept a message from the controller — writes to internal inbox. The
   * puppet reads it at its next LLM step, so a running (or idle) worker
   * always accepts.
   */
  acceptMessage(message: string): boolean {
    this.state.append('inbox', {
      id: generateId('msg'),
      content: message,
      timestamp: Date.now(),
    } satisfies InboxMessage);
    this.logger.info({ workerId: this.id }, 'Controller message accepted');
    return true;
  }

  /** Unread controller messages (non-destructive) — engine reports these when the run ends. */
  pendingMessages(): string[] {
    return (this.state.get<InboxMessage[]>('inbox') ?? []).map(m => m.content);
  }

  /** Atomically drain and return all inbox messages. */
  private drainInbox(): InboxMessage[] {
    const messages = this.state.get<InboxMessage[]>('inbox') ?? [];
    if (messages.length > 0) {
      this.state.set('inbox', []);
    }
    return messages;
  }

  /**
   * Write a controller message into the conversation as a User entry. This is
   * what makes injected instructions survive context rebuilds (getMessages()
   * derives from conversation) and future multi-stage runs.
   */
  private appendControllerMessageEntry(content: string, turnEnv: TurnEnvelope): void {
    const ts = nowISO();
    this.state.append('conversation', applyTurnEnvelope({
      type: EEntryType.User,
      uuid: generateId('u'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: ts,
      actor: { kind: 'controller', id: 'controller' },
      // Delivery of the message completes at write time.
      endedAt: ts,
      message: { role: 'user', content: controllerMessageContent(content) },
    } satisfies ConversationEntry, turnEnv));
  }
}
