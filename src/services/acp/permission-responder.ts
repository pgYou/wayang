/**
 * JSON-RPC response plumbing for agent-initiated `session/request_permission`
 * requests.
 *
 * Internal module split out of client.ts (500-line hard limit; pure move).
 * Scope note: this is NOT the §5 permission-policy bridge — no decideToolAccess,
 * no approval memory, no audit. It only tracks in-flight peer permission
 * requests, arms the permissionMs fail-closed net, writes the outcome
 * response, and answers everything with outcome 'cancelled' on cancel/close
 * (protocol MUST). The policy decision is the worker layer's handler.
 */

import { ACP_JSONRPC_ERROR } from './config';
import { normalizePermissionOutcome } from './codec';
import type { JsonRpcPeer } from './json-rpc';
import type { AcpPermissionOption, AcpPermissionOutcome, AcpPermissionRequest } from './types';

export type PermissionHandler = (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;

interface PeerPermissionEntry {
  id: number | string;
  settled: boolean;
  timer: NodeJS.Timeout | null;
}

export interface AcpPermissionResponderHooks {
  /** A handler outcome arrived after the entry was already settled (cancel/close/timeout). */
  onLateOutcome(): void;
}

export class AcpPermissionResponder {
  private readonly peer: JsonRpcPeer;
  private readonly permissionMs: number;
  private readonly hooks: AcpPermissionResponderHooks;
  private readonly entries = new Map<number | string, PeerPermissionEntry>();
  private handler: PermissionHandler | null = null;

  constructor(peer: JsonRpcPeer, permissionMs: number, hooks: AcpPermissionResponderHooks) {
    this.peer = peer;
    this.permissionMs = permissionMs;
    this.hooks = hooks;
  }

  setHandler(handler: PermissionHandler | null): void {
    this.handler = handler;
  }

  /** Detach `handler` only while it is still the registered one (symmetric teardown for multiple registrations). */
  clearIfCurrent(handler: PermissionHandler): void {
    if (this.handler === handler) this.handler = null;
  }

  /**
   * Handle one `session/request_permission` peer request: parse params, arm
   * the fail-closed timer, dispatch to the registered handler (or answer
   * 'cancelled' immediately when none is registered). Malformed params get
   * -32603 (the frozen error set has no -32602).
   */
  handleRequest(id: number | string, params: unknown): void {
    const obj = (params ?? null) as { sessionId?: unknown; toolCall?: unknown; options?: unknown } | null;
    if (
      obj === null ||
      typeof obj !== 'object' ||
      obj.toolCall === null ||
      typeof obj.toolCall !== 'object' ||
      !Array.isArray(obj.options)
    ) {
      this.peer.respondError(id, ACP_JSONRPC_ERROR.internal, 'invalid session/request_permission params');
      return;
    }
    const request: AcpPermissionRequest = {
      sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : '',
      toolCall: obj.toolCall as AcpPermissionRequest['toolCall'],
      options: obj.options as AcpPermissionOption[],
    };
    const entry: PeerPermissionEntry = { id, settled: false, timer: null };
    this.entries.set(id, entry);
    if (this.permissionMs > 0) {
      entry.timer = setTimeout(() => this.settle(entry, { outcome: 'cancelled' }), this.permissionMs);
    }
    const handler = this.handler;
    if (!handler) {
      this.settle(entry, { outcome: 'cancelled' });
      return;
    }
    try {
      Promise.resolve(handler(request)).then(
        (outcome) => this.settle(entry, normalizePermissionOutcome(outcome)),
        (err) => this.settleError(entry, err),
      );
    } catch (err) {
      this.settleError(entry, err);
    }
  }

  /** Answer every in-flight permission request with outcome 'cancelled' (session/cancel, close). */
  cancelAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.settle(entry, { outcome: 'cancelled' });
    }
  }

  private settle(entry: PeerPermissionEntry, outcome: AcpPermissionOutcome): void {
    if (entry.settled) {
      this.hooks.onLateOutcome();
      return;
    }
    entry.settled = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.entries.delete(entry.id);
    this.peer.respond(entry.id, { outcome });
  }

  private settleError(entry: PeerPermissionEntry, err: unknown): void {
    if (entry.settled) {
      this.hooks.onLateOutcome();
      return;
    }
    entry.settled = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.entries.delete(entry.id);
    const message = err instanceof Error ? err.message : String(err);
    this.peer.respondError(entry.id, ACP_JSONRPC_ERROR.internal, message);
  }
}
