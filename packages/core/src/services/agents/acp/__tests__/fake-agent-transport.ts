/**
 * In-memory fake ACP agent transport for client tests.
 *
 * COPIED VERBATIM from `src/services/acp/__tests__/fake-agent-transport.ts`
 * (worker-layer C1 tests must not import across the protocol layer's test
 * directory, and must not modify the protocol layer's copy either).
 *
 * Implements the full AcpTransport surface (plus the StderrAcpTransport
 * extension) with no process behind it. The "agent side" is driven by the
 * test: feedChunk/agentMessage push bytes through the REAL LineDecoder so
 * framing behavior matches StdioAcpTransport, and client writes are captured
 * for assertions. Everything is event-driven — no sleeps.
 */

import { expect } from 'vitest';
import type { AcpClient, AcpClientOptions } from '@/services/acp/client';
import { AcpError, type AcpErrorCode } from '@/services/acp/errors';
import { LineDecoder, type AcpCloseReason, type AcpExitInfo, type StderrAcpTransport } from '@/services/acp/transport';

export class FakeAgentTransport implements StderrAcpTransport {
  private readonly decoder = new LineDecoder({ maxLineBytes: 1024 * 1024 });
  private readonly messageHandlers = new Set<(line: string) => void>();
  private readonly closeHandlers = new Set<(info: AcpExitInfo) => void>();
  private readonly errorHandlers = new Set<(err: Error) => void>();
  private readonly stderrHandlers = new Set<(line: string) => void>();
  private readonly clientLines: string[] = [];
  private readonly clientLineWaiters: Array<() => void> = [];
  private readonly closeOptions: Array<{ sigtermWaitMs: number; reason: AcpCloseReason }> = [];
  private stderrLines: string[] = [];
  private lastExitInfo: AcpExitInfo | null = null;
  private closed = false;
  readonly pid = 424242;
  readonly stats = { writesAfterClose: 0 };

  // --- AcpTransport surface ---

  async start(): Promise<void> {}

  write(line: string): void {
    if (this.closed) {
      this.stats.writesAfterClose += 1;
      return;
    }
    this.clientLines.push(line);
    for (const waiter of this.clientLineWaiters.splice(0)) waiter();
  }

  async close(opts: { sigtermWaitMs: number; reason: AcpCloseReason }): Promise<AcpExitInfo> {
    this.closeOptions.push(opts);
    if (this.lastExitInfo) return this.lastExitInfo;
    const info: AcpExitInfo = { code: 0, signal: null, reason: opts.reason, cancelled: opts.reason === 'cancel' };
    this.simulateExit(info);
    return info;
  }

  onMessage(handler: (line: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (info: AcpExitInfo) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onStderr(handler: (line: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  stderrTail(): string[] {
    return [...this.stderrLines];
  }

  // --- fake agent side ---

  /** Feed raw stdout bytes (string is UTF-8 encoded); runs through the real LineDecoder. */
  feedChunk(chunk: string | Buffer): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
    for (const line of this.decoder.push(bytes)) {
      for (const handler of [...this.messageHandlers]) handler(line);
    }
  }

  /** The agent sends one complete ndjson line. */
  agentLine(line: string): void {
    this.feedChunk(`${line}\n`);
  }

  /** The agent sends one JSON message. */
  agentMessage(message: unknown): void {
    this.agentLine(JSON.stringify(message));
  }

  /** End of stdout: flush a trailing fragment without newline. */
  endStdout(): void {
    const rest = this.decoder.finish();
    if (rest !== null) {
      for (const handler of [...this.messageHandlers]) handler(rest);
    }
  }

  emitStderrLine(line: string): void {
    this.stderrLines.push(line);
    for (const handler of [...this.stderrHandlers]) handler(line);
  }

  /** The process dies on its own (crash, or a settle from a prior close). */
  simulateExit(info: AcpExitInfo): void {
    if (this.lastExitInfo) return;
    this.closed = true;
    this.lastExitInfo = info;
    for (const handler of [...this.closeHandlers]) handler(info);
  }

  emitStreamError(err: Error): void {
    for (const handler of [...this.errorHandlers]) handler(err);
  }

  // --- test assertions ---

  /** Every line the client has written (serialized JSON-RPC messages). */
  get clientOutput(): string[] {
    return [...this.clientLines];
  }

  /** Parsed client messages, in order. */
  get clientMessages(): any[] {
    return this.clientLines.map((line) => JSON.parse(line));
  }

  /** All close() options the client passed, in order. */
  get closeCalls(): Array<{ sigtermWaitMs: number; reason: AcpCloseReason }> {
    return [...this.closeOptions];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Wait (event-driven) until the client has written at least n lines. */
  async waitForClientOutput(n: number): Promise<string[]> {
    while (this.clientLines.length < n) {
      await new Promise<void>((resolve) => this.clientLineWaiters.push(resolve));
    }
    return [...this.clientLines];
  }
}

/** Build client options with fast defaults for tests (overridable per test). */
export function makeClientOptions(overrides: Partial<AcpClientOptions> = {}): AcpClientOptions {
  return {
    clientInfo: { name: 'wayang-test', version: '0.9.0-test' },
    timeouts: {
      handshakeMs: 15_000,
      sessionNewMs: 30_000,
      promptMs: 0,
      permissionMs: 300_000,
      cancelGraceMs: 5_000,
      sigtermWaitMs: 2_000,
    },
    ...overrides,
  };
}

/** Await `promise` and assert it rejects with an AcpError of the given code; return the error. */
export async function expectAcpError(promise: Promise<unknown>, code: AcpErrorCode): Promise<AcpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AcpError);
    const acpError = err as AcpError;
    expect(acpError.code).toBe(code);
    return acpError;
  }
  throw new Error(`expected the promise to reject with AcpError('${code}'), but it resolved`);
}

/** A promise the test controls from the outside (for pending permission handlers etc.). */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Track whether a promise has settled without awaiting it. */
export function settlementTracker<T>(promise: Promise<T>): { settled: () => Promise<boolean> } {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return {
    async settled() {
      await Promise.resolve();
      return done;
    },
  };
}

export type { AcpClient };
