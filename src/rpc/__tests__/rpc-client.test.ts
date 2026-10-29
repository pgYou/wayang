import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { get, set } from 'lodash-es';
import { RpcClient, RemoteStateStore, RemoteSubscribable } from '../rpc-client';
import { RpcServer } from '../rpc-server';
import { createStreamTransport } from '../transport';
import { METHOD, NOTIFY, RPC_ERROR } from '../protocol';
import type { Subscribable } from '@/infra/state/subscribable';
import type { StateEvent } from '@/infra/state/base-state';

function createPair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return {
    clientTransport: createStreamTransport(bToA, aToB),
    serverTransport: createStreamTransport(aToB, bToA),
  };
}

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- In-memory Subscribable for remote-state tests ---

class FakeSubscribable implements Subscribable {
  private data: Record<string, unknown> = {};
  private listeners = new Map<string, Set<(e: StateEvent) => void>>();

  write(path: string, value: unknown): void {
    set(this.data, path, value);
    const event: StateEvent = { type: 'set', path, data: get(this.data, path), prev: undefined };
    for (const [subPath, cbs] of this.listeners) {
      if (subPath === path || path.startsWith(`${subPath}.`) || subPath.startsWith(`${path}.`)) {
        for (const cb of cbs) cb({ ...event, data: get(this.data, subPath) });
      }
    }
  }

  subscribe(path: string, callback: (e: StateEvent) => void): () => void {
    const set_ = this.listeners.get(path) ?? new Set();
    set_.add(callback);
    this.listeners.set(path, set_);
    return () => set_.delete(callback);
  }

  getSnapshot<T>(path: string): T {
    return get(this.data, path) as T;
  }
}

function startServerWithTarget(target: Subscribable) {
  const pair = createPair();
  const rpc = new RpcServer(pair.serverTransport);
  const unsubscribed: boolean[] = [];

  rpc.register(METHOD.SUBSCRIBE, (params) => {
    const path = String(params.path);
    const data = target.getSnapshot(path);
    const subscriptionId = `sub-${unsubscribed.length + 1}`;
    unsubscribed.push(false);
    const index = unsubscribed.length - 1;
    const unsub = target.subscribe(path, () => {
      rpc.notify(NOTIFY.STATE_EVENT, {
        subscriptionId,
        target: params.target,
        path,
        data: target.getSnapshot(path),
      });
    });
    return {
      subscriptionId,
      data: data === undefined ? null : data,
      unsubscribe: () => {
        unsubscribed[index] = true;
        unsub();
      },
    };
  });
  rpc.register(METHOD.UNSUBSCRIBE, (params) => {
    const n = Number(String(params.subscriptionId).replace('sub-', '')) - 1;
    unsubscribed[n] = true;
    return {};
  });
  rpc.register('echo', (params) => params);

  return { pair, rpc, unsubscribed };
}

describe('RpcClient', () => {
  it('round-trips a request through a real RpcServer', async () => {
    const { pair } = (() => {
      const p = createPair();
      const server = new RpcServer(p.serverTransport);
      server.register('echo', (params) => ({ echoed: params }));
      return { pair: p };
    })();

    const client = new RpcClient(pair.clientTransport);
    const result = await client.request('echo', { hello: 'world' });
    expect(result).toEqual({ echoed: { hello: 'world' } });
  });

  it('rejects when the server responds with an error', async () => {
    const p = createPair();
    const server = new RpcServer(p.serverTransport);
    server.register('boom', () => {
      throw new Error('nope');
    });
    const client = new RpcClient(p.clientTransport);

    await expect(client.request('boom')).rejects.toThrow(`RPC ${RPC_ERROR.INTERNAL}: nope`);
  });

  it('delivers notifications to on() handlers and stops after unsubscribe', async () => {
    const p = createPair();
    const server = new RpcServer(p.serverTransport);
    const client = new RpcClient(p.clientTransport);

    const seen: string[] = [];
    const off = client.on('greeting', (params) => seen.push(String(params.word)));

    server.notify('greeting', { word: 'hi' });
    await flush();
    expect(seen).toEqual(['hi']);

    off();
    server.notify('greeting', { word: 'again' });
    await flush();
    expect(seen).toEqual(['hi']);
  });

  it('rejects pending requests when the transport dies', async () => {
    const p = createPair();
    const server = new RpcServer(p.serverTransport);
    // A handler that never settles: the request stays in flight.
    server.register('never_answered', () => new Promise(() => { /* never */ }));
    const client = new RpcClient(p.clientTransport);

    const inflight = client.request('never_answered');
    // Attach the rejection handler up front so the teardown-triggered
    // rejection is never observed as unhandled.
    const assertion = expect(inflight).rejects.toThrow('RPC transport closed');
    await flush();
    // Peer goes away — no response can ever arrive.
    p.serverTransport.close();
    await assertion;
  });

  it('notifies onTransportError observers', async () => {
    const p = createPair();
    new RpcServer(p.serverTransport);
    const reasons: string[] = [];
    new RpcClient(p.clientTransport, {
      onTransportError: (event) => reasons.push(event.reason),
    });

    p.clientTransport.close();
    await flush();

    expect(reasons).toEqual(['closed']);
  });

  it('exposes transport capabilities through the client', () => {
    const p = createPair();
    new RpcServer(p.serverTransport);
    const client = new RpcClient(p.clientTransport);
    expect(client.capabilities.privateChannel).toBe(true);
  });
});

