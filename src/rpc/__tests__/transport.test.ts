import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { LineCodec, createStreamTransport } from '../transport';

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
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
