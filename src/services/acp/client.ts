/**
 * ACP JSON-RPC client over a transport.
 *
 * Contract: docs/design/acp/00-interface-freeze.md §2.4 + §6. Peer rules:
 * auto-increment integer request ids, out-of-order responses matched by id,
 * notifications never create pending entries, peer requests for unknown
 * methods get -32601, a throwing permission handler gets -32603, and the
 * `$/cancel_request` notification is received but not processed (wayang only
 * cancels through `session/cancel`). Generic JSON-RPC mechanics live in the
 * internal json-rpc.ts, pure parsing in codec.ts, permission response
 * plumbing in permission-responder.ts.
 *
 * No-hanging-promise guarantee: every request settles through a response, its
 * own timeout, a fatal protocol error, transport close, or client close.
 */

import { ACP_JSONRPC_ERROR, resolveAcpTimeouts, type AcpTimeouts } from './config';
import { AcpError } from './errors';
import {
  AUTH_STDERR_PATTERN,
  KNOWN_SESSION_UPDATE_VARIANTS,
  ACP_PROTOCOL_VERSION,
  normalizeClientCapabilities,
  parseHandshake,
  parseTurnResult,
} from './codec';
import { JsonRpcPeer, JsonRpcRequestFailure } from './json-rpc';
import { AcpPermissionResponder } from './permission-responder';
import { onStderrIfAvailable, type AcpTransport } from './transport';
import type {
  AcpClientCapabilities,
  AcpCloseReason,
  AcpContentBlock,
  AcpExitInfo,
  AcpHandshake,
  AcpMcpServer,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpSessionUpdate,
  AcpTurnResult,
} from './types';

// Frozen §2.4 helper exports (defined in codec.ts; re-exported to keep the
// frozen import surface on client.ts).
export { buildAcpCapabilities, selectAllowOption, selectRejectOption } from './codec';

const SESSION_NEW_TAG = 'session/new';
const DEFAULT_NON_JSON_LIMIT = 50;
const DEFAULT_UNKNOWN_VARIANT_LIMIT = 50;

export interface AcpClientOptions {
  clientInfo: { name: string; version: string };
  /** Defaults to all-false: fs{readTextFile,writeTextFile:false}, terminal:false, auth{terminal:false}. */
  clientCapabilities?: AcpClientCapabilities;
  timeouts: AcpTimeouts;
  /** Log-only stderr tap; never enters the transcript. */
  stderrSink?: (line: string) => void;
  /** Consecutive non-JSON stdout line threshold, default 50 → AcpError('protocol-mismatch'). */
  nonJsonLimit?: number;
  /** Consecutive unknown sessionUpdate variant threshold, default 50 → AcpError('protocol-mismatch'). */
  unknownVariantLimit?: number;
}

/** Beyond freeze (see delivery report): observable debug counters for "drop and record" paths. */
export interface AcpClientStats {
  unknownResponseIds: number;
  nonJsonLines: number;
  unknownVariants: number;
  emptyLines: number;
  handlerErrors: number;
  readLoopErrors: number;
  latePermissionOutcomes: number;
  peerRequests: number;
  unansweredPeerMethods: number;
  cancelRequestNotifications: number;
  unknownNotifications: number;
  streamErrors: number;
}

interface PromptTracking {
  sessionId: string;
  requestId: number;
  cancelTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
}

export class AcpClient {
  private readonly transport: AcpTransport;
  private readonly options: AcpClientOptions;
  private readonly timeouts: AcpTimeouts;
  private readonly clientCapabilities: AcpClientCapabilities;
  private readonly nonJsonLimit: number;
  private readonly unknownVariantLimit: number;
  private readonly unsubscribes: Array<() => void>;
  private readonly peer: JsonRpcPeer;
  private readonly permissionResponder: AcpPermissionResponder;

  private readonly activePrompts = new Map<string, PromptTracking>();
  private readonly updateHandlers = new Set<(update: AcpSessionUpdate) => void>();

  private nonJsonStreak = 0;
  private unknownVariantStreak = 0;
  private fatalError: AcpError | null = null;
  private closedInfo: AcpExitInfo | null = null;
  private handshake: AcpHandshake | null = null;

  private readonly statsValue: AcpClientStats = {
    unknownResponseIds: 0,
    nonJsonLines: 0,
    unknownVariants: 0,
    emptyLines: 0,
    handlerErrors: 0,
    readLoopErrors: 0,
    latePermissionOutcomes: 0,
    peerRequests: 0,
    unansweredPeerMethods: 0,
    cancelRequestNotifications: 0,
    unknownNotifications: 0,
    streamErrors: 0,
  };

