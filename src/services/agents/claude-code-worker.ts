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
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage, PermissionResult, SdkMcpToolDefinition, Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { WorkerResult, TaskDetail, WorkerConfig, PermissionRequestSignalPayload } from '@/types/index';
import type { IWorkerInstance, WorkerLiveStatus } from '@/types/worker';
import type { Logger } from '@/infra/logger';
import type { StateEvent } from '@/infra/state/base-state';
import { WorkerState } from './worker-state';
import { applyTurnEnvelope, type TurnEnvelope } from './utils/entry-envelope';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { EEntryType, ESystemSubtype } from '@/types/index';
import type { AssistantEntry, ConversationEntry, ToolCallRecord } from '@/types/conversation';
import type { SignalTurnLineage } from '@/types/index';
import {
  toolUseBlockToRecord,
  toolResultBlockToRecord,
  type SdkToolUseBlock,
  type SdkToolResultBlock,
} from './utils/claude-tool-records';
import { buildThirdPartyPrompt } from './prompts/index';
import { SystemContext } from '@/infra/system-context';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { resolveWorkspaceRef } from '@/infra/workspace-registry';
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
  /** Workspace this worker executes in — fixed at construction (IWorkerInstance). */
  readonly workspaceDir: string;
  private readonly logger: Logger;
  private readonly abortController = new AbortController();
  private _terminalResult: WorkerResult | null = null;
  /** True once the SDK message stream of the current run has closed (issue #16). */
  private _streamEnded = false;

  // --- Controller messaging via streamInput ---
  private _messageQueue: string[] = [];
  private _messageResolve: ((value: void) => void) | null = null;
  /**
   * True while run() is executing. Controller messages are rejected once the
   * run's input has closed (see `_inputClosed`), but idle multi-stage workers
   * (no run in flight) keep accepting — the next stage folds them into its
   * opening prompt.
   */
  private _runInFlight = false;
  /**
   * True once the prompt iterator reported done for the current run: the
   * session can no longer take input (a turn result arrived with nothing
   * queued, or the run was aborted). Further acceptMessage calls fail
   * explicitly instead of pretending to queue.
   */
  private _inputClosed = false;

  // --- Tool-call recording (see utils/claude-tool-records.ts) ---
  /**
   * Assistant steps buffered while their tool results are still in flight.
   * The SDK stream splits one LLM step across two messages (assistant
   * tool_use → user tool_result), but the schema stores a step atomically on
   * one AssistantEntry and storage is append-only — so the entry waits in
   * memory until its results arrive (or the stream ends). FIFO order is kept:
   * only the head is flushed, so the file order always matches arrival order.
   */
  private _pendingToolSteps: AssistantEntry[] = [];

  // --- ask_controller via in-process SDK MCP server ---
  private _askController: ((question: string, context?: string) => Promise<string>) | null = null;

  // --- Permission control via canUseTool ---
  private readonly _pendingPermissions = new BlockingRequestMap<PermissionResult>();
  private static readonly PERMISSION_TIMEOUT_MS = 300_000;

  /** Exposed for engine to resolve pending permission requests. */
  readonly permissionHandler: PermissionMiddlewareResult = {
    resolvePermission: (requestId: string, approved: boolean, reason?: string) => {
      return this._pendingPermissions.resolve(
        requestId,
        approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: reason ?? 'Denied by controller' },
      );
    },
    cleanup: () => {
      this._pendingPermissions.cleanupAll(() => ({ behavior: 'deny', message: 'Worker aborted' }));
    },
    wrappedTools: {}, // not used for ClaudeCodeWorker
  };

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
    // Workspace identity is stamped into runtime-state (see WorkerState).
    this.state = new WorkerState(
      sessionDir,
      this.id,
      ctx.logger,
      resolveWorkspaceRef(wayangDirForSessionDir(sessionDir), workspaceDir),
    );
  }

  async run(
    task: TaskDetail & { workerId: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IWorkerInstance.run's tools param (public interface); heterogeneous zod-inferred tool set, see common.ts
    _tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult> {
    // Reset per-run state. A multi-stage worker's run() is called more than
    // once; without this reset a stale terminal result from the previous stage
    // would short-circuit the new stage.
    this._terminalResult = null;
    this._streamEnded = false;
    this._inputClosed = false;
    this._runInFlight = true;
    this._pendingToolSteps = [];

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

      // NOTE: project rules (AGENTS.md / CLAUDE.md) are deliberately NOT
      // injected into this worker's prompt, unlike the puppet worker. The SDK
      // session below runs without `settingSources`, which keeps it in
      // isolated mode — it never auto-loads CLAUDE.md (or other settings)
      // from the workspace, so injecting rules here would be duplication,
      // not coverage. Do not add settingSources without removing the puppet
      // worker's injection (or deduplicating both paths).
      const options: Options = {
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

      // Diagnostics: the SDK's stderr callback is otherwise discarded, leaving
      // CLI-side failures (bad args, auth, MCP startup) invisible in our logs.
      // Only non-empty chunks are logged to avoid flooding the log with blanks.
      options.stderr = (data: string) => {
        const text = String(data).trimEnd();
        if (!text.trim()) return;
        this.logger.debug({ workerId: this.id }, `[claude stderr] ${text}`);
      };

      const stream = query({
        prompt: this.buildPromptIterable(task.description),
        options,
      });

      try {
        for await (const message of stream) {
          if (this.abortController.signal.aborted) break;
          this.processStreamMessage(message, onProgress);
          // NOTE: a result message does NOT end the run. With an AsyncIterable
          // prompt the CLI answers EVERY prompt (the initial task plus each
          // controller message delivered via the prompt iterator) with its own
          // result and keeps the session open until the iterable reports
          // done. Keep consuming so follow-up turns are actually processed
          // and the LAST result becomes the result of record; the stream ends
          // once buildPromptIterable returns done (a result arrived with
          // nothing queued — issue #15).
        }
      } finally {
        // The stream loop has exited (natural end, error, or abort). Reported
        // to the controller via get_worker_status so a hung-but-finished
        // worker is visible. Input is closed too — nothing can be delivered
        // to a dead session, so acceptMessage must fail from here on.
        this._streamEnded = true;
        this._inputClosed = true;
        // A progress debounce armed just before the exit would otherwise fire
        // ~500ms later, after the worker is gone — drop it. This covers every
        // exit path (natural end, abort, stream error).
        this.clearPendingProgress();
        // Steps still buffered (abort, CLI death mid-tool) must not vanish —
        // write them, marking tool calls that never got a result 'cancelled'.
        this.flushAllToolSteps();
      }
    } catch (err) {
      this.logger.error({ err, taskId: task.id }, 'ClaudeCodeWorker query error');
      // The run is dead (query setup or stream failure) — no input can be
      // delivered anymore.
      this._inputClosed = true;
      if (!this._terminalResult) {
        this._terminalResult = {
          status: 'failed',
          error: (err as { message?: string }).message ?? String(err),
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

    // Run over. Past this point the worker is idle (a multi-stage worker
    // accepts messages again — they fold into the next stage's prompt) or
    // about to be disposed by the engine.
    this._runInFlight = false;

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
    // Cancel the debounced progress now: the stream loop only notices the
    // abort on its next iteration, which may be long after the caller asked
    // for it (a parked SDK call).
    this.clearPendingProgress();
    this.permissionHandler.cleanup();
    this.flushMessageQueue();
  }

  /** Get state for UI rendering. */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * Live run flags (issue #16): `resultReceived` flips as soon as the SDK result
   * message lands, `streamEnded` when the message loop exits. The gap between
   * them is exactly the #15 window where the controller saw nothing.
   */
  getLiveStatus(): WorkerLiveStatus {
    return { resultReceived: this._terminalResult !== null, streamEnded: this._streamEnded };
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

  /**
   * Accept a message from the controller. The message is queued and handed
   * to the SDK only when it pulls the next prompt: the CLI parks pulled
   * prompts in an internal queue that it drains strictly BETWEEN turns, so
   * delivery always lands on a turn boundary — a tool call in progress is
   * never cut off (the v0.6 interrupt delivery did exactly that and killed
   * the session with an orphaned tool_use; see docs/develop/v0.6-design.md
   * §6.1 — the hazard is any unclosed tool_use, not just a pending
   * permission).
   *
   * Returns false when delivery is impossible: the run's input has closed
   * (final result received) or the worker was aborted. Idle multi-stage
   * workers (no run in flight) always accept — the next stage folds the
   * message into its opening prompt.
   */
  acceptMessage(message: string): boolean {
    if (this.abortController.signal.aborted) return false;
    if (this._runInFlight && this._inputClosed) return false;
    this._messageQueue.push(message);
    if (this._messageResolve) {
      this._messageResolve();
      this._messageResolve = null;
    }
    this.logger.info({ workerId: this.id }, 'Controller message accepted');
    return true;
  }

  /** Unread controller messages (non-destructive) — engine reports these when the run ends. */
  pendingMessages(): string[] {
    return [...this._messageQueue];
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

    return this._pendingPermissions.wait(requestId, ClaudeCodeWorker.PERMISSION_TIMEOUT_MS, () => {
      return { behavior: 'deny', message: 'Permission request timed out' } as PermissionResult;
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
            // Subsequent yields: controller messages from the queue.
            //
            // Boundary-delivery semantics: a message is handed over ONLY
            // when the SDK pulls the next prompt. The CLI pulls eagerly and
            // parks pulled prompts in an internal queue that it drains
            // strictly between turns — one full query (every tool_use →
            // tool_result cycle) per prompt — so handing a message over at
            // ANY time lands it at the next turn boundary and can never cut
            // a tool call in progress. There is deliberately no interrupt():
            // interrupting mid-tool_use aborts the turn with an orphaned
            // tool_use and the CLI kills the session with
            // error_during_execution (verified against the real CLI — see
            // docs/develop/v0.6-design.md §6.1).
            while (true) {
              if (this.abortController.signal.aborted) {
                this._inputClosed = true;
                return { value: undefined, done: true };
              }
              if (this._terminalResult) {
                // A result has arrived for the latest turn. A message that
                // raced in before the result was processed still gets its
                // own turn; with nothing pending the session is over —
                // return done so the SDK ends input and closes the child's
                // stdin (issue #15: parking here left the stream open and
                // the worker hung forever after its result).
                if (this._messageQueue.length === 0) {
                  this._inputClosed = true;
                  return { value: undefined, done: true };
                }
              } else if (this._messageQueue.length === 0) {
                // No result yet and nothing to deliver — park until a
                // controller message arrives or a result wakes us.
                await new Promise<void>((resolve) => {
                  this._messageResolve = resolve;
                });
                continue;
              }
              break; // queue non-empty → deliver at the next turn boundary
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
  private buildAskControllerMcpTool(): SdkMcpToolDefinition {
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
  private clearPendingProgress(): void {
    if (this._progressTimer) {
      clearTimeout(this._progressTimer);
      this._progressTimer = null;
    }
    this._pendingProgress = null;
  }

  private handleAssistantMessage(msg: SDKAssistantMessage, onProgress?: (msg: string) => void): void {
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
      }, ClaudeCodeWorker.PROGRESS_DEBOUNCE_MS);
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
  private flushAllToolSteps(): void {
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