describe('RemoteStateStore + RemoteSubscribable', () => {
  it('subscribe returns the snapshot, then streams updates; getSnapshot reads the cache', async () => {
    const target = new FakeSubscribable();
    target.write('tasks.pending', [{ id: 't1' }]);
    const { pair } = startServerWithTarget(target);

    const client = new RpcClient(pair.clientTransport);
    const store = new RemoteStateStore(client);
    const engine = new RemoteSubscribable(store, 'engine');

    const seen: unknown[] = [];
    const listener = (e: StateEvent) => seen.push(e.data);
    engine.subscribe('tasks.pending', listener);
    await flush();

    expect(seen).toEqual([[{ id: 't1' }]]); // initial snapshot via subscribe response
    expect(engine.getSnapshot('tasks.pending')).toEqual([{ id: 't1' }]);

    target.write('tasks.pending', [{ id: 't1' }, { id: 't2' }]);
    await flush();
    expect(seen).toHaveLength(2);
    expect(engine.getSnapshot('tasks.pending')).toEqual([{ id: 't1' }, { id: 't2' }]);
  });

  it('unsubscribes remotely once the last local listener goes away', async () => {
    const target = new FakeSubscribable();
    const { pair, unsubscribed } = startServerWithTarget(target);

    const client = new RpcClient(pair.clientTransport);
    const store = new RemoteStateStore(client);
    const engine = new RemoteSubscribable(store, 'engine');

    const off = engine.subscribe('signals', () => { /* noop */ });
    await flush();
    expect(unsubscribed).toHaveLength(1);

    off();
    await flush();
    expect(unsubscribed[0]).toBe(true);
  });

  it('getSnapshot returns undefined before the first subscribe completes', () => {
    const p = createPair();
    new RpcServer(p.serverTransport);
    const client = new RpcClient(p.clientTransport);
    const store = new RemoteStateStore(client);
    const engine = new RemoteSubscribable(store, 'engine');

    expect(engine.getSnapshot('whatever')).toBeUndefined();
  });

  it('shares one remote subscription across multiple local listeners', async () => {
    const target = new FakeSubscribable();
    const { pair } = startServerWithTarget(target);

    const client = new RpcClient(pair.clientTransport);
    const store = new RemoteStateStore(client);
    const engine = new RemoteSubscribable(store, 'engine');

    const seen1: unknown[] = [];
    const seen2: unknown[] = [];
    const off1 = engine.subscribe('conversation', (e) => seen1.push(e.data));
    engine.subscribe('conversation', (e) => seen2.push(e.data));
    await flush();

    target.write('conversation', ['a']);
    await flush();

    expect(seen1).toEqual([['a']]);
    expect(seen2).toEqual([['a']]);

    off1();
    await flush();
    // Second listener still active → updates still flow
    target.write('conversation', ['a', 'b']);
    await flush();
    expect(seen2).toEqual([['a'], ['a', 'b']]);
    expect(seen1).toEqual([['a']]);
  });
});
