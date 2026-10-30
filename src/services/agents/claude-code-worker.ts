/**
 * ClaudeCodeWorker — third-party worker that delegates execution to Claude Code
 * via the Claude Agent SDK.
 *
 * Independent implementation (does NOT extend BaseAgent).
 * Conversation entries are written for UI display and audit only —
 * never read back for context recovery.
 *
 * Multi-stage note: the Claude Agent SDK's `query()` starts a fresh session
 * each call, so unlike the puppet WorkerAgent this worker does NOT carry SDK
 * session context across stages. Assigning a follow-up task reuses the worker
 * instance (and its persisted conversation log), but the underlying Claude
 * process begins anew. `multiStage` therefore provides less benefit here than
 * for puppet workers.
 */

import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage, PermissionResult, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { WorkerResult, TaskDetail, WorkerConfig, PermissionRequestSignalPayload } from '@/types/index';
import type { IWorkerInstance } from '@/types/worker';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import { WorkerState } from './worker-state';
import { applyTurnEnvelope, type TurnEnvelope } from './utils/entry-envelope';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { EEntryType, ESystemSubtype } from '@/types/index';
import type { SignalTurnLineage } from '@/types/index';
import { buildThirdPartyPrompt } from './prompts/index';
import { SystemContext } from '@/infra/system-context';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { PermissionMiddlewareResult } from '@/services/tools/permission-middleware';
import { BlockingRequestMap } from '@/infra/blocking-requests';
import type { SkillRegistry } from '@/services/skills/registry';

/** Stream-close timeout for SDK MCP calls — must exceed the 5-min inquiry timeout. */
const INQUIRY_STREAM_CLOSE_TIMEOUT_MS = 360_000;

export class ClaudeCodeWorker implements IWorkerInstance {
  readonly id: string;
  private readonly config: WorkerConfig;
  private readonly state: WorkerState;
  private readonly workspaceDir: string;
  private readonly logger: Logger;
  private readonly abortController = new AbortController();
  private _terminalResult: WorkerResult | null = null;

  // --- Controller messaging via streamInput ---
  private _messageQueue: string[] = [];
  private _messageResolve: ((value: void) => void) | null = null;
  /** Active SDK query — interrupted to deliver controller messages promptly. */
  private _activeQuery: { interrupt(): Promise<void> } | null = null;
  /**
   * Interrupt requested while a permission was pending — delivered right
   * after the permission settles (interrupting mid-permission is unproven
   * SDK territory; see docs/develop/v0.6-design.md §3).
   */
  private _interruptQueued = false;

  // --- ask_controller via in-process SDK MCP server ---
  private _askController: ((question: string, context?: string) => Promise<string>) | null = null;

  // --- Permission control via canUseTool ---
  private readonly _pendingPermissions = new BlockingRequestMap<PermissionResult>();
  private static readonly PERMISSION_TIMEOUT_MS = 300_000;

