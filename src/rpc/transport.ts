/**
 * Transport — newline-delimited JSON framing over any duplex pair.
 *
 * The server side buffers messages that arrive before anyone attached a
 * handler, and flushes the backlog asynchronously on first attach — so a
 * client may start sending before the peer finished wiring its dispatcher.
 */

import type { Readable, Writable } from 'node:stream';
import type { RpcMessage } from './protocol';

export class LineCodec {
  private buffer = '';

  /** Feed a raw chunk; returns complete decoded messages (invalid lines skipped). */
  push(chunk: string): RpcMessage[] {
    this.buffer += chunk;
    const messages: RpcMessage[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line) as RpcMessage);
      } catch {
        // Not a valid frame — drop it rather than poison the channel.
      }
    }
    return messages;
  }

  static encode(msg: RpcMessage): string {
    return `${JSON.stringify(msg)}\n`;
  }
}

export interface RpcTransport {
  send(msg: RpcMessage): void;
  onMessage(handler: (msg: RpcMessage) => void): void;
  close(): void;
}

export function createStreamTransport(readable: Readable, writable: Writable): RpcTransport {
  const codec = new LineCodec();
  let closed = false;
  let handler: ((msg: RpcMessage) => void) | null = null;
  const inbox: RpcMessage[] = [];

  readable.setEncoding?.('utf-8');
  readable.on('data', (chunk: string) => {
    for (const msg of codec.push(chunk)) {
      if (handler) handler(msg);
      else inbox.push(msg);
    }
  });

  return {
    send(msg: RpcMessage): void {
      if (closed) return;
      writable.write(LineCodec.encode(msg));
    },
    onMessage(next: (msg: RpcMessage) => void): void {
      if (handler) throw new Error('transport supports a single message handler');
      handler = next;
      if (inbox.length > 0) {
        const backlog = inbox.splice(0, inbox.length);
        // Flush after the current synchronous block so the caller can finish
        // wiring its dispatch table first.
        queueMicrotask(() => {
          for (const msg of backlog) {
            if (handler) handler(msg);
          }
        });
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      writable.end();
    },
  };
}
