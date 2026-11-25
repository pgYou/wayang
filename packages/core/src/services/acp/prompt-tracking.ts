/**
 * Internal prompt-turn tracking and cancel timing for AcpClient.
 *
 * Pure move out of client.ts (500-line hard limit; same pattern as the
 * json-rpc.ts and permission-responder.ts splits). Owns: the per-session
 * in-flight prompt registry, the §6 promptMs → session/cancel → cancelGraceMs
 * timer ladder, and the session/prompt failure mapping (§4 taxonomy). The
 * client keeps the frozen public surface; this module is not re-exported.
 */

import { ACP_JSONRPC_ERROR } from './config';
import { AcpError } from './errors';
import { JsonRpcRequestFailure, type JsonRpcPeer } from './json-rpc';

interface PromptTracking {
  sessionId: string;
  requestId: number;
  cancelTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
}

/** Map a session/prompt rejection to the §4 taxonomy. */
export function mapPromptFailure(err: unknown): never {
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

export interface AcpPromptTrackerHooks {
  /** promptMs elapsed: the client sends session/cancel (and cancels pending permissions). */
  onExpiry(sessionId: string): void;
}

export class AcpPromptTracker {
  private readonly active = new Map<string, PromptTracking>();
  private readonly peer: JsonRpcPeer;
  private readonly hooks: AcpPromptTrackerHooks;
  private readonly cancelGraceMs: number;
  private readonly promptMs: number;

  constructor(peer: JsonRpcPeer, promptMs: number, cancelGraceMs: number, hooks: AcpPromptTrackerHooks) {
    this.peer = peer;
    this.promptMs = promptMs;
    this.cancelGraceMs = cancelGraceMs;
    this.hooks = hooks;
  }

  has(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  get hasActive(): boolean {
    return this.active.size > 0;
  }

  /** Register a turn, arm the promptMs timer, settle the tracking when the promise settles. */
  track<T>(sessionId: string, requestId: number, promise: Promise<T>): Promise<T> {
    const tracking: PromptTracking = { sessionId, requestId, cancelTimer: null, graceTimer: null };
    this.active.set(sessionId, tracking);
    if (this.promptMs > 0) {
      tracking.cancelTimer = setTimeout(() => this.beginCancel(tracking), this.promptMs);
    }
    return promise.finally(() => this.settle(tracking));
  }

  /** Settle every in-flight tracking (fatal error / transport close / client close). */
  clearAll(): void {
    for (const tracking of [...this.active.values()]) this.settle(tracking);
  }

  private beginCancel(tracking: PromptTracking): void {
    tracking.cancelTimer = null;
    this.hooks.onExpiry(tracking.sessionId);
    tracking.graceTimer = setTimeout(() => {
      tracking.graceTimer = null;
      this.peer.rejectById(
        tracking.requestId,
        new AcpError('cancelled', `session/prompt cancel grace ${this.cancelGraceMs}ms elapsed without settle`),
      );
    }, this.cancelGraceMs);
  }

  private settle(tracking: PromptTracking): void {
    if (tracking.cancelTimer) {
      clearTimeout(tracking.cancelTimer);
      tracking.cancelTimer = null;
    }
    if (tracking.graceTimer) {
      clearTimeout(tracking.graceTimer);
      tracking.graceTimer = null;
    }
    this.active.delete(tracking.sessionId);
  }
}
