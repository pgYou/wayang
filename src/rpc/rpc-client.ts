/**
 * RpcClient — request/response correlation plus notification dispatch,
 * with a remote Subscribable facade on top.
 *
 * Subscription model: server events always carry the FULL value at the
 * subscribed path (see BaseWayangState.notify), so the client keeps a
 * per-path cache and overwrites on every event — idempotent, no merging.
 * `getSnapshot` is served from that cache; until the first subscribe
 * completes it returns undefined, which TUI components already tolerate
 * via `?? fallback`.
 */

import type { RpcTransport, TransportErrorEvent } from './transport';
import { isRpcResponse, METHOD, NOTIFY, type RpcMessage, type RpcNotification } from './protocol';
import type { Subscribable } from '@/infra/state/subscribable';
import type { StateEvent } from '@/infra/state/base-state';

export interface RpcClientOptions {
  /** Invoked when the underlying channel fails or the peer goes away. */
  onTransportError?: (event: TransportErrorEvent) => void;
}

export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  constructor(
    private readonly transport: RpcTransport,
    options: RpcClientOptions = {},
  ) {
    transport.onMessage((msg) => this.dispatch(msg));
    transport.onError((event) => {
      // The channel is gone: no response can ever arrive, so fail fast
      // instead of leaving callers waiting for a reply that cannot come.
      const err = new Error(
        `RPC transport ${event.reason}${event.error ? `: ${event.error.message}` : ''}`,
      );
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const entry of pending) entry.reject(err);
      options.onTransportError?.(event);
    });
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    // Once the channel is gone no reply can ever arrive, and `send` silently
    // drops frames on a closed transport — reject immediately instead of
    // leaving the caller waiting forever.
    if (this.transport.isClosed()) {
      return Promise.reject(new Error('RPC transport closed: cannot send request'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.transport.send({ id, method, params });
    });
  }

  /** Underlying channel characteristics (private pipe vs named endpoint). */
  get capabilities(): RpcTransport['capabilities'] {
    return this.transport.capabilities;
  }

  /** Subscribe to a server→client notification. Returns an unsubscribe fn. */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  close(): void {
    this.transport.close();
  }

  private dispatch(msg: RpcMessage): void {
    if (isRpcResponse(msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if ('error' in msg) entry.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
      return;
    }
    const notification = msg as RpcNotification;
    const handlers = this.notificationHandlers.get(notification.method);
    if (!handlers) return;
    for (const h of handlers) h(notification.params ?? {});
  }
}

// ---------------------------------------------------------------------------
// Remote subscribable state
// ---------------------------------------------------------------------------

interface SubscriptionEntry {
  subscriptionId: string;
  target: string;
  path: string;
  data: unknown;
  listeners: Set<(event: StateEvent) => void>;
  /** Guard against subscribe responses arriving after local teardown. */
  settled: boolean;
}

/** Owns all remote subscriptions of one client, keyed by target:path. */
export class RemoteStateStore {
  private entries = new Map<string, SubscriptionEntry>();
  private byId = new Map<string, SubscriptionEntry>();

  constructor(private readonly rpc: RpcClient) {
    rpc.on(NOTIFY.STATE_EVENT, (params) => {
      const entry = this.byId.get(String(params.subscriptionId));
      if (!entry) return;
      entry.data = params.data;
      const event: StateEvent = { type: 'set', path: entry.path, data: params.data, prev: undefined };
      for (const listener of entry.listeners) listener(event);
    });
  }

  subscribe(target: string, path: string, callback: (event: StateEvent) => void): () => void {
    const key = `${target}:${path}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { subscriptionId: '', target, path, data: undefined, listeners: new Set(), settled: false };
      this.entries.set(key, entry);
      this.connect(entry, key);
    }
    entry.listeners.add(callback);
    return () => {
      entry.listeners.delete(callback);
      if (entry.listeners.size === 0) this.teardown(entry, key);
    };
  }

  getSnapshot(target: string, path: string): unknown {
    return this.entries.get(`${target}:${path}`)?.data;
  }

  private connect(entry: SubscriptionEntry, key: string): void {
    this.rpc
      .request<{ subscriptionId: string; data: unknown }>(METHOD.SUBSCRIBE, { target: entry.target, path: entry.path })
      .then((res) => {
        // Local listeners may have gone away (or a retry happened) while in flight.
        if (this.entries.get(key) !== entry || !res?.subscriptionId) return;
        entry.subscriptionId = res.subscriptionId;
        entry.settled = true;
        this.byId.set(res.subscriptionId, entry);
        // null is the server's encoding of "path not set" — nothing to apply.
        if (res.data !== null && res.data !== undefined) {
          entry.data = res.data;
        }
        if (entry.listeners.size === 0) {
          this.teardown(entry, key);
          return;
        }
        if (entry.data !== undefined) {
          const event: StateEvent = { type: 'set', path: entry.path, data: entry.data, prev: undefined };
          for (const listener of entry.listeners) listener(event);
        }
      })
      .catch(() => {
        // Failed subscription: drop so a later subscribe attempt can retry.
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
  }

  private teardown(entry: SubscriptionEntry, key: string): void {
    this.entries.delete(key);
    if (!entry.settled || !entry.subscriptionId) return;
    this.byId.delete(entry.subscriptionId);
    void this.rpc.request(METHOD.UNSUBSCRIBE, { subscriptionId: entry.subscriptionId }).catch(() => { /* best effort */ });
  }
}

/** Subscribable facade bound to one server-side target (e.g. 'controllerAgent'). */
export class RemoteSubscribable implements Subscribable {
  constructor(
    private readonly store: RemoteStateStore,
    private readonly target: string,
  ) {}

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.store.subscribe(this.target, path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.store.getSnapshot(this.target, path) as T;
  }
}
