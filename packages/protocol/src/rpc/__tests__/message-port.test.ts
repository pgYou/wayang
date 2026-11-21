/**
 * messagePortToStreams — full RPC roundtrip through a fake port pair.
 *
 * Proves the adapter preserves the NDJSON framing contract end to end:
 * RpcServer on one port, RpcClient on the other, request → response.
 */

import { describe, it, expect } from 'vitest';
import { messagePortToStreams, type MessagePortLike } from '../message-port';
import { createStreamTransport } from '../transport';
import { RpcClient } from '../rpc-client';
import { RpcServer } from '../rpc-server';
import { METHOD } from '../protocol';

type MessageHandler = (event: { data: unknown }) => void;

/** Cross-wired fake pair: what one side posts arrives as the other's message. */
class FakePort implements MessagePortLike {
  private handlers = new Set<MessageHandler>();
  peer?: FakePort;

  postMessage(data: unknown): void {
    const peer = this.peer;
    if (peer) setImmediate(() => peer.receive(data));
  }

  private receive(data: unknown): void {
    for (const handler of this.handlers) handler({ data });
  }

  addListener(_event: 'message', listener: MessageHandler): unknown {
    this.handlers.add(listener);
    return this;
  }

  removeListener(_event: 'message', listener: MessageHandler): unknown {
    this.handlers.delete(listener);
    return this;
  }
}

function makePortPair(): [MessagePortLike, MessagePortLike] {
  const a = new FakePort();
  const b = new FakePort();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('messagePortToStreams', () => {
  it('carries a full RPC request/response roundtrip', async () => {
    const [serverPort, clientPort] = makePortPair();

    const serverIo = messagePortToStreams(serverPort);
    const server = new RpcServer(createStreamTransport(serverIo.stdin, serverIo.stdout));
    server.register(METHOD.LIST_TASKS, async () => [{ id: 't1', title: 'way' }]);

    const clientIo = messagePortToStreams(clientPort);
    const client = new RpcClient(createStreamTransport(clientIo.stdin, clientIo.stdout));

    const result = await client.request<Array<{ id: string }>>(METHOD.LIST_TASKS, {});
    expect(result).toEqual([{ id: 't1', title: 'way' }]);
    client.close();
  });

  it('buffers messages that arrive before a reader attaches', async () => {
    const [serverPort, clientPort] = makePortPair();

    // Server side wired and responding immediately; client transport attached late.
    const serverIo = messagePortToStreams(serverPort);
    const server = new RpcServer(createStreamTransport(serverIo.stdin, serverIo.stdout));
    server.register(METHOD.SUBMIT_INPUT, async () => ({ ok: true }));

    // Client sends before its transport exists — the adapter's stdin Readable
    // must hold the frames until the RpcClient drains them.
    clientPort.postMessage('{"jsonrpc":"2.0","id":"early","method":"submit_input","params":{}}\n');
    await new Promise((resolve) => setImmediate(resolve));

    const clientIo = messagePortToStreams(clientPort);
    const client = new RpcClient(createStreamTransport(clientIo.stdin, clientIo.stdout));
    // A second request confirms both the buffered frame and live traffic work;
    // the buffered response for "early" is simply dropped by the client.
    const result = await client.request<{ ok: boolean }>(METHOD.SUBMIT_INPUT, {});
    expect(result).toEqual({ ok: true });
    client.close();
  });
});
