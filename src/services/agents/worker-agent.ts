import { BaseAgent } from './base-agent';
import { ContextManager } from './context-manager';
import { WorkerState, type InboxMessage } from '@/services/agents/worker-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { applyTurnEnvelope, syncStepTimestamps, type TurnEnvelope } from './utils/entry-envelope';
import { ToolCallRecorder, recordToolCalls } from './utils/tool-call-recorder';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { WorkerResult, TaskDetail, ProviderConfig, ToolChoice, IWorkerInstance } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { EEntryType } from '@/types/index';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import { WORKER_AGENT_MAX_STEP } from './constants';
import { checkControllerMessagesTool } from '@/services/tools/check-messages';

import { buildWorkerSystemPrompt } from './prompts/index';
import { SystemContext } from '@/infra/system-context';
import type { SkillRegistry } from '@/services/skills/registry';

export class WorkerAgent extends BaseAgent implements IWorkerInstance {
  private readonly state: WorkerState;
  private readonly logger: Logger;
  private _terminalResult: WorkerResult | null = null;
  private readonly workspaceDir: string;
  private readonly toolChoice: ToolChoice | undefined;
  private readonly provider: ProviderConfig;
  private contextManager: ContextManager;
  private readonly ctx: SystemContext;
  /** Live tool execution records — merged into entries at step finish. */
  private readonly recorder = new ToolCallRecorder();

  constructor(
    provider: ProviderConfig,
    ctx: SystemContext,
    skills: SkillRegistry,
    /** Tool-choice mode (worker.toolChoice in config). Falls back to 'auto' —
     *  thinking endpoints (DeepSeek/GLM) reject `tool_choice: "required"` with
     *  HTTP 400, so the safe default lets the model decide; the system prompt
     *  still instructs workers to finish via done/fail. */
    toolChoice?: ToolChoice,
  ) {
    super(provider);
    this.provider = provider;
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.workspaceDir = ctx.workspaceDir;
    this.toolChoice = toolChoice;
    this.state = new WorkerState(ctx.sessionDir, this.id, ctx.logger);
    this.contextManager = new ContextManager(
      this.state,
      buildWorkerSystemPrompt(this.ctx, skills),
      provider.contextWindowTokens,
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
    tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult> {
    this.logger.debug({ task }, 'WorkerAgent run called');
    // Set task info in state
    this.state.set('runtimeState.task', { id: task.id, description: task.description });

    // Reset terminal result for this run
    this._terminalResult = null;

    // --- Turn identity: one worker run = one turn ---
    // The engine passes the task's execution turn id; rootTurnId is inherited
    // from the task (tracing back to the user turn that created it) and the
    // task itself is the direct cause of this activation.
    const turnEnv: TurnEnvelope = {
      turnId: task.executionTurnId ?? generateId('turn'),
      ...((task.rootTurnId ?? task.turnId) !== undefined && { rootTurnId: task.rootTurnId ?? task.turnId }),
      causationId: task.id,
      actor: { kind: 'worker', id: task.workerId, taskId: task.id },
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

    // Add internal tools for controller communication; wrap everything with
    // the recorder so per-call status/timing lands on the step entries.
    const allTools = recordToolCalls({
      ...tools,
      check_controller_messages: checkControllerMessagesTool({
        drainInbox: () => this.drainInbox(),
      }),
    }, this.recorder);

    // streamLoop handles abort internally — collectLoop returns cleanly
    const result = await this.collectLoop({
      system: this.contextManager.getSystemPrompt(),
      messages: this.contextManager.getMessages(),
      tools: allTools,
      toolChoice: this.toolChoice ?? 'auto',
      maxSteps: WORKER_AGENT_MAX_STEP,
      stopTools: ['done', 'fail'],
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

    // Loop ended without done/fail — diagnose why
    const stepCount = result.steps ?? '?';
    const finish = result.finishReason ?? 'unknown';
    const lastTools = result.toolResults?.map(tr => tr.toolCallId).filter(Boolean) ?? [];
    this.logger.warn({
      workerId: this.id,
      steps: stepCount,
      finishReason: finish,
      lastToolCount: lastTools.length,
      text: result.text?.slice(0, 200) || '(empty)',
    }, 'Worker finished without done/fail');
    return { status: 'completed', summary: result.text || '(task ended without done/fail)' };
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

  /** Accept a message from the controller — writes to internal inbox. */
  acceptMessage(message: string): void {
    this.state.append('inbox', {
      id: generateId('msg'),
      content: message,
      timestamp: Date.now(),
    } satisfies InboxMessage);
    this.logger.info({ workerId: this.id }, 'Controller message accepted');
  }

  /** Atomically drain and return all inbox messages. */
  private drainInbox(): InboxMessage[] {
    const messages = this.state.get<InboxMessage[]>('inbox') ?? [];
    if (messages.length > 0) {
      this.state.set('inbox', []);
    }
    return messages;
  }
}
