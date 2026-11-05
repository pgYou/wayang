// ClaudeWorkerRun: the SDK query() run loop — per-run reset, prompt
// iterable (controller-message boundary delivery), the ask_controller MCP
// tool, abort. Extends ClaudeWorkerStream.

import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SdkMcpToolDefinition, Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { TaskDetail, WorkerResult } from '@/types/index';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { applyTurnEnvelope } from '../utils/entry-envelope';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { buildThirdPartyPrompt } from '../prompts/index';
import { ClaudeWorkerStream } from './worker-stream';

/** Stream-close timeout for SDK MCP calls — must exceed the 5-min inquiry timeout. */
const INQUIRY_STREAM_CLOSE_TIMEOUT_MS = 360_000;

export class ClaudeWorkerRun extends ClaudeWorkerStream {
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

  abort(): void {
    this.abortController.abort();
    // Cancel the debounced progress now: the stream loop only notices the
    // abort on its next iteration, which may be long after the caller asked
    // for it (a parked SDK call).
    this.clearPendingProgress();
    this.permissionHandler.cleanup();
    this.flushMessageQueue();
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
}