  constructor(transport: AcpTransport, options: AcpClientOptions) {
    this.transport = transport;
    this.options = options;
    this.timeouts = resolveAcpTimeouts(options.timeouts);
    this.clientCapabilities = normalizeClientCapabilities(options.clientCapabilities);
    this.nonJsonLimit =
      options.nonJsonLimit !== undefined && options.nonJsonLimit > 0 ? options.nonJsonLimit : DEFAULT_NON_JSON_LIMIT;
    this.unknownVariantLimit =
      options.unknownVariantLimit !== undefined && options.unknownVariantLimit > 0
        ? options.unknownVariantLimit
        : DEFAULT_UNKNOWN_VARIANT_LIMIT;
    this.peer = new JsonRpcPeer({
      write: (line) => this.transport.write(line),
      onPeerRequest: (id, method, params) => this.handlePeerRequest(id, method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
      onUnknownResponseId: () => {
        this.statsValue.unknownResponseIds += 1;
      },
      onReadError: () => {
        this.statsValue.readLoopErrors += 1;
      },
    });
    this.permissionResponder = new AcpPermissionResponder(this.peer, this.timeouts.permissionMs, {
      onLateOutcome: () => {
        this.statsValue.latePermissionOutcomes += 1;
      },
    });
    this.unsubscribes = [
      transport.onMessage((line) => this.handleLine(line)),
      transport.onClose((info) => this.handleTransportClose(info)),
      transport.onError((err) => this.handleTransportError(err)),
      onStderrIfAvailable(transport, (line) => this.handleStderrLine(line)),
    ];
  }

  get stats(): AcpClientStats {
    return this.statsValue;
  }

  /**
   * Send initialize{protocolVersion:1}. Timeout → 'handshake-timeout';
   * a returned version other than 1 → 'protocol-mismatch'. On any failure the
   * transport is closed first, then the error is rethrown (no orphans).
   */
  async initialize(): Promise<AcpHandshake> {
    try {
      const raw = await this.rpcRequest(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: this.clientCapabilities,
          clientInfo: this.options.clientInfo,
        },
        this.timeouts.handshakeMs,
        () =>
          new AcpError('handshake-timeout', `initialize: no response within ${this.timeouts.handshakeMs}ms`, {
            stderrTail: this.transport.stderrTail(),
            seconds: Math.ceil(this.timeouts.handshakeMs / 1000),
          }),
      );
      this.handshake = parseHandshake(raw);
      return this.handshake;
    } catch (err) {
      try {
        await this.close('shutdown');
      } catch {
        // Best effort — surface the original failure.
      }
      throw err;
    }
  }

  /** Protocol primitive; the 0.9.0 worker layer never calls it (login attribution goes through §4 auth-required). */
  async authenticate(methodId: string): Promise<void> {
    await this.rpcRequest(
      'authenticate',
      { methodId },
      this.timeouts.handshakeMs,
      () => new AcpError('agent-error', `authenticate(${methodId}): no response within ${this.timeouts.handshakeMs}ms`),
    );
  }

  /** mcpServers is required by the v1 schema; 0.9.0 always passes []. Unknown response fields are ignored. */
  async sessionNew(input: { cwd: string; mcpServers: AcpMcpServer[] }): Promise<{ sessionId: string }> {
    const raw = await this.rpcRequest(
      'session/new',
      { cwd: input.cwd, mcpServers: input.mcpServers },
      this.timeouts.sessionNewMs,
      () => this.sessionNewTimeoutError(),
      SESSION_NEW_TAG,
    );
    const sessionId = (raw as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AcpError('protocol-mismatch', 'session/new response is missing sessionId', {
        reason: 'session/new 响应缺少 sessionId',
      });
    }
    return { sessionId };
  }

  /** Serial per session: calling again before the previous turn settles → AcpError('protocol-mismatch'). */
  async sessionPrompt(sessionId: string, blocks: AcpContentBlock[]): Promise<AcpTurnResult> {
    this.assertUsable();
    if (this.activePrompts.has(sessionId)) {
      throw new AcpError('protocol-mismatch', `session/prompt already in flight for session ${sessionId}`);
    }
    const { id, promise } = this.peer.request('session/prompt', { sessionId, prompt: blocks });
    const tracking: PromptTracking = { sessionId, requestId: id, cancelTimer: null, graceTimer: null };
    this.activePrompts.set(sessionId, tracking);
    if (this.timeouts.promptMs > 0) {
      tracking.cancelTimer = setTimeout(() => this.beginCancel(tracking), this.timeouts.promptMs);
    }
    return promise
      .then(
        (result) => parseTurnResult(result),
        (err) => this.mapPromptFailure(err),
      )
      .finally(() => this.settlePrompt(tracking));
  }

