/**
 * Generic JSON-RPC 2.0 peer over a line-based transport.
 *
 * Internal module split out of client.ts (which exceeded the 500-line hard
 * limit; split sanctioned by the freeze page's §1 note on #50 pure moves).
 * Knows nothing about ACP: auto-increment integer ids, pending map, per-tag
 * lookup, out-of-order response matching, peer request/notification routing,
 * and external rejection (fatal errors, cancel grace, stderr short-circuit).
 * All frozen §2.4 symbols remain exported from client.ts.
 */

import { ACP_JSONRPC_ERROR } from './config';

export interface JsonRpcPeerHooks {
  /** Write one already-serialized JSON-RPC message line (without newline). */
  write(line: string): void;
  onPeerRequest(id: number | string, method: string, params: unknown): void;
  onNotification(method: string, params: unknown): void;
  onUnknownResponseId(id: unknown): void;
  /** The read-loop guard: a handler or parse path threw. Never rethrows. */
  onReadError(err: unknown): void;
}

export interface JsonRpcRequestOptions {
  /** <= 0 (default) arms no timer. */
  timeoutMs?: number;
  /** Optional label for external rejection via `rejectByTag`. */
  tag?: string;
  /** Timeout error factory; defaults to a plain Error. */
  onTimeout?: () => Error;
}

/** A JSON-RPC error response for one of our requests. */
export class JsonRpcRequestFailure extends Error {
  readonly code: number;
  readonly method: string;

  constructor(rpcMessage: string, code: number, method: string) {
    super(rpcMessage);
    this.name = 'JsonRpcRequestFailure';
    this.code = code;
    this.method = method;
  }
}

interface PeerEntry {
  id: number;
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout | null;
  tag: string | null;
}

export type JsonRpcLineOutcome =
  | { kind: 'empty' }
  | { kind: 'invalid'; detail?: string }
  | { kind: 'dispatched' };

function toRpcError(error: unknown): { code: number; message: string } {
  const obj = (error ?? null) as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof obj?.code === 'number' ? obj.code : ACP_JSONRPC_ERROR.internal,
    message: typeof obj?.message === 'string' ? obj.message : JSON.stringify(error),
  };
}

export class JsonRpcPeer {
  private readonly hooks: JsonRpcPeerHooks;
  private nextId = 1;
  private readonly pending = new Map<number, PeerEntry>();
  private readonly tagged = new Map<string, PeerEntry>();

  constructor(hooks: JsonRpcPeerHooks) {
    this.hooks = hooks;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Send a request; the id is allocated here and returned for external cancellation. */
  request(method: string, params: unknown, options?: JsonRpcRequestOptions): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const entry: PeerEntry = { id, method, resolve, reject, timer: null, tag: options?.tag ?? null };
      this.pending.set(id, entry);
      if (entry.tag) this.tagged.set(entry.tag, entry);
      const timeoutMs = options?.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.detach(entry);
          reject(
            options?.onTimeout
              ? options.onTimeout()
              : new Error(`json-rpc request ${method} timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.detach(entry);
        reject(err);
      }
    });
    return { id, promise };
  }

  send(message: unknown): void {
    this.hooks.write(JSON.stringify(message));
  }

  respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Classify and dispatch one inbound line. Never throws. */
  handleLine(line: string): JsonRpcLineOutcome {
    try {
      const trimmed = line.trim();
      if (trimmed.length === 0) return { kind: 'empty' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return { kind: 'invalid', detail: trimmed.slice(0, 120) };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'invalid', detail: trimmed.slice(0, 120) };
      }
      const message = parsed as Record<string, unknown>;
      if (typeof message.method === 'string') {
        if (message.id !== undefined && message.id !== null) {
          if (typeof message.id !== 'number' && typeof message.id !== 'string') {
            return { kind: 'invalid', detail: 'peer request without a usable id' };
          }
          this.hooks.onPeerRequest(message.id, message.method, message.params);
        } else {
          this.hooks.onNotification(message.method, message.params);
        }
        return { kind: 'dispatched' };
      }
      if (message.id !== undefined && message.id !== null) {
        if (typeof message.id !== 'number') {
          this.hooks.onUnknownResponseId(message.id);
          return { kind: 'dispatched' };
        }
        const entry = this.pending.get(message.id);
        if (!entry) {
          this.hooks.onUnknownResponseId(message.id);
          return { kind: 'dispatched' };
        }
        this.detach(entry);
        if (message.error !== undefined && message.error !== null) {
          const rpc = toRpcError(message.error);
          entry.reject(new JsonRpcRequestFailure(rpc.message, rpc.code, entry.method));
        } else {
          entry.resolve(message.result);
        }
        return { kind: 'dispatched' };
      }
      return { kind: 'invalid', detail: trimmed.slice(0, 120) };
    } catch (err) {
      this.hooks.onReadError(err);
      return { kind: 'dispatched' };
    }
  }

  /** Externally reject a pending request by id (cancel grace expiry). No-op when already settled. */
  rejectById(id: number, err: Error): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.detach(entry);
    entry.reject(err);
    return true;
  }

  /** Externally reject a pending request by tag (stderr short-circuit). No-op when already settled. */
  rejectByTag(tag: string, err: Error): boolean {
    const entry = this.tagged.get(tag);
    if (!entry) return false;
    this.detach(entry);
    entry.reject(err);
    return true;
  }

  /** Externally reject every pending request (fatal error / transport close). */
  rejectAll(err: Error): void {
    for (const entry of [...this.pending.values()]) {
      this.detach(entry);
      entry.reject(err);
    }
  }

  private detach(entry: PeerEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.pending.delete(entry.id);
    if (entry.tag) this.tagged.delete(entry.tag);
  }
}
