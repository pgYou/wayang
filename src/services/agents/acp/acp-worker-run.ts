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
import type { AcpHandshake, AcpMcpServer, AcpSessionUpdate, AcpTurnResult } from '@/services/acp/types';
import { recordPermissionAudit } from '@/services/permission/permission-audit';
import type { SignalQueue } from '@/services/signal/signal-queue';
import { BaseAcpWorker, findExecutableOnPath, type AcpPermissionContext, type AcpWorkerEnvView } from './base-acp-worker';
import { createAcpToolAccumulator, mapSessionUpdate, snapshotToToolCallRecord, type AcpMappedEvent } from './event-mapper';
import { ACP_PERMISSION_TIMEOUT_MS } from './permission-bridge';
import { advanceGuard, classifyTurnEnd, decideNextAction, resetTurnGuard, type CancelFact } from './turn-attribution';
import { buildReissuePrompt, finalizeTurnVerdict, joinControllerMessages, makeInjectedEntry, makeTerminalResult } from './acp-turn-prompt';
import {
  MCP_HANDSHAKE_TIMEOUT_MS,
  startStdioMcpTransport,
  type McpTransport,
  type StartMcpTransportOptions,
} from './mcp-transport';
import { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS, PROGRESS_FALLBACK_MS, capText } from './mcp-schemas';
import { createWayangMcpToolInvoker } from './mcp-tools';
import { McpProgressTracker, type ProgressPosition } from './mcp-progress-fallback';
import pkg from '@/../package.json';

/** Whitespace/punctuation-only text (e.g. a lone "。") is not progress. */
const PROGRESS_FILLER_RE = /[\s\p{P}]/gu;

/** True when the text still has substance once whitespace/punctuation are removed. */
function hasProgressSubstance(text: string): boolean {
  return text.replace(PROGRESS_FILLER_RE, '').length > 0;
}

export abstract class AcpWorkerRun extends BaseAcpWorker implements IWorkerInstance {
  /** Per-turn work counters feeding the guard's progressSig (#56). */
  private _turnTextChars = 0;
  private _turnToolCalls = 0;
  private _turnToolResults = 0;

  /**
   * Progress bookkeeping for the CURRENT message — scalars only, the text lives
   * in the turn writer's aggregation (AcpTurnWriter.openText). `_messageKey` is
   * the chunk's messageId (null when the agent sends none); `_messageOffset` is
   * how much of the open segment earlier messages of the same segment own.
   */
  private _messageKey: string | null = null;
  private _messageOffset = 0;
  /** Turn counter: the fallback key suffix when the agent sends no messageId. */
  private _turnSeq = 0;