  /** Exposed for engine to resolve pending permission requests. */
  readonly permissionHandler: PermissionMiddlewareResult = {
    resolvePermission: (requestId: string, approved: boolean, reason?: string) => {
      const ok = this._pendingPermissions.resolve(
        requestId,
        approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: reason ?? 'Denied by controller' },
      );
      if (ok) this.afterPermissionSettled();
      return ok;
    },
    cleanup: () => {
      // Worker dying: drop any queued interrupt so a stale flag cannot fire
      // a spurious interrupt in the next stage.
      this._interruptQueued = false;
      this._pendingPermissions.cleanupAll(() => ({ behavior: 'deny', message: 'Worker aborted' }));
    },
    wrappedTools: {}, // not used for ClaudeCodeWorker
  };

  /**
   * A permission settled (approved / denied / timed out). If a controller
   * message was waiting for the permission window to close, deliver its
   * interrupt now — this runs on BOTH the resolve and the timeout path.
   */
  private afterPermissionSettled(): void {
    if (this._interruptQueued && this._pendingPermissions.size === 0) {
      this._interruptQueued = false;
      this.requestInterrupt();
    }
  }

  // Signal context set during run()
  private _signalQueue: SignalQueue | null = null;
  private _runContext: { workerId: string; taskId: string; taskTitle: string; workerType?: string; emoji?: string } | null = null;
  /** Turn lineage for permission-request signals emitted by this worker. */
  private _turnLineage: SignalTurnLineage = {};
  /** Turn lineage stamped on entries written by the run in flight. */
  private _currentTurnEnv: TurnEnvelope | null = null;

  /**
   * Turn identity: one worker run = one turn. The engine passes the task's
   * execution turn id; rootTurnId is inherited from the task; the task is
   * the direct cause of this activation.
   */
  private buildTurnEnv(task: TaskDetail & { workerId: string }): TurnEnvelope {
    return {
      turnId: task.executionTurnId ?? generateId('turn'),
      ...((task.rootTurnId ?? task.turnId) !== undefined && { rootTurnId: task.rootTurnId ?? task.turnId }),
      causationId: task.id,
      actor: { kind: 'worker', id: task.workerId, taskId: task.id },
    };
  }

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
  private _progressTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingProgress: string | null = null;
  private readonly ctx: SystemContext;
  private readonly skills: SkillRegistry;
  constructor(
    config: WorkerConfig,
    sessionDir: string,
    workspaceDir: string,
    ctx: SystemContext,
    skills: SkillRegistry,
  ) {
    this.id = generateId('cw');
    this.ctx = ctx;
    this.config = config;
    this.workspaceDir = workspaceDir;
    this.logger = ctx.logger;
    this.skills = skills;
    this.state = new WorkerState(sessionDir, this.id, ctx.logger);
  }

  async run(
    task: TaskDetail & { workerId: string },
    _tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult> {
    // Reset per-run state. A multi-stage worker's run() is called more than
    // once; without this reset a stale terminal result from the previous stage
    // would short-circuit the new stage.
    this._terminalResult = null;

    // Set task info in state
    this.state.set('runtimeState.task', { id: task.id, description: task.description });

    // Turn identity: one worker run = one turn. The engine passes the task's
    // execution turn id; rootTurnId is inherited from the task; the task is
    // the direct cause of this activation.
    const turnEnv = this.buildTurnEnv(task);
    this._currentTurnEnv = turnEnv;

    // Write initial user entry. The task prompt is written by the orchestration
    // engine, not the human user — actor reflects that.
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
    } as import('@/types/conversation').ConversationEntry, turnEnv));

    try {
      // Permission mode: 'default' when canUseTool is wired (below) so tool
      // permission checks actually route to our handler — under
      // 'bypassPermissions' the CLI never calls canUseTool, and the
      // dangerous-command gate silently never fires (verified against the
      // real CLI; see scripts/poc-interrupt-permission.mjs). Without signal
      // context there is no handler — keep bypass.
      const wirePermissions = Boolean(this._signalQueue && this._runContext);

      const options: Record<string, any> = {
        cwd: this.workspaceDir,
        maxTurns: this.config.maxTurns ?? 1000,
        permissionMode: (wirePermissions ? 'default' : 'bypassPermissions') as 'default' | 'bypassPermissions',
        abortController: this.abortController,
        // SDK MCP calls (ask_controller blocks up to 5 min waiting for the
        // controller) far exceed the default 60s stream-close timeout — raise
        // it (see sdk.d.ts createSdkMcpServer note). NOTE: the SDK REPLACES
        // the child env with this object (`{...options.env ?? process.env}`
        // in cli.js) — spread process.env or the child loses PATH/HOME and
        // ~/.claude resolution breaks.
        env: {
          ...process.env,
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(INQUIRY_STREAM_CLOSE_TIMEOUT_MS),
        },
      };
      if (this.config.cliPath) {
        options.pathToClaudeCodeExecutable = this.config.cliPath;
      }
      if (this._askController) {
        options.mcpServers = {
          wayang: createSdkMcpServer({
            name: 'wayang',
            version: '1.0.0',
            tools: [this.buildAskControllerMcpTool()],
          }),
        };
      }

      // Wire canUseTool for permission control if signal context is set
      if (wirePermissions) {
        options.canUseTool = (toolName: string, input: Record<string, unknown>) =>
          this.handleCanUseTool(toolName, input);
      }

      const stream = query({
        prompt: this.buildPromptIterable(task.description),
        options,
      });
      this._activeQuery = stream;

      try {
        for await (const message of stream) {
          if (this.abortController.signal.aborted) break;
          this.processStreamMessage(message, onProgress);
        }
      } finally {
        this._activeQuery = null;
      }
    } catch (err: any) {
      this.logger.error({ err, taskId: task.id }, 'ClaudeCodeWorker query error');
      if (!this._terminalResult) {
        this._terminalResult = {
          status: 'failed',
          error: err.message ?? String(err),
        };
      }
    }

    // Fallback: if no result was set (e.g. abort), mark as failed
    if (!this._terminalResult) {
      this._terminalResult = {
        status: 'failed',
        error: this.abortController.signal.aborted ? 'Aborted' : 'No result received from Claude Code',
      };
    }

    // Cleanup. Pending permission requests are denied; the message queue is
    // deliberately NOT flushed — the engine reports leftovers as
    // message_undelivered, and an idle (multi-stage) worker may still read
    // them at its next stage.
    this.permissionHandler.cleanup();

    // Write final result entry. Point-in-time event: startedAt/endedAt share
    // the recording moment.
    const resultTs = nowISO();
    this.state.append('conversation', applyTurnEnvelope({
      type: EEntryType.System,
      uuid: generateId('s'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: resultTs,
      subtype: this._terminalResult.status === 'completed' ? ESystemSubtype.TaskResult : ESystemSubtype.Error,
      content: this._terminalResult.summary ?? this._terminalResult.error ?? '',
      startedAt: resultTs,
      endedAt: resultTs,
    } as import('@/types/conversation').ConversationEntry, turnEnv));

    return this._terminalResult;
  }

  /** Set signal context for permission requests. Called by engine before run(). */
  setSignalContext(deps: {
    signalQueue: SignalQueue;
    workerId: string;
    taskId: string;
    taskTitle: string;
    workerType?: string;
    emoji?: string;
    /** Turn lineage attached to signals emitted by this worker. */
    turnLineage?: SignalTurnLineage;
  }): void {
    this._signalQueue = deps.signalQueue;
    this._runContext = deps;
    this._turnLineage = deps.turnLineage ?? {};
  }

  abort(): void {
    this.abortController.abort();
    this.permissionHandler.cleanup();
    this.flushMessageQueue();
  }

  /** Get state for UI rendering. */
  getState(): WorkerState {
    return this.state;
  }

  /** Get conversation entries. */
  getConversation(): import('@/types/conversation').ConversationEntry[] {
    return this.state.get<import('@/types/conversation').ConversationEntry[]>('conversation') ?? [];
  }

  // --- Subscribable ---

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.state.on(path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.state.get(path);
  }

  /** Accept a message from the controller — injects into running session via streamInput. */
  acceptMessage(message: string): void {
    this._messageQueue.push(message);
    if (this._messageResolve) {
      this._messageResolve();
      this._messageResolve = null;
    }
    // Prompt delivery: interrupt the current turn so the SDK comes back for
    // the next streamInput item right away ('immediate', the default). While
    // a permission is pending, hold off — see requestInterrupt.
    if ((this.config.interruptOnMessage ?? 'immediate') === 'immediate') {
      this.requestInterrupt();
    }
    this.logger.info({ workerId: this.id }, 'Controller message accepted');
  }

  /** Unread controller messages (non-destructive) — engine reports these when the run ends. */
  pendingMessages(): string[] {
    return [...this._messageQueue];
  }

  /** Interrupt the active query unless a permission is pending (queued until it settles). */
  private requestInterrupt(): void {
    if (this.abortController.signal.aborted || !this._activeQuery) return;
    if (this._pendingPermissions.size > 0) {
      this._interruptQueued = true;
      return;
    }
    // Defensive: the query object may lack interrupt() (mocks, older SDKs).
    if (typeof this._activeQuery.interrupt !== 'function') return;
    this._activeQuery.interrupt().catch((err) => {
      this.logger.warn({ workerId: this.id, err: String(err) }, 'interrupt() failed');
    });
  }

  /**
   * Provide the engine-backed ask_controller implementation. Once set, the
   * worker exposes it to Claude Code as an in-process SDK MCP tool.
   */
  setInquirySupport(ask: (question: string, context?: string) => Promise<string>): void {
    this._askController = ask;
  }

  // --- Permission control via canUseTool ---

  /** Dangerous command patterns that require controller approval. */
  private static readonly DANGEROUS_COMMAND_PATTERN = /\b(rm\s|sudo\b|chmod\b|chown\b|mkfs\b|dd\s|shutdown\b|reboot\b|kill\s+-9)/;

  private async handleCanUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    // Only gate Bash with dangerous commands
    if (toolName !== 'Bash' || !this._signalQueue || !this._runContext) {
      return { behavior: 'allow' };
    }

    const command = String(input.command ?? '');
    if (!ClaudeCodeWorker.DANGEROUS_COMMAND_PATTERN.test(command)) {
      return { behavior: 'allow' };
    }

    const requestId = generateId('perm');
    const description = `Execute shell command: ${command}`;

    this._signalQueue.enqueue({
      source: 'worker',
      type: 'permission_request',
      payload: {
        requestId,
        workerId: this._runContext.workerId,
        taskId: this._runContext.taskId,
        taskTitle: this._runContext.taskTitle,
        workerType: this._runContext.workerType,
        emoji: this._runContext.emoji,
        toolName,
        toolArgs: input,
        description,
      } satisfies PermissionRequestSignalPayload,
      ...this._turnLineage,
    });

    // The timeout factory runs after the entry was removed from the map, so
    // the deferred-interrupt delivery in afterPermissionSettled sees a clean
    // window — the timeout path behaves exactly like an explicit resolution.
    return this._pendingPermissions.wait(requestId, ClaudeCodeWorker.PERMISSION_TIMEOUT_MS, () => {
      const value: PermissionResult = { behavior: 'deny', message: 'Permission request timed out' };
      this.afterPermissionSettled();
      return value;
    });
  }

  // --- Prompt as AsyncIterable (supports follow-up messages) ---

  private buildPromptIterable(initialPrompt: string): AsyncIterable<SDKUserMessage> {
    return {
      [Symbol.asyncIterator]: () => {
        let sentInitial = false;
        return {
          next: async () => {
            // First yield: the initial task prompt. Messages that arrived
            // while the worker was idle (between stages) are folded in here —
            // otherwise they would wait out the new task's whole first turn.
            if (!sentInitial) {
              sentInitial = true;
              const leftovers = this._messageQueue.splice(0, this._messageQueue.length);
              const leftoverText = leftovers.map(m => `[Controller message] ${m}`).join('\n\n');
              const content = leftoverText
                ? `${buildThirdPartyPrompt(this.skills)}${initialPrompt}\n\n${leftoverText}`
                : `${buildThirdPartyPrompt(this.skills)}${initialPrompt}`;
              return {
                value: {
                  type: 'user' as const,
                  message: { role: 'user' as const, content },
                  parent_tool_use_id: null,
                } satisfies SDKUserMessage,
                done: false,
              };
            }
            // Subsequent yields: controller messages from the queue
            while (this._messageQueue.length === 0) {
              if (this.abortController.signal.aborted || this._terminalResult) {
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                this._messageResolve = resolve;
              });
            }
            const msg = this._messageQueue.shift()!;
            return {
              value: {
                type: 'user' as const,
                message: { role: 'user' as const, content: `[Controller message] ${msg}` },
                parent_tool_use_id: null,
              } satisfies SDKUserMessage,
              done: false,
            };
          },
        };
      },
    };
  }

  /**
   * ask_controller as an in-process SDK MCP tool: visible in Claude Code's
   * real tool catalog (no prompt-convention virtual tools); the handler runs
   * host-side and blocks on the engine's blocking-request registry.
   */
  private buildAskControllerMcpTool(): SdkMcpToolDefinition<any> {
    return {
      name: 'ask_controller',
      description:
        'Ask the controller a question and WAIT for the answer. Use ONLY when blocked: ' +
        'execution cannot continue as instructed, or continuing would risk significant wasted work. ' +
        'Do NOT use it for decisions you can make yourself.',
      inputSchema: {
        question: z.string().max(500).describe('The specific question you need answered to proceed'),
        context: z.string().max(1000).optional().describe('What you tried and where you are stuck'),
      },
      handler: async (args: { [x: string]: unknown }) => {
        const question = String(args.question ?? '');
        const context = args.context !== undefined ? String(args.context) : undefined;
        const answer = await this._askController!(question, context);
        // Audit record in the worker's conversation (display/audit only —
        // never read back for context). Covers timeouts too: the notice IS
        // the answer of record.
        this.recordInquiryAudit(question, answer);
        return { content: [{ type: 'text' as const, text: answer }] };
      },
    };
  }

  /** Write one ask_controller Q&A into the worker conversation (audit only). */
  private recordInquiryAudit(question: string, answer: string): void {
    const ts = nowISO();
    this.state.append('conversation', applyTurnEnvelope({
      type: EEntryType.System,
      uuid: generateId('s'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: ts,
      subtype: ESystemSubtype.Inquiry,
      content: `ask_controller: ${question}\ncontroller: ${answer}`,
      startedAt: ts,
      endedAt: ts,
    } as import('@/types/conversation').ConversationEntry, this._currentTurnEnv ?? undefined));
  }

  private flushMessageQueue(): void {
    this._messageQueue.length = 0;
    if (this._messageResolve) {
      this._messageResolve();
      this._messageResolve = null;
    }
  }

  // --- Stream message processing ---

  private processStreamMessage(message: SDKMessage, onProgress?: (msg: string) => void): void {
    if (message.type === 'assistant') {
      this.handleAssistantMessage(message, onProgress);
    } else if (message.type === 'result') {
      this.handleResultMessage(message);
    }
    // Ignore other message types (system, user, status, etc.)
  }

  private handleAssistantMessage(msg: SDKAssistantMessage, onProgress?: (msg: string) => void): void {
    // Extract text content from the BetaMessage content blocks
    const textParts: string[] = [];
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      }
    }
    const text = textParts.join('\n');
    if (!text) return;

    // Append to conversation for UI/audit
    this.state.append('conversation', applyTurnEnvelope({
      type: EEntryType.Assistant,
      uuid: generateId('a'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: nowISO(),
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
    } as import('@/types/conversation').ConversationEntry, this._currentTurnEnv ?? undefined));

    // Debounced progress: delay 500ms, cancel if result arrives first
    if (onProgress) {
      this._pendingProgress = text.slice(0, 200);
      if (this._progressTimer) clearTimeout(this._progressTimer);
      this._progressTimer = setTimeout(() => {
        if (this._pendingProgress) {
          onProgress(this._pendingProgress);
          this._pendingProgress = null;
        }
        this._progressTimer = null;
      }, ClaudeCodeWorker.PROGRESS_DEBOUNCE_MS);
    }
  }

  private handleResultMessage(msg: SDKResultSuccess | SDKResultError): void {
    // Cancel any pending progress — result supersedes it. The message queue
    // is NOT flushed here: leftover controller messages are reported by the
    // engine (message_undelivered) instead of vanishing silently.
    if (this._progressTimer) {
      clearTimeout(this._progressTimer);
      this._progressTimer = null;
      this._pendingProgress = null;
    }

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

    // Record usage in runtime state
    const prev = this.state.get<any>('runtimeState');
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
