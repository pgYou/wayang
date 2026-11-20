import { describe, expect, it } from 'vitest';
import { AcpError } from '@/services/acp/errors';
import { LineDecoder } from '@/services/acp/transport';

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf-8');

describe('LineDecoder', () => {
  it('emits multiple complete lines from a single chunk', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8('{"a":1}\n{"a":2}\n{"a":3}\n'))).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
  });

  it('reassembles one message split across chunks', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8('{"json'))).toEqual([]);
    expect(decoder.push(utf8('rpc":"2.0"'))).toEqual([]);
    expect(decoder.push(utf8('}'))).toEqual([]);
    expect(decoder.push(utf8('\n'))).toEqual(['{"jsonrpc":"2.0"}']);
  });

  it('keeps partial and complete lines interleaved across chunks', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8('one\ntw'))).toEqual(['one']);
    expect(decoder.push(utf8('o\nthree\nfo'))).toEqual(['two', 'three']);
    expect(decoder.push(utf8('ur\n'))).toEqual(['four']);
  });

  it('never cuts a UTF-8 code point split across chunks', () => {
    const decoder = new LineDecoder();
    const bytes = utf8('你好，世界\n');
    // Split at every byte boundary inside the multi-byte characters.
    for (let i = 1; i < bytes.length; i += 1) {
      const fresh = new LineDecoder();
      const first = fresh.push(bytes.subarray(0, i));
      const second = fresh.push(bytes.subarray(i));
      expect([...first, ...second]).toEqual(['你好，世界']);
    }
    expect(decoder.pendingBytes).toBe(0);
  });

  it('decodes multiple UTF-8 messages in one chunk', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8('你好\n世界\n'))).toEqual(['你好', '世界']);
  });

  it('flushes a trailing fragment without newline on finish() (legal ndjson)', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8('done\n{"partial"'))).toEqual(['done']);
    expect(decoder.finish()).toBe('{"partial"');
    expect(decoder.finish()).toBeNull();
  });

  it('tolerates CRLF line endings', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8('{"a":1}\r\n{"a":2}\r\n'))).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('emits empty lines verbatim (classification is the client\'s job)', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(utf8('\n\na\n\n'))).toEqual(['', '', 'a', '']);
  });

  it('reports pendingBytes for the incomplete line', () => {
    const decoder = new LineDecoder();
    decoder.push(utf8('abc'));
    expect(decoder.pendingBytes).toBe(3);
    decoder.push(utf8('def\n'));
    expect(decoder.pendingBytes).toBe(0);
  });

  it('rejects an oversized frame without a newline and poisons the decoder', () => {
    const decoder = new LineDecoder({ maxLineBytes: 16 });
    expect(() => decoder.push(utf8('x'.repeat(17)))).toThrowError(AcpError);
    try {
      decoder.push(utf8('more'));
    } catch (err) {
      expect((err as AcpError).code).toBe('protocol-mismatch');
    }
    expect(() => decoder.finish()).toThrowError(AcpError);
  });

  it('rejects an oversized complete line (with newline)', () => {
    const decoder = new LineDecoder({ maxLineBytes: 16 });
    expect(() => decoder.push(utf8(`${'x'.repeat(17)}\n`))).toThrowError(AcpError);
  });

  it('accepts a line exactly at the byte limit', () => {
    const decoder = new LineDecoder({ maxLineBytes: 16 });
    const line = 'a'.repeat(16);
    expect(decoder.push(utf8(`${line}\n`))).toEqual([line]);
  });

  it('ignores empty chunks', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.alloc(0))).toEqual([]);
  });
});