  /** 120s idle fallback over the latest complete message (every run). */
  protected _mcpFallback: McpProgressTracker = new McpProgressTracker({
    canFire: () => this.progressGuardsOpen(),
    emit: (message) => this.reportProgress(message),
  });

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
    this._turnDenials = [];
    this._turnGuard = resetTurnGuard(Date.now());
    this._accumulator = createAcpToolAccumulator();
    this._turnWriter.reset();
    this._onProgress = onProgress ?? null;
    this._mcpAvailable = false;
    this._mcpTransport = null;
    this._mcpWarned = false;
    this._mcpFallback.setIdleMs(this.acpUserConfig().mcp?.fallbackMs ?? PROGRESS_FALLBACK_MS);
    this._turnSeq = 0;
    this._messageKey = null;
    this._messageOffset = 0;
    this.clearPendingProgress();
    // The idle tracker serves BOTH paths: with MCP it is the 120s safety net,
    // without MCP it is the only text-driven progress channel (02 §5).
    this._mcpFallback.start();

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
      // The MCP server descriptor is injected here; a rejection retries ONCE
      // with [] and degrades to the 500ms session/update debounce.
      const mcpServers = await this.prepareMcpHost();
      const sessionId = await this.openSession(client, handshake, transport, mcpServers);
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
          this.notePermissionDenial({
            source: 'policy',
            toolName: req.toolCall?.name ?? req.toolCall?.kind ?? 'unknown',
            reason: 'permissionMode "agent": protocol-level cancelled answer (no client-side control)',
            target: '',
            injectable: false,
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

      const unregisterUpdates = client.onUpdate((update) => this.handleSessionUpdate(update));

      try {
        // Step 7: guard-driven turn loop (#56). One session/prompt per turn;
        // queued controller messages are delivered all at once at a turn
        // boundary (ACP has no mid-turn injection, 01 §2.4).
        let promptText = `${buildThirdPartyPrompt(this.skills)}${task.description}`;
        const initialQueued = this._messageQueue.splice(0, this._messageQueue.length);
        if (initialQueued.length > 0) promptText += `\n\n${joinControllerMessages(initialQueued)}`;

        while (!this.abortController.signal.aborted) {
          const cancelBaseline = client.cancelSentCount;
          this.resetTurnProgress();
          this._turnSeq += 1;
          this._mcpFallback.noteNewMessage();
          const result: AcpTurnResult = await client.sessionPrompt(sessionId, [{ type: 'text', text: promptText }]);
          this._resultReceived = true;
          // Turn end closes the last message: its text is the writer's open
          // segment, so seal BEFORE settleTurn flushes it into the transcript.
          this.sealMessageSegment();
          this.settleTurn();
          this._mcpFallback.noteTurnEnd();
          // Degraded path: report a closed-but-unreported message right away
          // instead of waiting out the idle window (MCP runs keep the 120s rule).
          if (!this._mcpAvailable) this._mcpFallback.flush();

          const denials = this.takeTurnDenials();
          const cancelFact: CancelFact = client.cancelSentCount > cancelBaseline ? client.lastCancelReason : null;
          const hasQueuedMessages = this._messageQueue.length > 0;
          const category = classifyTurnEnd({ stopReason: result.stopReason, cancelFact, denials, hasQueuedMessages });
          const progressSig = this.progressSignature();
          // decideNextAction's perKey/consecutive/stagnant budgets are defined
          // against PRIOR turns (see turn-attribution.test.ts); advanceGuard
          // folds THIS turn's denials in, so decide on the pre-advance snapshot.
          const guardBefore = this._turnGuard;
          // P1.3 double insurance: never reissue when the denial notice is empty.
          const verdict = finalizeTurnVerdict(
            decideNextAction(guardBefore, category, hasQueuedMessages, denials), denials,
          );
          this._turnGuard = advanceGuard(guardBefore, { category, denials, progressSig, now: Date.now() });

          if (verdict.action === 'terminate') {
            this._inputClosed = true;
            this._terminalResult = makeTerminalResult(
              category, verdict.reason, denials,
              this._turnWriter.lastText() ?? '', result.stopReason,
            );
            break;
          }

          const queued = this._messageQueue.splice(0, this._messageQueue.length);
          if (verdict.action === 'reissue') {
            this._turnGuard.denialReissues += 1;
            promptText = buildReissuePrompt(denials, joinControllerMessages(queued));
          } else {
            promptText = joinControllerMessages(queued);
          }
          const injectedKind: 'acp-denial-notice' | 'controller-delivery' = verdict.action === 'reissue' ? 'acp-denial-notice' : 'controller-delivery';
          this.state.append('conversation', applyTurnEnvelope(makeInjectedEntry(promptText, injectedKind, this.ctx.sessionId), this._currentTurnEnv ?? undefined));
        }
      } finally {
        // Turn loop over — no fallback may fire after this point.
        this._mcpFallback.stop();
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
      await this.closeMcpTransport();
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
    void this.closeMcpTransport();
    this.permissionHandler.cleanup();
    const client = this._client;
    if (!client || !this._sessionId || this._terminalResult) return;
    this._cancelledAt = Date.now();
    client.sessionCancel(this._sessionId, 'abort');
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

  // --- MCP injection, fail-soft degradation and progress fallback ---

  /**
   * Transport factory — the ONLY seam between the worker run and the MCP
   * plumbing. Swapping the stdio bridge for an ACP v2 `acp` tunnel means
   * replacing this one call (plus capability detection), not the tool layer.
   * Overridable in tests to inject a fake transport.
   */
  protected createMcpTransport(opts: StartMcpTransportOptions): Promise<McpTransport> {
    return startStdioMcpTransport(opts);
  }

  private async prepareMcpHost(): Promise<AcpMcpServer[]> {
    if (this.acpUserConfig().mcp?.enabled === false) return [];
    // Tool semantics live in the invoker; the transport only carries frames.
    const invoker = createWayangMcpToolInvoker({
      workerId: this.id,
      logger: this.logger,
      onProgress: (message) => this.reportProgress(message),
      ask: (question, context) => this.mcpAsk(question, context),
    });
    try {
      const transport = await this.createMcpTransport({
        sessionDir: this.sessionDir,
        workerId: this.id,
        invoker,
        logger: this.logger,
        serverInfo: { name: 'wayang', version: pkg.version },
      });
      this._mcpTransport = transport;
      this._mcpAvailable = true;
      this.armMcpHandshakeWatchdog(transport);
      this.recordAcpRuntime({ mcpAvailable: true });
      this.logger.debug({ workerId: this.id, reason: 'mcp-injected' }, 'ACP MCP server injected');
      return [transport.descriptor];
    } catch (err) {
      this.warnMcpDegrade('transport-start-failed', err);
      return [];
    }
  }

  /** A session/new that succeeded with injection but no hello within 10s degrades. */
  private armMcpHandshakeWatchdog(transport: McpTransport): void {
    if (this._mcpHandshakeTimer) clearTimeout(this._mcpHandshakeTimer);
    const timer = setTimeout(() => {
      this._mcpHandshakeTimer = null;
      if (!this._mcpAvailable || this._streamEnded || this._terminalResult !== null) return;
      if (transport.isReady()) return;
      void this.degradeMcp('handshake-timeout');
    }, MCP_HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    this._mcpHandshakeTimer = timer;
  }

  /** Metadata-only warning: no token, path, question, answer or reply text. */
  private warnMcpDegrade(reason: string, err?: unknown): void {
    if (this._mcpWarned) return;
    this._mcpWarned = true;
    const rpcCode = err instanceof AcpError ? err.detail?.rpc?.code : undefined;
    this.logger.warn(
      { provider: this.config.type, workerId: this.id, reason, ...(rpcCode !== undefined && { rpcCode }), mcpAvailable: false },
      'ACP MCP injection degraded — session/update progress is the fallback',
    );
  }

  /** Disable MCP, stop every timer and shut the transport (and thus the bridge) down. */
  private async degradeMcp(reason: string, err?: unknown): Promise<void> {
    if (this._mcpAvailable) {
      this._mcpAvailable = false;
      // The idle tracker stays armed: after degradation session/update text is
      // the only progress source. Just restart its window.
      this._mcpFallback.noteNewMessage();
      this.recordAcpRuntime({ mcpAvailable: false });
    }
    await this.closeMcpTransport();
    this.warnMcpDegrade(reason, err);
  }

  private async closeMcpTransport(): Promise<void> {
    const transport = this._mcpTransport;
    this._mcpTransport = null;
    if (this._mcpHandshakeTimer) {
      clearTimeout(this._mcpHandshakeTimer);
      this._mcpHandshakeTimer = null;
    }
    if (!transport) return;
    try {
      await transport.close();
    } catch (err) {
      this.logger.debug({ workerId: this.id, err, reason: 'mcp-transport-close' }, 'ACP MCP transport close failed');
    }
  }

  /** The four guards: no progress after turn end / cancel / abort / agent exit. */
  private progressGuardsOpen(): boolean {
    return this._runInFlight
      && !this._inputClosed
      && !this.abortController.signal.aborted
      && !this._streamEnded
      && this._terminalResult === null
      && this._cancelledAt === null;
  }

  /**
   * Single choke point for real update_progress and the 120s fallback. Both
   * channels only restart the idle window — the MCP channel carries no id, so
   * it takes no part in the per-message dedupe.
   */
  private reportProgress(message: string): void {
    // Guard FIRST: a late tool call must not re-arm the fallback timer either.
    if (!this.progressGuardsOpen()) return;
    // A real report advances the watermark: everything produced so far counts
    // as announced, so the idle window must not re-announce it later.
    this._mcpFallback.noteProgress(this.progressPosition());
    this._onProgress?.(capText(message));
  }

  /** Where the run currently is in its own text stream (turn + chars so far). */
  private progressPosition(): ProgressPosition {
    return { turn: this._turnSeq, chars: this._turnTextChars };
  }

  /** ask_controller: same blocking engine channel as ClaudeCodeWorker, with an audit entry. */
  private async mcpAsk(question: string, context?: string): Promise<string> {
    const ask = this._askController;
    if (!ask || !this._mcpAvailable) {
      return '[UNAVAILABLE] The controller inquiry channel is not available for this worker.';
    }
    const q = capText(question, MAX_QUESTION_CHARS);
    const c = context === undefined ? undefined : capText(context, MAX_CONTEXT_CHARS);
    let answer: string;
    try {
      answer = await ask(q, c);
    } catch (err) {
      answer = `[UNAVAILABLE] ${err instanceof Error ? err.message : String(err)}`;
    }
    this.recordInquiryAudit(q, answer);
    return answer;
  }

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
    } as ConversationEntry, this._currentTurnEnv ?? undefined));
  }

