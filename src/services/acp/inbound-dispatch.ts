/**
 * Internal inbound line/notification classification and dispatch for AcpClient.
 *
 * Pure move out of client.ts (500-line hard limit; same pattern as the
 * json-rpc.ts / permission-responder.ts / prompt-tracking.ts splits). Owns:
 * the empty/invalid/non-JSON line classification, the consecutive non-JSON and
 * unknown-variant streaks with their protocol-mismatch thresholds, the
 * session/update dispatch to onUpdate handlers, and peer-request routing
 * (request_permission → responder, everything else → -32601). The client
 * keeps the frozen public surface; this module is not re-exported.
 */

import { ACP_JSONRPC_ERROR } from './config';
import { AcpError } from './errors';
import { KNOWN_SESSION_UPDATE_VARIANTS } from './codec';
import type { JsonRpcPeer } from './json-rpc';
import type { AcpPermissionResponder } from './permission-responder';
import type { AcpSessionUpdate } from './types';

const DEFAULT_NON_JSON_LIMIT = 50;
const DEFAULT_UNKNOWN_VARIANT_LIMIT = 50;

/** The inbound-path counters the dispatcher owns (structurally shared with AcpClientStats). */
interface InboundStats {
  emptyLines: number;
  nonJsonLines: number;
  unknownVariants: number;
  handlerErrors: number;
  peerRequests: number;
  unansweredPeerMethods: number;
  cancelRequestNotifications: number;
  unknownNotifications: number;
}

export interface AcpInboundDispatcherDeps {
  peer: JsonRpcPeer;
  stats: InboundStats;
  permissionResponder: AcpPermissionResponder;
  /** Consecutive non-JSON stdout line threshold, default 50 → AcpError('protocol-mismatch'). */
  nonJsonLimit?: number;
  /** Consecutive unknown sessionUpdate variant threshold, default 50 → AcpError('protocol-mismatch'). */
  unknownVariantLimit?: number;
  /** Fatal-error hook (the client owns the fatalError state and settlement). */
  onFatal(err: AcpError): void;
}

export class AcpInboundDispatcher {
  private readonly peer: JsonRpcPeer;
  private readonly stats: InboundStats;
  private readonly permissionResponder: AcpPermissionResponder;
  private readonly nonJsonLimit: number;
  private readonly unknownVariantLimit: number;
  private readonly onFatal: (err: AcpError) => void;
  private readonly updateHandlers = new Set<(update: AcpSessionUpdate) => void>();

  private nonJsonStreak = 0;
  private unknownVariantStreak = 0;

  constructor(deps: AcpInboundDispatcherDeps) {
    this.peer = deps.peer;
    this.stats = deps.stats;
    this.permissionResponder = deps.permissionResponder;
    this.nonJsonLimit =
      deps.nonJsonLimit !== undefined && deps.nonJsonLimit > 0 ? deps.nonJsonLimit : DEFAULT_NON_JSON_LIMIT;
    this.unknownVariantLimit =
      deps.unknownVariantLimit !== undefined && deps.unknownVariantLimit > 0
        ? deps.unknownVariantLimit
        : DEFAULT_UNKNOWN_VARIANT_LIMIT;
    this.onFatal = deps.onFatal;
  }

  /** Classify one stdout line: peer dispatch plus the empty/invalid/non-JSON accounting. */
  handleLine(line: string): void {
    const outcome = this.peer.handleLine(line);
    if (outcome.kind === 'empty') {
      this.stats.emptyLines += 1;
      return;
    }
    if (outcome.kind === 'invalid') {
      this.registerNonJson(outcome.detail);
      return;
    }
    this.nonJsonStreak = 0;
  }

  /** Sync update callbacks; a throwing handler is debug-counted and never breaks the read loop. */
  onUpdate(handler: (update: AcpSessionUpdate) => void): () => void {
    this.updateHandlers.add(handler);
    return () => {
      this.updateHandlers.delete(handler);
    };
  }

  handlePeerRequest(id: number | string, method: string, params: unknown): void {
    this.stats.peerRequests += 1;
    if (method === 'session/request_permission') {
      this.permissionResponder.handleRequest(id, params);
      return;
    }
    this.stats.unansweredPeerMethods += 1;
    this.peer.respondError(id, ACP_JSONRPC_ERROR.methodNotFound, `method not found: ${method}`);
  }

  private registerNonJson(detail?: string): void {
    this.stats.nonJsonLines += 1;
    this.nonJsonStreak += 1;
    if (this.nonJsonStreak >= this.nonJsonLimit) {
      this.onFatal(
        new AcpError(
          'protocol-mismatch',
          `${this.nonJsonStreak} consecutive non-JSON stdout lines (limit ${this.nonJsonLimit})${detail ? `; first: ${detail}` : ''}`,
          { reason: `${this.nonJsonStreak} 行非 JSON` },
        ),
      );
    }
  }

  /** Peer-hook target: route notifications (the JsonRpcPeer hook calls this). */
  handleNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      this.handleSessionUpdate(params);
      return;
    }
    if (method === '$/cancel_request') {
      this.stats.cancelRequestNotifications += 1;
      return;
    }
    this.stats.unknownNotifications += 1;
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
      this.stats.unknownVariants += 1;
    }
    for (const handler of [...this.updateHandlers]) {
      try {
        handler(update as AcpSessionUpdate);
      } catch {
        this.stats.handlerErrors += 1;
      }
    }
    if (this.unknownVariantStreak >= this.unknownVariantLimit) {
      this.onFatal(
        new AcpError(
          'protocol-mismatch',
          `${this.unknownVariantStreak} consecutive unknown sessionUpdate variants (limit ${this.unknownVariantLimit}); last: ${variant}`,
          { reason: `连续 ${this.unknownVariantStreak} 个未知 sessionUpdate 变体` },
        ),
      );
    }
  }
}
