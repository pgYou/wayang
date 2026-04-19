/**
 * ClaudeCodeWorker — third-party worker that delegates execution to Claude Code
 * via the Claude Agent SDK.
 *
 * Independent implementation (does NOT extend BaseAgent).
 * Conversation entries are written for UI display and audit only —
 * never read back for context recovery.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { WorkerResult, TaskDetail, WorkerConfig, PermissionRequestSignalPayload } from '@/types/index';
import type { IWorkerInstance } from '@/types/worker';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import { WorkerState } from './worker-state';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { EEntryType } from '@/types/index';
import { buildThirdPartyPrompt } from './prompts/index';
import { SystemContext } from '@/infra/system-context';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { PermissionMiddlewareResult } from '@/services/tools/permission-middleware';

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

  // --- Permission control via canUseTool ---
  private readonly _pendingPermissions = new Map<string, {
    resolve: (result: PermissionResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private static readonly PERMISSION_TIMEOUT_MS = 300_000;

  /** Exposed for engine to resolve pending permission requests. */
  readonly permissionHandler: PermissionMiddlewareResult = {
    resolvePermission: (requestId: string, approved: boolean, reason?: string) => {
      const entry = this._pendingPermissions.get(requestId);
      if (!entry) return false;
      clearTimeout(entry.timer);
      this._pendingPermissions.delete(requestId);
      entry.resolve(
        approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: reason ?? 'Denied by controller' },
      );
      return true;
    },
    cleanup: () => {
      for (const [id, entry] of this._pendingPermissions) {
        clearTimeout(entry.timer);
        this._pendingPermissions.delete(id);
        entry.resolve({ behavior: 'deny', message: 'Worker aborted' });
      }
    },
    wrappedTools: {}, // not used for ClaudeCodeWorker
  };

  // Signal context set during run()
  private _signalQueue: SignalQueue | null = null;
  private _runContext: { workerId: string; taskId: string; taskTitle: string; workerType?: string; emoji?: string } | null = null;

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
  constructor(
    config: WorkerConfig,
    sessionDir: string,
    workspaceDir: string,
    ctx: SystemContext,
  ) {
    this.id = generateId('cw');
    this.ctx = ctx;
    this.config = config;
    this.workspaceDir = workspaceDir;
    this.logger = ctx.logger;
    this.state = new WorkerState(sessionDir, this.id, ctx.logger);
  }

  async run(
    task: TaskDetail & { workerId: string },
    _tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult> {
    // Set task info in state
    this.state.set('runtimeState.task', { id: task.id, description: task.description });

    // Write initial user entry
    this.state.append('conversation', {
      type: EEntryType.User,
      uuid: generateId('u'),
      parentUuid: null,
      sessionId: this.id,
      timestamp: nowISO(),
      message: { role: 'user', content: task.description },
    });

    try {
      const options: Record<string, any> = {
        cwd: this.workspaceDir,
        maxTurns: this.config.maxTurns ?? 1000,
        permissionMode: 'bypassPermissions' as const,
        abortController: this.abortController,
      };
      if (this.config.cliPath) {
        options.pathToClaudeCodeExecutable = this.config.cliPath;
      }

      // Wire canUseTool for permission control if signal context is set
      if (this._signalQueue && this._runContext) {
        options.canUseTool = (toolName: string, input: Record<string, unknown>) =>
          this.handleCanUseTool(toolName, input);
      }

      const stream = query({
        prompt: this.buildPromptIterable(task.description),
        options,
      });

      for await (const message of stream) {
        if (this.abortController.signal.aborted) break;
        this.processStreamMessage(message, onProgress);
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

    // Cleanup
    this.permissionHandler.cleanup();
    this.flushMessageQueue();

    // Write final result entry
    this.state.append('conversation', {
      type: EEntryType.System,
      uuid: generateId('s'),
      parentUuid: null,
      sessionId: this.id,
      timestamp: nowISO(),
      subtype: this._terminalResult.status === 'completed' ? 'compact' : 'error',
      content: this._terminalResult.summary ?? this._terminalResult.error ?? '',
    });

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
  }): void {
    this._signalQueue = deps.signalQueue;
    this._runContext = deps;
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
    this.logger.info({ workerId: this.id }, 'Controller message accepted');
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
    });

    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this._pendingPermissions.delete(requestId);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, ClaudeCodeWorker.PERMISSION_TIMEOUT_MS);

      this._pendingPermissions.set(requestId, { resolve, timer });
    });
  }

  // --- Prompt as AsyncIterable (supports follow-up messages) ---

  private buildPromptIterable(initialPrompt: string): AsyncIterable<SDKUserMessage> {
    return {
      [Symbol.asyncIterator]: () => {
        let sentInitial = false;
        return {
          next: async () => {
            // First yield: the initial task prompt
            if (!sentInitial) {
              sentInitial = true;
              return {
                value: {
                  type: 'user' as const,
                  message: { role: 'user' as const, content: `${buildThirdPartyPrompt()}${initialPrompt}` },
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
    this.state.append('conversation', {
      type: EEntryType.Assistant,
      uuid: generateId('a'),
      parentUuid: null,
      sessionId: this.id,
      timestamp: nowISO(),
      message: {
        role: 'assistant',
        content: text,
        usage: {
          inputTokens: msg.message.usage?.input_tokens ?? 0,
          outputTokens: msg.message.usage?.output_tokens ?? 0,
        },
      },
    });

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
    // Cancel any pending progress — result supersedes it
    this.flushMessageQueue();
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
