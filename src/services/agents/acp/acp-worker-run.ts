/**
 * AcpWorkerRun — the run()/abort() lifecycle of the ACP skeleton (02 §3,
 * fixed order). Extends BaseAcpWorker; provider classes extend THIS class.
 *
 * run(): preflight → buildLaunch → spawn → initialize → isReady(handshake)
 * → session/new (stderr auth short-circuit) → permission/update wiring →
 * turn loop (session/prompt; queued controller messages delivered at turn
 * boundaries) → stopReason mapping → close (idempotent) → result entry.
 *
 * abort(): sessionCancel (the client auto-answers pending permissions
 * 'cancelled' — protocol MUST) → wait for settle within cancelGraceMs →
 * client.close('cancel') rides the transport's SIGTERM→SIGKILL ladder.
 */

import type { TaskDetail, WorkerResult } from '@/types/index';
import type { IWorkerInstance } from '@/types/worker';
import type { ConversationEntry } from '@/types/conversation';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { homedir } from 'node:os';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import { buildThirdPartyPrompt } from '../prompts/index';
import { applyTurnEnvelope } from '../utils/entry-envelope';
import { AcpClient, buildAcpCapabilities } from '@/services/acp/client';
import { StdioAcpTransport, type AcpTransport } from '@/services/acp/transport';
import { AcpError, acpUserMessage } from '@/services/acp/errors';
import { AUTH_STDERR_PATTERN } from '@/services/acp/codec';
import { resolveAcpTimeouts, type AcpLaunchConfig } from '@/services/acp/config';
import type { AcpHandshake, AcpSessionUpdate, AcpTurnResult } from '@/services/acp/types';
import { recordPermissionAudit } from '@/services/permission/permission-audit';
import type { SignalQueue } from '@/services/signal/signal-queue';
import { BaseAcpWorker, findExecutableOnPath, type AcpPermissionContext, type AcpWorkerEnvView } from './base-acp-worker';
import { createAcpToolAccumulator, mapSessionUpdate, snapshotToToolCallRecord, type AcpMappedEvent } from './event-mapper';
import { ACP_PERMISSION_TIMEOUT_MS } from './permission-bridge';
import pkg from '@/../package.json';

/** Progress debounce (02 §5): aligned with the claude-code worker's 500ms. */
const PROGRESS_DEBOUNCE_MS = 500;

