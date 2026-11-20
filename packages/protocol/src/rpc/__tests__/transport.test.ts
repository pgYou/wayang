import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { LineCodec, createStreamTransport, createTransport, createDuplexTransport } from '../transport';
import type { TransportErrorEvent } from '../transport';

describe('LineCodec', () => {
  it('decodes multiple messages from one chunk', () => {
    const codec = new LineCodec();
    const msgs = codec.push('{"id":1,"method":"a"}\n{"id":2,"method":"b"}\n');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ id: 1, method: 'a' });
    expect(msgs[1]).toEqual({ id: 2, method: 'b' });
  });

  it('reassembles messages split across chunk boundaries', () => {
    const codec = new LineCodec();
    expect(codec.push('{"id":1,')).toHaveLength(0);
    expect(codec.push('"method":"a"}\n')).toHaveLength(1);
  });

  it('skips invalid JSON lines instead of throwing', () => {
    const codec = new LineCodec();
    const msgs = codec.push('not-json\n{"id":1,"method":"ok"}\n\n');
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { method: string }).method).toBe('ok');
  });

  it('encode appends a trailing newline', () => {
    expect(LineCodec.encode({ id: 1, method: 'x' }).endsWith('}\n')).toBe(true);
  });
});

describe('createStreamTransport', () => {
  function createPair() {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    // Side A reads from bToA and writes to aToB; side B the mirror.
    return {
      sideA: createStreamTransport(bToA, aToB),
      sideB: createStreamTransport(aToB, bToA),
    };
  }

  it('delivers messages across the pair', async () => {
    const { sideA, sideB } = createPair();
    const received: unknown[] = [];
    sideB.onMessage((msg) => received.push(msg));

    sideA.send({ id: 1, method: 'hello', params: { a: 1 } });
    await tick();
    expect(received).toEqual([{ id: 1, method: 'hello', params: { a: 1 } }]);
  });

  it('buffers messages that arrive before a handler is attached', async () => {
    const { sideA, sideB } = createPair();
    sideA.send({ id: 1, method: 'early' });
    await tick();

    const received: unknown[] = [];
    sideB.onMessage((msg) => received.push(msg));
    await tick();
    expect(received).toEqual([{ id: 1, method: 'early' }]);
  });

  it('send is a no-op after close', async () => {
    const { sideA } = createPair();
    sideA.close();
    expect(() => sideA.send({ id: 1, method: 'x' })).not.toThrow();
  });

  it('close is idempotent', () => {
    const { sideA } = createPair();
    expect(() => {
      sideA.close();
      sideA.close();
    }).not.toThrow();
    expect(sideA.isClosed()).toBe(true);
  });

  it('reports stdio capabilities by default', () => {
    const { sideA } = createPair();
    expect(sideA.capabilities).toEqual({ framing: 'ndjson', privateChannel: true, kind: 'stdio' });
  });
});

describe('createTransport capabilities', () => {
  it('lets callers override declared capabilities', () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const transport = createTransport(bToA, aToB, {
      capabilities: { kind: 'other', privateChannel: false },
    });
    expect(transport.capabilities).toEqual({ framing: 'ndjson', privateChannel: false, kind: 'other' });
  });

  it('createDuplexTransport defaults to a non-private socket channel', () => {
    const duplex = new PassThrough();
    const transport = createDuplexTransport(duplex);
    expect(transport.capabilities.kind).toBe('socket');
    expect(transport.capabilities.privateChannel).toBe(false);
  });

  it('createDuplexTransport respects an explicit privateChannel', () => {
    const duplex = new PassThrough();
    const transport = createDuplexTransport(duplex, { capabilities: { privateChannel: true } });
    expect(transport.capabilities.privateChannel).toBe(true);
    // kind still falls back to the socket default
    expect(transport.capabilities.kind).toBe('socket');
  });
});

describe('transport error channel', () => {
  it('emits write_error when the writable side rejects the write', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = createTransport(readable, writable);
    const events: TransportErrorEvent[] = [];
    transport.onError((e) => events.push(e));

    writable.destroy(new Error('broken pipe'));
    transport.send({ id: 1, method: 'x' });
    await tick();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].reason).toBe('write_error');
    expect(transport.isClosed()).toBe(true);
  });

  it('emits read_error when the readable side errors', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = createTransport(readable, writable);
    const events: TransportErrorEvent[] = [];
    transport.onError((e) => events.push(e));

    readable.destroy(new Error('reset'));
    await tick();

    expect(events.map((e) => e.reason)).toContain('read_error');
    expect(transport.isClosed()).toBe(true);
  });

  it('emits closed when the peer ends the stream', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = createTransport(readable, writable);
    const events: TransportErrorEvent[] = [];
    transport.onError((e) => events.push(e));

    readable.end();
    await tick();

    expect(events).toEqual([{ reason: 'closed', error: undefined }]);
    expect(transport.isClosed()).toBe(true);
  });

  it('emits each terminal event at most once', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = createTransport(readable, writable);
    const events: TransportErrorEvent[] = [];
    transport.onError((e) => events.push(e));

    readable.end();
    readable.end();
    transport.send({ id: 1, method: 'x' });
    await tick();

    expect(events).toHaveLength(1);
  });

  it('unsubscribe stops further notifications', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = createTransport(readable, writable);
    const events: TransportErrorEvent[] = [];
    const off = transport.onError((e) => events.push(e));
    off();

    readable.end();
    await tick();

    expect(events).toHaveLength(0);
  });

  it('a throwing observer does not break the channel', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = createTransport(readable, writable);
    const seen: TransportErrorEvent[] = [];
    transport.onError(() => {
      throw new Error('observer bug');
    });
    transport.onError((e) => seen.push(e));

    readable.end();
    await tick();

    expect(seen).toHaveLength(1);
  });

  it('does not throw on send after the peer went away', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const transport = createTransport(readable, writable);
    transport.onError(() => { /* drain */ });

    writable.destroy(new Error('gone'));
    expect(() => transport.send({ id: 1, method: 'x' })).not.toThrow();
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
