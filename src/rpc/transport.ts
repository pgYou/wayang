/**
 * Transport — newline-delimited JSON framing over any duplex byte pair.
 *
 * Layering:
 *   1. `LineCodec` — pure framing (bytes → messages). Reusable by every
 *      byte-stream transport (stdio, unix socket, TCP).
 *   2. `createTransport` — the single implementation of `RpcTransport` on
 *      top of a duplex byte pair. stdio, sockets and pipes all reduce to
 *      this once the connection is established.
 *   3. `createStreamTransport` — thin alias kept for call sites that
 *      already hold a Readable/Writable pair.
 *
 * Connection *establishment* (listen/connect/ready/teardown) is deliberately
 * NOT part of `RpcTransport` — it is transport-specific. Only the framing
 * and the message/error/close channels are shared, so a future socket
 * transport can reuse everything below without touching RpcServer/RpcClient.
 *
 * The receiving side buffers messages that arrive before anyone attached a
 * handler, and flushes the backlog asynchronously on first attach — so a
 * peer may start sending before the other side finished wiring its
 * dispatcher.
 */

import type { Duplex } from 'node:stream';
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

/**
 * Per-transport capabilities a caller may rely on. Declared explicitly so
 * consumers can branch without sniffing the implementation (e.g. "does this
 * transport give me a peer identity I can trust?").
 */
export interface TransportCapabilities {
  /** Framing strategy; always newline-delimited JSON in v1. */
  framing: 'ndjson';
  /**
   * Whether the underlying channel is only reachable by the two endpoints
   * (anonymous pipe) — i.e. the OS itself provides the access boundary.
   * False for named endpoints (socket file, TCP port), where an extra
   * authentication layer is required once multi-process access exists.
   */
  privateChannel: boolean;
  /** Human-readable transport kind, for logs and error messages. */
  kind: 'stdio' | 'socket' | 'other';
}

export interface TransportErrorEvent {
  /** Machine-readable reason; transport failures are never thrown at senders. */
  reason: 'read_error' | 'write_error' | 'closed';
  error?: Error;
}

export interface RpcTransport {
  readonly capabilities: TransportCapabilities;
  send(msg: RpcMessage): void;
  onMessage(handler: (msg: RpcMessage) => void): void;
  /** Observe peer/IO failures. Returns an unsubscribe fn. */
  onError(handler: (event: TransportErrorEvent) => void): () => void;
  close(): void;
  /** Whether `close()` was called or the peer went away. */
  isClosed(): boolean;
}

export interface TransportOptions {
  capabilities?: Partial<TransportCapabilities>;
}

const DEFAULT_CAPABILITIES: TransportCapabilities = {
  framing: 'ndjson',
  privateChannel: true,
  kind: 'stdio',
};

/**
 * Wrap an already-connected duplex pair (both sides are streams: one read,
 * one write — a Duplex, or any `{ readable, writable }` pair).
 */
export function createTransport(
  readable: NodeJS.ReadableStream,
  writable: NodeJS.WritableStream,
  options: TransportOptions = {},
): RpcTransport {
  const codec = new LineCodec();
  const capabilities: TransportCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  let closed = false;
  let handler: ((msg: RpcMessage) => void) | null = null;
  const inbox: RpcMessage[] = [];
  const errorHandlers = new Set<(event: TransportErrorEvent) => void>();

  const emitError = (event: TransportErrorEvent): void => {
    for (const h of errorHandlers) {
      try {
        h(event);
      } catch {
        // A faulty observer must not break the channel.
      }
    }
  };

  const markClosed = (reason: TransportErrorEvent['reason'], error?: Error): void => {
    if (closed) return;
    closed = true;
    // Every terminal transition is observable — including a clean peer EOF,
    // which callers must not mistake for "still connected".
    emitError({ reason, error });
  };

  const readableStream = readable as NodeJS.ReadableStream & { setEncoding?: (enc: string) => void };
  readableStream.setEncoding?.('utf-8');
  readable.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    for (const msg of codec.push(text)) {
      if (handler) handler(msg);
      else inbox.push(msg);
    }
  });
  readable.on('error', (error: Error) => markClosed('read_error', error));
  readable.on('end', () => markClosed('closed'));
  // `close` fires when the underlying handle is destroyed without a clean EOF —
  // which is exactly what happens when the peer process is SIGKILLed. `end`
  // alone does not cover that case, so a crashed server would otherwise leave
  // every pending request hanging forever.
  readable.on('close', () => markClosed('closed'));
  writable.on('error', (error: Error) => markClosed('write_error', error));
  writable.on('close', () => markClosed('closed'));

  return {
    capabilities,

    send(msg: RpcMessage): void {
      if (closed) return;
      try {
        writable.write(LineCodec.encode(msg));
      } catch (error) {
        markClosed('write_error', error instanceof Error ? error : new Error(String(error)));
      }
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

    onError(next: (event: TransportErrorEvent) => void): () => void {
      errorHandlers.add(next);
      return () => errorHandlers.delete(next);
    },

    close(): void {
      if (closed) {
        // Still try to end the writable side so the peer sees EOF.
        try {
          writable.end();
        } catch {
          // already gone
        }
        return;
      }
      // Local close is a terminal transition like any other: run the same
      // bookkeeping so pending callers are released and observers hear
      // exactly one `closed` event.
      markClosed('closed');
      try {
        writable.end();
      } catch {
        // best effort: the peer may already have gone away
      }
    },

    isClosed(): boolean {
      return closed;
    },
  };
}

/**
 * Backwards-compatible helper: a Readable + Writable pair (the stdio shape).
 * Behaviour is identical to `createTransport`; kept so existing call sites
 * and tests keep working unchanged.
 */
export function createStreamTransport(
  readable: NodeJS.ReadableStream,
  writable: NodeJS.WritableStream,
  options: TransportOptions = {},
): RpcTransport {
  return createTransport(readable, writable, options);
}

/**
 * Convenience: wrap a single Duplex (e.g. a unix socket). The socket is
 * both the readable and writable side, so this is the natural adapter a
 * future socket transport will use.
 */
export function createDuplexTransport(duplex: Duplex, options: TransportOptions = {}): RpcTransport {
  const given = options.capabilities ?? {};
  return createTransport(duplex, duplex, {
    ...options,
    capabilities: {
      ...given,
      // A named endpoint is reachable by other processes, so the OS is no
      // longer the access boundary — callers must add authentication.
      privateChannel: given.privateChannel ?? false,
      kind: given.kind ?? 'socket',
    },
  });
}
