import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { RpcServer } from '../rpc-server';
import { createStreamTransport } from '../transport';
import { RpcError, RPC_ERROR } from '../protocol';

function createPair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return {
    client: createStreamTransport(bToA, aToB),
    server: createStreamTransport(aToB, bToA),
  };
}

/** Drive raw requests through a transport and collect raw responses. */
function useRawClient(transport: ReturnType<typeof createStreamTransport>) {
  const responses: unknown[] = [];
  transport.onMessage((msg) => responses.push(msg));
  return {
    responses,
    send: (msg: unknown) => transport.send(msg as never),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('RpcServer', () => {
  it('dispatches to registered handlers and returns the result', async () => {
    const { client, server } = createPair();
    const handler = vi.fn().mockReturnValue({ ok: true });
    const rpc = new RpcServer(server);
    rpc.register('do_thing', handler);

    const raw = useRawClient(client);
    raw.send({ id: 7, method: 'do_thing', params: { x: 1 } });
    await flush();

    expect(handler).toHaveBeenCalledWith({ x: 1 });
    expect(raw.responses).toEqual([{ id: 7, result: { ok: true } }]);
  });

  it('responds METHOD_NOT_FOUND for unknown methods', async () => {
    const { client, server } = createPair();
    new RpcServer(server);

    const raw = useRawClient(client);
    raw.send({ id: 1, method: 'nope' });
    await flush();

    expect(raw.responses).toEqual([
      { id: 1, error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: 'Unknown method: nope' } },
    ]);
  });

  it('maps handler exceptions to INTERNAL with the message', async () => {
    const { client, server } = createPair();
    const rpc = new RpcServer(server);
    rpc.register('boom', () => {
      throw new Error('kaboom');
    });

    const raw = useRawClient(client);
    raw.send({ id: 2, method: 'boom' });
    await flush();

    expect(raw.responses).toEqual([
      { id: 2, error: { code: RPC_ERROR.INTERNAL, message: 'kaboom' } },
    ]);
  });

  it('preserves RpcError codes from handlers', async () => {
    const { client, server } = createPair();
    const rpc = new RpcServer(server);
    rpc.register('bad_params', () => {
      throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'Missing required string param: path');
    });

    const raw = useRawClient(client);
    raw.send({ id: 3, method: 'bad_params' });
    await flush();

    expect(raw.responses).toEqual([
      { id: 3, error: { code: RPC_ERROR.INVALID_PARAMS, message: 'Missing required string param: path' } },
    ]);
  });

  it('supports async handlers', async () => {
    const { client, server } = createPair();
    const rpc = new RpcServer(server);
    rpc.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });

    const raw = useRawClient(client);
    raw.send({ id: 4, method: 'slow' });
    await flush();

    expect(raw.responses).toEqual([{ id: 4, result: 'done' }]);
  });

  it('notify sends a notification frame without an id', async () => {
    const { client, server } = createPair();
    const rpc = new RpcServer(server);

    const raw = useRawClient(client);
    rpc.notify('ready', { sessionId: 's1' });
    await flush();

    expect(raw.responses).toEqual([{ method: 'ready', params: { sessionId: 's1' } }]);
  });

  it('processes requests that arrived before construction', async () => {
    const { client, server } = createPair();
    // Request lands on the wire BEFORE the RpcServer exists.
    client.send({ id: 9, method: 'later' });

    const responses: unknown[] = [];
    client.onMessage((msg) => responses.push(msg));

    const rpc = new RpcServer(server);
    rpc.register('later', () => 'caught-up');
    await flush();

    expect(responses).toEqual([{ id: 9, result: 'caught-up' }]);
  });
});