  /**
   * session/new with the stderr login short-circuit: a stderr line hitting the
   * auth pattern rejects the race immediately (03 §2.2 — do not wait out the
   * timeout); every failure is then attributed through the isReady hook.
   *
   * fail-soft: if the call carrying mcpServers fails, retry ONCE with [].
   * auth-required / cancelled / transport-closed are never retried.
   */
  private async openSession(
    client: AcpClient,
    handshake: AcpHandshake,
    transport: AcpTransport,
    mcpServers: AcpMcpServer[],
  ): Promise<string> {
    try {
      return await this.trySessionNew(client, mcpServers);
    } catch (firstError) {
      if (mcpServers.length > 0 && this.mcpRetryable(firstError, handshake, transport)) {
        await this.degradeMcp('session-new-mcp-error', firstError);
        try {
          return await this.trySessionNew(client, []);
        } catch (secondError) {
          this.attributeSessionNewError(secondError, handshake, transport);
        }
      }
      this.attributeSessionNewError(firstError, handshake, transport);
    }
  }

  private async trySessionNew(client: AcpClient, mcpServers: AcpMcpServer[]): Promise<string> {
    const authHit = new Promise<never>((_, reject) => {
      this._sessionAuthHit = (line) =>
        reject(new AcpError('auth-required', `auth keyword on stderr during session/new: ${line}`, { stderrTail: [line] }));
    });
    // The race loser's rejection must not surface as an unhandled rejection.
    authHit.catch(() => undefined);
    try {
      const { sessionId } = await Promise.race([
        client.sessionNew({ cwd: this.workspaceDir, mcpServers }),
        authHit,
      ]);
      return sessionId;
    } finally {
      this._sessionAuthHit = null;
    }
  }

