/**
 * MessagePort adapter — bridges a message-port channel (Electron UtilityProcess,
 * MessageChannelMain, worker_threads) onto the `{ stdin, stdout }` stream pair
 * that `runWayangServer(options, io)` consumes.
 *
 * Framing is unchanged: the server still speaks NDJSON through
 * createStreamTransport; each port message carries one chunk of that byte
 * stream. Port types are structural, so protocol stays Electron-free.
 */

import { Readable, Writable } from 'node:stream';

/**
 * Minimal structural surface shared by Electron's MessagePortMain /
 * UtilityProcess and worker_threads' MessagePort.
 */
export interface MessagePortLike {
  postMessage(data: unknown): void;
  addListener(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  removeListener(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

export interface PortStreams {
  stdin: Readable;
  stdout: Writable;
}

/**
 * Adapt a message port into the io pair the wayang server expects.
 * Messages that arrive before the server attaches a reader are buffered by
 * the Readable itself, so wiring order does not matter.
 */
export function messagePortToStreams(port: MessagePortLike): PortStreams {
  const stdin = new Readable({ read() { /* push-driven */ } });
  const onMessage = (event: { data: unknown }): void => {
    if (typeof event.data === 'string') {
      stdin.push(event.data, 'utf8');
    } else if (event.data != null) {
      stdin.push(String(event.data), 'utf8');
    }
  };
  port.addListener('message', onMessage);

  const stdout = new Writable({
    write(chunk, _enc, callback) {
      try {
        const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
        port.postMessage(text);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    final(callback) {
      try {
        port.removeListener('message', onMessage);
      } catch {
        /* port already closed */
      }
      callback();
    },
  });

  return { stdin, stdout };
}
