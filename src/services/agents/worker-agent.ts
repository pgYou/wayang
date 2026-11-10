import { BaseAgent } from './base-agent';
import { ContextManager } from './context-manager';
import { WorkerState, type InboxMessage } from '@/services/agents/worker-state';
import { buildAssistantEntry } from '@/services/agents/utils/build-assistant-entry';
import { applyTurnEnvelope, syncStepTimestamps, type TurnEnvelope } from '@/services/agents/utils/entry-envelope';
import { ToolCallRecorder, recordToolCalls } from '@/services/agents/utils/tool-call-recorder';
import { controllerMessageContent, createInboxInjection } from '@/services/agents/utils/inbox-injection';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { WorkerResult, TaskDetail, ProviderConfig, ToolChoice, IWorkerInstance, WorkerLiveStatus } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { EEntryType } from '@/types/index';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import { resolveMaxTurns } from './max-turns';
import { checkControllerMessagesTool } from '@/services/tools/check-messages';

import { buildWorkerSystemPrompt } from './prompts/index';
import { SystemContext } from '@/infra/system-context';
import type { SkillRegistry } from '@/services/skills/registry';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { resolveWorkspaceRef } from '@/infra/workspace-registry';
import type { WorkspaceRef } from '@/infra/workspace-registry';

export class WorkerAgent extends BaseAgent implements IWorkerInstance {
  private readonly state: WorkerState;
  private readonly logger: Logger;
  private _terminalResult: WorkerResult | null = null;
  /** Workspace this worker executes in — fixed at construction (IWorkerInstance). */
  readonly workspaceDir: string;
  private readonly toolChoice: ToolChoice | undefined;
  private readonly provider: ProviderConfig;
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

  constructor(
    provider: ProviderConfig,
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
    super(provider);
    this.provider = provider;
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.workspaceDir = workspaceDir ?? ctx.workspaceDir;
    this.toolChoice = toolChoice;
    // Workspace identity is stamped into runtime-state so a worker's records
    // stay attributable after it finished (registry slug keeps it stable). The
    // same ref feeds the turn envelope's `workspaceSlug`.
    this.workspaceRef = resolveWorkspaceRef(wayangDirForSessionDir(ctx.sessionDir), this.workspaceDir);
    this.state = new WorkerState(
      ctx.sessionDir,
      this.id,
      ctx.logger,
      this.workspaceRef,
    );
    // No context window budget: workers never call isFull()/compact today,
    // so passing provider.contextWindowTokens would be a dead setting.
    // The prompt is built for THIS worker's workspace, not the process
    // workspace: project rules (AGENTS.md) and the Environment section must
    // describe the directory the worker's tools actually run in.
    this.contextManager = new ContextManager(
      this.state,
      buildWorkerSystemPrompt(this.ctx, skills, this.workspaceDir),
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
      uuid: generateId('u'),
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
      prepareStep: injection.prepareStep,
      onStreamError: (err) => {
        this.logger.error({ workerId: this.id, err }, 'LLM stream error');
      },
      onStep: (event, meta) => {
        const entry = buildAssistantEntry(event, this.ctx.sessionId, undefined, {
          startedAt: meta?.startedAt,
          firstTokenAt: meta?.firstTokenAt,
          temperature: this.provider.temperature,
          maxOutputTokens: this.provider.maxOutputTokens,
          recordedToolCalls: (toolCallId) => this.recorder.lookup(toolCallId),
        });
        applyTurnEnvelope(entry, turnEnv);
        syncStepTimestamps(entry);
        this.state.append('conversation', entry);

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