export abstract class AcpWorkerRun extends BaseAcpWorker implements IWorkerInstance {
  async run(
    task: TaskDetail & { workerId: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IWorkerInstance.run's tools param (public interface)
    _tools: Record<string, any>,
    onProgress?: (msg: string) => void,
  ): Promise<WorkerResult> {
    // Per-run reset (a multi-stage worker's run() may be called again).
    this._terminalResult = null;
    this._streamEnded = false;
    this._resultReceived = false;
    this._inputClosed = false;
    this._runInFlight = true;
    this._cancelledAt = null;
    this._discardedAfterCancel = 0;
    this._handshake = null;
    this._sawToolCall = false;
    this._sawPermissionRequest = false;
    this._accumulator = createAcpToolAccumulator();
    this._turnWriter.reset();

    this.state.set('runtimeState.task', { id: task.id, description: task.description });
    const turnEnv = this.buildTurnEnv(task);
    this._currentTurnEnv = turnEnv;

    // Initial user entry — the orchestration engine writes the task prompt.
    const promptTs = nowISO();
    this.state.append('conversation', applyTurnEnvelope({
      type: EEntryType.User,
      uuid: generateId('u'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: promptTs,
      actor: { kind: 'system', id: 'engine', taskId: task.id },
      endedAt: promptTs,
      message: { role: 'user', content: task.description },
    } as ConversationEntry, turnEnv));

    let client: AcpClient | null = null;
    try {
      // Steps 1–2: stop policy + protocol overrides → timeouts; buildLaunch.
      const policy = this.stopPolicy();
      const userCfg = this.acpUserConfig();
      const timeouts = resolveAcpTimeouts({
        ...userCfg.protocol,
        cancelGraceMs: userCfg.protocol?.cancelGraceMs ?? policy.cancelGraceMs,
        sigtermWaitMs: userCfg.protocol?.sigtermWaitMs ?? policy.sigtermWaitMs,
      });
      const view: AcpWorkerEnvView = {
        // Frozen §2.1: merging with process.env is the worker layer's job.
        // (process.env values are `string | undefined`; undefined entries are
        // dropped so the child env stays Record<string, string>.)
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...userCfg.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        command: userCfg.command,
        args: userCfg.args,
        timeouts,
        cwd: this.workspaceDir,
      };
      const launch = this.buildLaunch(view);
      this._launchCommand = launch.command;

      // Step 1 (preflight): resolve the command before spawning — the
      // protocol layer folds spawn ENOENT/EACCES/ENOEXEC into cli-missing too
      // (double insurance, frozen §2.2).
      if (findExecutableOnPath(launch.command) === undefined) {
        throw new AcpError('cli-missing', `command not found on PATH: ${launch.command}`);
      }

      // Steps 3–4: spawn + initialize.
      const transport = this.createTransport(launch);
      await transport.start();
      client = new AcpClient(transport, {
        clientInfo: { name: 'wayang', version: pkg.version },
        timeouts: launch.timeouts,
        stderrSink: (line) => this.handleStderrLine(line),
      });
      this._client = client;
      const handshake = await client.initialize();
      this._handshake = handshake;

      // Step 5: readiness right after the handshake.
      const postHandshake = this.isReady({ handshake, phase: 'handshake', stderrTail: transport.stderrTail() });
      if (!postHandshake.ready) {
        throw new AcpError(postHandshake.kind ?? 'agent-error', postHandshake.message ?? 'agent not ready');
      }

      // Step 6: session/new, with the stderr auth short-circuit (03 §2.2).
      const sessionId = await this.openSession(client, handshake, transport);
      this._sessionId = sessionId;

      // pid evidence for orphan hunting (02 §3; 0.9.0 records, does not clean up).
      this.recordAcpRuntime({ pid: transport.pid, command: launch.command, provider: this.config.type });

      // Permission wiring (04 §6): 'client' (default) walks the full bridge;
      // 'agent' deliberately skips client-side control — a request that still
      // arrives is answered cancelled + audited, never silently allowed.
      const unregisterPermission = client.onPermissionRequest(async (req) => {
        this._sawPermissionRequest = true;
        if (userCfg.permissionMode === 'agent') {
          this.logger.warn(
            { provider: this.config.type, toolCallId: req.toolCall?.toolCallId },
            'permissionMode "agent": request_permission received and answered cancelled (no client-side control)',
          );
          recordPermissionAudit(this.logger, {
            decision: 'denied',
            operation: 'exec',
            taskId: this._runContext?.taskId,
            workerId: this._runContext?.workerId,
            toolName: req.toolCall?.name ?? req.toolCall?.kind ?? 'unknown',
            transport: 'acp',
            provider: this.config.type,
          });
          return { outcome: 'cancelled' };
        }
        const acpCtx: AcpPermissionContext = {
          accumulator: this._accumulator,
          scope: this._accessScope ?? { userHome: homedir(), workspace: this.workspaceDir },
          signalQueue: this._signalQueue ?? this.fallbackSignalQueue(),
          runContext:
            this._runContext ?? { workerId: this.id, taskId: task.id, taskTitle: task.title, workerType: this.config.type },
          turnLineage: this._turnLineage,
          grants: this._grants,
          approvalMemory: this._approvalMemory,
          permissionMs: timeouts.permissionMs ?? ACP_PERMISSION_TIMEOUT_MS,
        };
        return this.mapPermission(req, acpCtx);
      });

      const unregisterUpdates = client.onUpdate((update) => this.handleSessionUpdate(update, onProgress));

      try {
        // Step 7: the turn loop. First prompt = task prompt (+ idle-period
        // messages folded in); later turns deliver queued controller messages
        // at turn boundaries (ACP has no mid-turn injection, 01 §2.4).
        let promptText = `${buildThirdPartyPrompt(this.skills)}${task.description}`;
        const leftovers = this._messageQueue.splice(0, this._messageQueue.length);
        if (leftovers.length > 0) {
          promptText += `\n\n${leftovers.map((m) => `[Controller message] ${m}`).join('\n\n')}`;
        }

        while (!this.abortController.signal.aborted) {
          const result: AcpTurnResult = await client.sessionPrompt(sessionId, [{ type: 'text', text: promptText }]);
          this._resultReceived = true;
          this.settleTurn();

          if (result.stopReason === 'end_turn') {
            const summary = this._turnWriter.lastText() ?? '';
            if (this._messageQueue.length > 0) {
              promptText = `[Controller message] ${this._messageQueue.shift()!}`;
              continue;
            }
            this._inputClosed = true;
            this._terminalResult = { status: 'completed', summary };
            break;
          }
          // cancelled / max_tokens / max_turn_requests / refusal (02 §4).
          this._inputClosed = true;
          this._terminalResult =
            result.stopReason === 'cancelled'
              ? { status: 'failed', error: 'Aborted' }
              : {
                  status: 'failed',
                  error: acpUserMessage('agent-error', { provider: this.config.type, stopReason: result.stopReason }),
                };
          break;
        }
      } finally {
        unregisterUpdates();
        unregisterPermission();
      }
    } catch (err) {
      this._inputClosed = true;
      const acpError = this.normalizeError(err, 'prompt');
      if (!this._terminalResult) {
        const aborted = this.abortController.signal.aborted;
        this._terminalResult = {
          status: 'failed',
          error:
            aborted && (acpError.code === 'cancelled' || acpError.code === 'transport-closed')
              ? 'Aborted'
              : this.userFacingError(acpError),
        };
      }
    } finally {
      this._streamEnded = true;
      this.clearPendingProgress();
      if (this._cancelGraceTimer) {
        clearTimeout(this._cancelGraceTimer);
        this._cancelGraceTimer = null;
      }
      // Step 9: close (idempotent) — 'cancel' on the abort path so the
      // transport's kill ladder is attributed to a cancellation.
      if (client) {
        try {
          await client.close(this.abortController.signal.aborted ? 'cancel' : 'run-finished');
        } catch (closeErr) {
          this.logger.debug({ err: closeErr, workerId: this.id }, 'ACP client close failed');
        }
      }
      this._client = null;
      this._sessionAuthHit = null;
    }

    if (!this._terminalResult) {
      this._terminalResult = {
        status: 'failed',
        error: this.abortController.signal.aborted ? 'Aborted' : 'No result received from the ACP agent',
      };
    }

    this.permissionHandler.cleanup();
    this.writeResultEntry();
    this._runInFlight = false;
    return this._terminalResult;
  }

  /**
   * Abort (frozen §6): cancel the session (the client simultaneously answers
   * every pending permission 'cancelled' — protocol MUST), then arm the grace
   * ladder: settle within cancelGraceMs, or the client is closed on the cancel
   * path, which rides the transport's SIGTERM → sigtermWaitMs → SIGKILL.
   */
  abort(): void {
    this.abortController.abort();
    this.clearPendingProgress();
    this.permissionHandler.cleanup();
    const client = this._client;
    if (!client || !this._sessionId || this._terminalResult) return;
    this._cancelledAt = Date.now();
    client.sessionCancel(this._sessionId);
    const policy = this.stopPolicy();
    this.logger.warn(
      { workerId: this.id, cancelGraceMs: policy.cancelGraceMs },
      'ACP worker aborted — session cancelled, waiting for settle',
    );
    this._cancelGraceTimer = setTimeout(() => {
      this._cancelGraceTimer = null;
      this.logger.warn({ workerId: this.id }, 'ACP cancel grace elapsed without settle — closing (SIGTERM ladder)');
      void client.close('cancel').catch(() => undefined);
    }, policy.cancelGraceMs);
  }

  // --- Internals ---

  /**
   * session/new with the stderr login short-circuit: a stderr line hitting the
   * auth pattern rejects the race immediately (03 §2.2 — do not wait out the
   * timeout); every failure is then attributed through the isReady hook.
   */
  private async openSession(client: AcpClient, handshake: AcpHandshake, transport: AcpTransport): Promise<string> {
    const authHit = new Promise<never>((_, reject) => {
      this._sessionAuthHit = (line) =>
        reject(new AcpError('auth-required', `auth keyword on stderr during session/new: ${line}`, { stderrTail: [line] }));
    });
    // The race loser's rejection must not surface as an unhandled rejection.
    authHit.catch(() => undefined);
    try {
      const { sessionId } = await Promise.race([
        client.sessionNew({ cwd: this.workspaceDir, mcpServers: [] }),
        authHit,
      ]);
      return sessionId;
    } catch (err) {
      const readiness = this.isReady({ handshake, phase: 'session-new', error: err, stderrTail: transport.stderrTail() });
      if (!readiness.ready) {
        throw new AcpError(readiness.kind ?? 'agent-error', readiness.message ?? 'agent not ready after session/new');
      }
      throw this.normalizeError(err, 'session-new');
    } finally {
      this._sessionAuthHit = null;
    }
  }

  private handleStderrLine(line: string): void {
    this._stderrLines.push(line);
    if (this._stderrLines.length > 50) this._stderrLines.shift();
    this.logger.debug({ workerId: this.id }, `[acp stderr] ${line}`);
    if (this._sessionAuthHit && AUTH_STDERR_PATTERN.test(line)) {
      this._sessionAuthHit(line);
    }
  }

  /** Route one session/update through the mapper and persist/forward the result. */
  private handleSessionUpdate(update: AcpSessionUpdate, onProgress?: (msg: string) => void): void {
    // Late updates after a cancel (frozen §6.4): the client keeps delivering;
    // dropping is THIS layer's policy call.
    if (this._cancelledAt !== null && !this.stopPolicy().trustUpdatesAfterCancel) {
      this._discardedAfterCancel += 1;
      this.logger.debug(
        { workerId: this.id, discarded: this._discardedAfterCancel, variant: update.sessionUpdate },
        'session/update discarded after cancel (stopPolicy.trustUpdatesAfterCancel=false)',
      );
      return;
    }
    let events: AcpMappedEvent[];
    try {
      events = mapSessionUpdate(update, this._accumulator);
    } catch (err) {
      // A throwing mapper must not break the client's read loop (the client
      // only debug-counts handler errors; we log and drop the update).
      this.logger.error({ err, workerId: this.id, variant: update.sessionUpdate }, 'ACP event mapping failed');
      return;
    }
    for (const event of events) {
      switch (event.kind) {
        case 'agent-text':
          this._turnWriter.addText(event.text);
          break;
        case 'progress':
          this.emitDebouncedProgress(event.text, onProgress);
          break;
        case 'tool-call':
          this._sawToolCall = true;
          this._turnWriter.addToolCall(event.record);
          break;
        case 'tool-result':
          this._turnWriter.addToolResult(event.record);
          break;
        case 'runtime-state':
          this.recordAcpRuntime({ [event.key]: event.value });
          break;
        case 'ignored':
          this.logger.debug({ workerId: this.id, variant: event.variant, reason: event.reason }, 'session/update ignored');
          break;
      }
    }
  }

  /** Turn settled: flush the accumulator's unsettled calls, then the writer. */
  private settleTurn(): void {
    for (const snapshot of this._accumulator.flushUnsettled()) {
      this._turnWriter.addToolCall(snapshotToToolCallRecord(snapshot));
    }
    this._turnWriter.finishTurn();
  }

  /** Progress debounce (02 §5): 500ms, dropped once the run is over. */
  private emitDebouncedProgress(text: string, onProgress?: (msg: string) => void): void {
    if (!onProgress) return;
    this._pendingProgress = text.slice(0, 200);
    if (this._progressTimer) clearTimeout(this._progressTimer);
    this._progressTimer = setTimeout(() => {
      this._progressTimer = null;
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
    }, PROGRESS_DEBOUNCE_MS);
  }

  /** Display-ready error text with the full context (frozen §2.5 acpUserMessage). */
  private userFacingError(err: AcpError): string {
    return acpUserMessage(err.code, {
      command: this._launchCommand,
      provider: this.config.type,
      authMethods: this._handshake?.authMethods.map((method) => method.name) ?? [],
      reason: err.message,
      rpc: err.detail?.rpc,
      exit: err.detail?.exit,
      stderrTail: err.detail?.stderrTail,
    });
  }

  /** Final System/TaskResult|Error entry (aligned with the claude-code worker). */
  private writeResultEntry(): void {
    if (!this._terminalResult) return;
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
    } as ConversationEntry, this._currentTurnEnv ?? undefined));
  }

  /**
   * Direct construction (tests, standalone use) has no engine wiring — a
   * queue that only logs keeps mapPermission from crashing on a null queue.
   */
  private fallbackSignalQueue(): SignalQueue {
    const logger = this.logger;
    return {
      enqueue(sig: { type: string }) {
        logger.warn({ type: sig.type }, 'ACP worker emitted a signal without an engine signal queue');
      },
    } as unknown as SignalQueue;
  }

  /** Transport factory — production spawns StdioAcpTransport; tests inject a fake. */
  protected createTransport(config: AcpLaunchConfig): AcpTransport {
    return new StdioAcpTransport(config);
  }

  /** Capability observation snapshot for diagnostics/tests (02 §6). */
  get observedCapabilities(): ReturnType<typeof buildAcpCapabilities> | null {
    return this.getCapabilities();
  }
}