  private mcpRetryable(err: unknown, handshake: AcpHandshake, transport: AcpTransport): boolean {
    const readiness = this.isReady({ handshake, phase: 'session-new', error: err, stderrTail: transport.stderrTail() });
    if (!readiness.ready) return false;
    if (err instanceof AcpError && ['auth-required', 'cancelled', 'transport-closed'].includes(err.code)) return false;
    return true;
  }

  private attributeSessionNewError(err: unknown, handshake: AcpHandshake, transport: AcpTransport): never {
    const readiness = this.isReady({ handshake, phase: 'session-new', error: err, stderrTail: transport.stderrTail() });
    if (!readiness.ready) {
      throw new AcpError(readiness.kind ?? 'agent-error', readiness.message ?? 'agent not ready after session/new');
    }
    throw this.normalizeError(err, 'session-new');
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
  private handleSessionUpdate(update: AcpSessionUpdate): void {
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
    // A tool call ends the current assistant message even when the mapper
    // ignores that particular snapshot (first-snapshot / non-terminal-update).
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.sealMessageSegment();
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
        case 'agent-text': {
          // A new messageId closes the previous message. The writer keeps
          // aggregating the text; the progress layer only tracks the boundary.
          const messageKey = event.messageId !== null && event.messageId.length > 0 ? event.messageId : null;
          if (messageKey !== null && this._messageKey !== null && this._messageKey !== messageKey) {
            this.sealMessageSegment();
          }
          if (messageKey !== null && this._messageKey === null) this._messageKey = messageKey;
          this._turnWriter.addText(event.text);
          this._turnTextChars += event.text.length;
          break;
        }
        case 'tool-call':
          this._sawToolCall = true;
          this._turnWriter.addToolCall(event.record);
          this._turnToolCalls += 1;
          break;
        case 'tool-result':
          this._turnWriter.addToolResult(event.record);
          this._turnToolResults += 1;
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

  private resetTurnProgress(): void { this._turnTextChars = 0; this._turnToolCalls = 0; this._turnToolResults = 0; }
  private progressSignature(): string { return `${this._turnTextChars}:${this._turnToolCalls}:${this._turnToolResults}`; }

  /** Turn settled: flush the accumulator's unsettled calls, then the writer. */
  private settleTurn(): void {
    for (const snapshot of this._accumulator.flushUnsettled()) {
      this._turnWriter.addToolCall(snapshotToToolCallRecord(snapshot));
    }
    this._turnWriter.finishTurn();
  }

  /**
   * A message closed (new messageId, tool call, turn end). Its text is the turn
   * writer's own aggregation — this layer keeps no copy, only the boundary
   * scalars — and is handed to the idle tracker as "latest complete message".
   * Sealing NEVER emits a signal: progress is reported only when the idle
   * window expires or, on the degraded path, at turn end.
   */
  private sealMessageSegment(): void {
    const open = this._turnWriter.openText();
    // The segment was flushed (tool call / turn end) — the window restarts.
    if (open.length < this._messageOffset) this._messageOffset = 0;
    const text = open.slice(this._messageOffset);
    this._messageOffset = open.length;
    // No messageId → turn number + text length is enough for the scalar compare.
    const key = this._messageKey ?? `turn-${this._turnSeq}#${text.length}`;
    this._messageKey = null;
    if (!this.progressGuardsOpen()) return;
    if (!hasProgressSubstance(text)) return;
    this._mcpFallback.noteMessageSealed(key, text, this.progressPosition());
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