  /** Fire-and-forget notification; also immediately answers every pending request_permission with outcome 'cancelled' (protocol MUST). */
  sessionCancel(sessionId: string): void {
    this.writeMessage({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    this.permissionResponder.cancelAll();
  }

  /** Sync callbacks; a throwing handler is debug-counted and never breaks the read loop. */
  onUpdate(handler: (update: AcpSessionUpdate) => void): () => void {
    this.updateHandlers.add(handler);
    return () => {
      this.updateHandlers.delete(handler);
    };
  }

  /** The handler must return an outcome; the client writes the JSON-RPC response. */
  onPermissionRequest(handler: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>): () => void {
    this.permissionResponder.setHandler(handler);
    // Only detach THIS registration: a later registration must survive an
    // earlier teardown (no unconditional setHandler(null)).
    return () => this.permissionResponder.clearIfCurrent(handler);
  }

  /** Delegates to transport.close after settling pending: permissions → cancelled, requests → AcpError (cancel path → 'cancelled'). */
  async close(reason: AcpCloseReason): Promise<AcpExitInfo> {
    const error =
      this.fatalError ??
      (reason === 'cancel'
        ? new AcpError('cancelled', 'client closed on the cancel path')
        : new AcpError('transport-closed', 'client closed'));
    this.settleEverything(error);
    const info = await this.transport.close({ sigtermWaitMs: this.timeouts.sigtermWaitMs, reason });
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    return info;
  }

  // --- request plumbing ---

  private async rpcRequest(
    method: string,
    params: unknown,
    timeoutMs: number,
    onTimeout: () => AcpError,
    tag?: string,
  ): Promise<unknown> {
    this.assertUsable();
    const { promise } = this.peer.request(method, params, { timeoutMs, onTimeout, tag });
    try {
      return await promise;
    } catch (err) {
      throw this.mapRequestFailure(method, err);
    }
  }

  private mapRequestFailure(method: string, err: unknown): AcpError {
    if (err instanceof AcpError) return err;
    if (err instanceof JsonRpcRequestFailure) {
      return new AcpError('agent-error', `${method} failed: ${err.message}`, {
        rpc: { code: err.code, message: err.message },
      });
    }
    return new AcpError('transport-closed', err instanceof Error ? err.message : String(err));
  }

  private mapPromptFailure(err: unknown): never {
    if (err instanceof JsonRpcRequestFailure) {
      const rpc = { code: err.code, message: err.message };
      if (err.code === ACP_JSONRPC_ERROR.requestCancelled) {
        throw new AcpError('cancelled', `session/prompt cancelled by agent: ${err.message}`, { rpc });
      }
      throw new AcpError('agent-error', `session/prompt failed: ${err.message}`, { rpc });
    }
    if (err instanceof AcpError) throw err;
    throw new AcpError('transport-closed', err instanceof Error ? err.message : String(err));
  }

  private writeMessage(message: unknown): void {
    this.transport.write(JSON.stringify(message));
  }

  private assertUsable(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.closedInfo) {
      throw new AcpError('transport-closed', 'transport already closed', { exit: this.closedInfo });
    }
  }

  private beginCancel(tracking: PromptTracking): void {
    tracking.cancelTimer = null;
    this.sessionCancel(tracking.sessionId);
    tracking.graceTimer = setTimeout(() => {
      tracking.graceTimer = null;
      this.peer.rejectById(
        tracking.requestId,
        new AcpError('cancelled', `session/prompt cancel grace ${this.timeouts.cancelGraceMs}ms elapsed without settle`),
      );
    }, this.timeouts.cancelGraceMs);
  }

  private settlePrompt(tracking: PromptTracking): void {
    if (tracking.cancelTimer) {
      clearTimeout(tracking.cancelTimer);
      tracking.cancelTimer = null;
    }
    if (tracking.graceTimer) {
      clearTimeout(tracking.graceTimer);
      tracking.graceTimer = null;
    }
    this.activePrompts.delete(tracking.sessionId);
  }

  /** Settle every pending request and permission request with `error` / 'cancelled'. */
  private settleEverything(error: AcpError): void {
    for (const tracking of [...this.activePrompts.values()]) this.settlePrompt(tracking);
    this.peer.rejectAll(error);
    this.permissionResponder.cancelAll();
  }

  // --- inbound handling ---

  private handleLine(line: string): void {
    const outcome = this.peer.handleLine(line);
    if (outcome.kind === 'empty') {
      this.statsValue.emptyLines += 1;
      return;
    }
    if (outcome.kind === 'invalid') {
      this.registerNonJson(outcome.detail);
      return;
    }
    this.nonJsonStreak = 0;
  }

  private registerNonJson(detail?: string): void {
    this.statsValue.nonJsonLines += 1;
    this.nonJsonStreak += 1;
    if (this.nonJsonStreak >= this.nonJsonLimit) {
      this.tripFatal(
        new AcpError(
          'protocol-mismatch',
          `${this.nonJsonStreak} consecutive non-JSON stdout lines (limit ${this.nonJsonLimit})${detail ? `; first: ${detail}` : ''}`,
          { reason: `${this.nonJsonStreak} 行非 JSON` },
        ),
      );
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      this.handleSessionUpdate(params);
      return;
    }
    if (method === '$/cancel_request') {
      this.statsValue.cancelRequestNotifications += 1;
      return;
    }
    this.statsValue.unknownNotifications += 1;
  }

  private handleSessionUpdate(params: unknown): void {
    const update = (params as { update?: unknown } | null)?.update;
    if (
      update === null ||
      typeof update !== 'object' ||
      typeof (update as { sessionUpdate?: unknown }).sessionUpdate !== 'string'
    ) {
      this.registerNonJson('malformed session/update payload');
      return;
    }
    const variant = (update as { sessionUpdate: string }).sessionUpdate;
    if (KNOWN_SESSION_UPDATE_VARIANTS.has(variant)) {
      this.unknownVariantStreak = 0;
    } else {
      this.unknownVariantStreak += 1;
      this.statsValue.unknownVariants += 1;
    }
    for (const handler of [...this.updateHandlers]) {
      try {
        handler(update as AcpSessionUpdate);
      } catch {
        this.statsValue.handlerErrors += 1;
      }
    }
    if (this.unknownVariantStreak >= this.unknownVariantLimit) {
      this.tripFatal(
        new AcpError(
          'protocol-mismatch',
          `${this.unknownVariantStreak} consecutive unknown sessionUpdate variants (limit ${this.unknownVariantLimit}); last: ${variant}`,
          { reason: `连续 ${this.unknownVariantStreak} 个未知 sessionUpdate 变体` },
        ),
      );
    }
  }

  private handlePeerRequest(id: number | string, method: string, params: unknown): void {
    this.statsValue.peerRequests += 1;
    if (method === 'session/request_permission') {
      this.permissionResponder.handleRequest(id, params);
      return;
    }
    this.statsValue.unansweredPeerMethods += 1;
    this.peer.respondError(id, ACP_JSONRPC_ERROR.methodNotFound, `method not found: ${method}`);
  }

  // --- lifecycle edges ---

  private handleStderrLine(line: string): void {
    try {
      this.options.stderrSink?.(line);
    } catch {
      this.statsValue.handlerErrors += 1;
    }
    if (!AUTH_STDERR_PATTERN.test(line)) return;
    this.peer.rejectByTag(
      SESSION_NEW_TAG,
      new AcpError('auth-required', `agent stderr suggests a missing login: ${line.slice(0, 200)}`, {
        stderrTail: this.transport.stderrTail(),
      }),
    );
  }

  private sessionNewTimeoutError(): AcpError {
    const detail = { stderrTail: this.transport.stderrTail() };
    if (this.handshake && this.handshake.authMethods.length > 0) {
      return new AcpError(
        'auth-required',
        `session/new: no response within ${this.timeouts.sessionNewMs}ms and the agent declares auth methods`,
        detail,
      );
    }
    return new AcpError('agent-error', `session/new: no response within ${this.timeouts.sessionNewMs}ms`, detail);
  }

  private handleTransportClose(info: AcpExitInfo): void {
    if (this.closedInfo) return;
    this.closedInfo = info;
    this.settleEverything(this.fatalError ?? this.closeError(info));
  }

  /**
   * §4: exit code 0 with an unsettled turn is an unclean exit — a protocol
   * violation — not a crash. Every other exit code stays transport-closed.
   */
  private closeError(info: AcpExitInfo): AcpError {
    const stderrTail = this.transport.stderrTail();
    if (info.cancelled) {
      return new AcpError('cancelled', 'agent process closed on the cancel path', { exit: info, stderrTail });
    }
    if (info.code === 0 && this.activePrompts.size > 0) {
      return new AcpError('protocol-mismatch', 'agent exited with code 0 while a session/prompt turn is still in flight', {
        reason: 'agent 退出但回合未结束',
      });
    }
    return new AcpError('transport-closed', `agent process exited (code=${info.code ?? 'null'} signal=${info.signal ?? 'null'})`, {
      exit: info,
      stderrTail,
    });
  }

  private handleTransportError(err: Error): void {
    if (err instanceof AcpError) {
      this.tripFatal(err);
      return;
    }
    // §4 fail-closed: an unknown transport-layer stream error still converges
    // every pending request (as transport-closed) and kills the process — a
    // counted-but-ignored error would leave promptMs=0 turns hanging forever.
    this.statsValue.streamErrors += 1;
    this.tripFatal(new AcpError('transport-closed', `transport stream error: ${err.message}`));
    this.transport.close({ sigtermWaitMs: this.timeouts.sigtermWaitMs, reason: 'crash' }).catch(() => undefined);
  }

  private tripFatal(err: AcpError): void {
    if (this.fatalError) return;
    this.fatalError = err;
    this.settleEverything(err);
  }
}
