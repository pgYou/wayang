/**
 * ACP subprocess and ndjson transport.
 *
 * Contract: docs/design/acp/00-interface-freeze.md §2.2. Responsibilities:
 * spawn (stdio x3 pipes), line framing over stdout, stderr line buffering,
 * exit/error events with single settlement, and the SIGTERM → grace → SIGKILL
 * kill ladder. Non-JSON stdout lines are surfaced verbatim — the client
 * classifies them.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { AcpLaunchConfig } from './config';
import { AcpError } from './errors';
import type { AcpCloseReason, AcpExitInfo } from './types';

export type { AcpCloseReason, AcpExitInfo } from './types';

export const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;

const STDERR_MAX_LINE_BYTES = 1024 * 1024;
const STDERR_TAIL_LINES = 50;
const STDERR_LINE_CHAR_LIMIT = 4000;

type Handler<T> = (value: T) => void;

class HandlerSet<T> {
  private readonly handlers = new Set<Handler<T>>();

  add(handler: Handler<T>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(value: T, onHandlerError?: (err: unknown) => void): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(value);
      } catch (err) {
        onHandlerError?.(err);
      }
    }
  }
}

/**
 * Incremental ndjson line splitter over byte chunks. UTF-8 safe (a multi-byte
 * sequence never contains 0x0A, so byte-level splitting never cuts a code
 * point). The final line without a trailing newline is legal ndjson and is
 * returned by `finish()`. Oversized frames throw `AcpError('protocol-mismatch')`
 * and poison the decoder.
 *
 * Exported beyond the frozen symbol table so framing edge cases (chunk
 * boundaries, split UTF-8, oversized frames, trailing fragments) can be unit
 * tested deterministically.
 */
export class LineDecoder {
  private readonly maxLineBytes: number;
  private readonly utf8 = new TextDecoder('utf-8');
  private buffer: Buffer = Buffer.alloc(0);
  private poisoned = false;

  constructor(options?: { maxLineBytes?: number }) {
    this.maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /** Feed one stdout chunk; returns every complete decoded line it completes. */
  push(chunk: Buffer): string[] {
    this.assertNotPoisoned();
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      const lineBytes = this.buffer.subarray(0, newline);
      if (lineBytes.length > this.maxLineBytes) {
        this.poison(`line exceeds ${this.maxLineBytes} bytes (got ${lineBytes.length})`);
      }
      lines.push(this.decode(lineBytes));
      this.buffer = this.buffer.subarray(newline + 1);
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.poison(`line exceeds ${this.maxLineBytes} bytes (got ${this.buffer.length} and still no newline)`);
    }
    return lines;
  }

  /** Flush the residual (possibly incomplete) line at end-of-stream. Null when nothing is buffered. */
  finish(): string | null {
    this.assertNotPoisoned();
    if (this.buffer.length === 0) return null;
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return this.decode(rest);
  }

  /** Bytes buffered for the current incomplete line. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  private decode(bytes: Buffer): string {
    const withoutCr = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.subarray(0, -1) : bytes;
    return this.utf8.decode(withoutCr);
  }

  private poison(reason: string): never {
    this.buffer = Buffer.alloc(0);
    this.poisoned = true;
    throw new AcpError('protocol-mismatch', `ndjson framing error: ${reason}`);
  }

  private assertNotPoisoned(): void {
    if (this.poisoned) {
      throw new AcpError('protocol-mismatch', 'ndjson framing error: decoder poisoned by a previous oversized frame');
    }
  }
}

export interface AcpTransport {
  /** spawn (detached:false, stdio x3 pipes). ENOENT/EACCES/ENOEXEC → AcpError('cli-missing'). */
  start(): Promise<void>;
  /** Write one ndjson line (without newline; the implementation appends '\n'). No-op + debug count after close. */
  write(line: string): void;
  /** Idempotent. Sequence: SIGTERM → sigtermWaitMs → SIGKILL; exit and error double-arrival settles once. */
  close(opts: { sigtermWaitMs: number; reason: AcpCloseReason }): Promise<AcpExitInfo>;
  /** stdout by line; non-JSON lines are surfaced verbatim for the client to classify. */
  onMessage(handler: (line: string) => void): () => void;
  onClose(handler: (info: AcpExitInfo) => void): () => void;
  /** Stream errors after spawn. */
  onError(handler: (err: Error) => void): () => void;
  /** Last 50 stderr lines for error attribution (the message template truncates further). */
  stderrTail(): string[];
  readonly pid: number | null;
}

/**
 * Beyond freeze (see delivery report): push channel for stderr lines. The
 * frozen §4 'auth-required' row requires a stderr hit to short-circuit
 * "without waiting for the timeout", which needs a subscription —
 * `stderrTail()` alone is pull-only. `StdioAcpTransport` implements it; the
 * client feature-detects it.
 */
export interface StderrAcpTransport extends AcpTransport {
  onStderr(handler: (line: string) => void): () => void;
}

/** Subscribe to stderr lines when the transport supports it; no-op otherwise. */
export function onStderrIfAvailable(transport: AcpTransport, handler: (line: string) => void): () => void {
  const candidate = transport as Partial<StderrAcpTransport>;
  return typeof candidate.onStderr === 'function' ? candidate.onStderr(handler) : () => undefined;
}

/** Debug counters for no-op paths and kill escalations (the layer has no logger by contract). */
export interface AcpTransportStats {
  writesAfterClose: number;
  framingErrors: number;
  sigtermKills: number;
  sigkillEscalations: number;
  stderrDroppedLines: number;
  handlerErrors: number;
}

export class StdioAcpTransport implements StderrAcpTransport {
  private readonly config: AcpLaunchConfig;
  private readonly maxLineBytes: number;
  private readonly statsValue: AcpTransportStats = {
    writesAfterClose: 0,
    framingErrors: 0,
    sigtermKills: 0,
    sigkillEscalations: 0,
    stderrDroppedLines: 0,
    handlerErrors: 0,
  };

  private child: ChildProcess | null = null;
  private started = false;
  private startFailed: AcpError | null = null;
  private decoder = new LineDecoder();
  private stderrDecoder = new LineDecoder({ maxLineBytes: STDERR_MAX_LINE_BYTES });
  private stderrLines: string[] = [];
  private stdoutDead = false;
  private stdoutFlushed = false;

  private readonly messageHandlers = new HandlerSet<string>();
  private readonly closeHandlers = new HandlerSet<AcpExitInfo>();
  private readonly errorHandlers = new HandlerSet<Error>();
  private readonly stderrHandlers = new HandlerSet<string>();

  private exitInfo: AcpExitInfo | null = null;
  private exitWaiters: Array<(info: AcpExitInfo) => void> = [];
  private closing: { sigtermWaitMs: number; reason: AcpCloseReason } | null = null;
  private closePromise: Promise<AcpExitInfo> | null = null;

  constructor(config: AcpLaunchConfig) {
    this.config = config;
    this.maxLineBytes = config.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.decoder = new LineDecoder({ maxLineBytes: this.maxLineBytes });
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get stats(): AcpTransportStats {
    return this.statsValue;
  }

  async start(): Promise<void> {
    if (this.started) {
      if (this.startFailed) throw this.startFailed;
      if (this.closing) throw new AcpError('transport-closed', 'transport is closing');
      return;
    }
    if (this.closing) throw new AcpError('transport-closed', 'transport already closed');
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(this.config.command, [...this.config.args], {
          cwd: this.config.cwd,
          env: this.config.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: false,
        });
      } catch (err) {
        reject(this.toCliMissing(err));
        return;
      }
      this.child = child;
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) {
          // Post-spawn error (e.g. kill ESRCH): settle as a crash if exit hasn't already.
          this.emitError(err instanceof Error ? err : new Error(String(err)));
          this.settleExit({ code: null, signal: null });
          return;
        }
        settled = true;
        this.startFailed = this.toCliMissing(err);
        reject(this.startFailed);
      });
      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        this.wireStreams(child);
        resolve();
        // close() may have been requested while spawn was in flight.
        if (this.closing && !this.closePromise && !this.exitInfo) {
          this.closePromise = this.terminate(this.closing);
        }
      });
    });
  }

  write(line: string): void {
    const child = this.child;
    if (!child || this.exitInfo || this.closing || this.startFailed || child.stdin?.writable !== true) {
      this.statsValue.writesAfterClose += 1;
      return;
    }
    child.stdin.write(`${line}\n`);
  }

  close(opts: { sigtermWaitMs: number; reason: AcpCloseReason }): Promise<AcpExitInfo> {
    if (this.closePromise) return this.closePromise;
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    this.closing = opts;
    this.closePromise = this.terminate(opts);
    return this.closePromise;
  }

  onMessage(handler: (line: string) => void): () => void {
    return this.messageHandlers.add(handler);
  }

  onClose(handler: (info: AcpExitInfo) => void): () => void {
    return this.closeHandlers.add(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    return this.errorHandlers.add(handler);
  }

  onStderr(handler: (line: string) => void): () => void {
    return this.stderrHandlers.add(handler);
  }

  stderrTail(): string[] {
    return [...this.stderrLines];
  }

  // --- internals ---

  private toCliMissing(err: unknown): AcpError {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    const reason = code ? `${code}: ${message}` : message;
    return new AcpError('cli-missing', `spawn "${this.config.command}" failed: ${reason}`, undefined);
  }

  private wireStreams(child: ChildProcess): void {
    child.stdin?.on('error', () => {
      // EPIPE after child death — the exit event settles everything.
      this.statsValue.writesAfterClose += 1;
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.stdoutDead) return;
      try {
        for (const line of this.decoder.push(chunk)) this.emitMessage(line);
      } catch (err) {
        this.handleFramingError(err);
      }
    });
    const flushStdout = () => {
      if (this.stdoutFlushed) return;
      this.stdoutFlushed = true;
      if (this.stdoutDead) return;
      try {
        const rest = this.decoder.finish();
        if (rest !== null) this.emitMessage(rest);
      } catch (err) {
        this.handleFramingError(err);
      }
    };
    child.stdout?.on('end', flushStdout);
    child.stdout?.on('close', flushStdout);
    child.stdout?.on('error', (err: Error) => {
      this.emitError(err);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        for (const line of this.stderrDecoder.push(chunk)) this.emitStderr(line);
      } catch {
        // Never fatal: drop the runaway stderr line and rebuild the decoder.
        this.statsValue.stderrDroppedLines += 1;
        this.stderrDecoder = new LineDecoder({ maxLineBytes: STDERR_MAX_LINE_BYTES });
      }
    });
    child.stderr?.on('end', () => {
      const rest = this.stderrDecoder.finish();
      if (rest !== null) this.emitStderr(rest);
    });
    child.stderr?.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      this.settleExit({ code, signal: signal as NodeJS.Signals | null });
    });
  }

  private emitMessage(line: string): void {
    this.messageHandlers.emit(line, () => {
      this.statsValue.handlerErrors += 1;
    });
  }

  private emitStderr(line: string): void {
    const trimmed = line.length > STDERR_LINE_CHAR_LIMIT ? line.slice(0, STDERR_LINE_CHAR_LIMIT) : line;
    this.stderrLines.push(trimmed);
    if (this.stderrLines.length > STDERR_TAIL_LINES) {
      this.stderrLines.splice(0, this.stderrLines.length - STDERR_TAIL_LINES);
    }
    this.stderrHandlers.emit(trimmed, () => {
      this.statsValue.handlerErrors += 1;
    });
  }

  private emitError(err: Error): void {
    this.errorHandlers.emit(err, () => {
      this.statsValue.handlerErrors += 1;
    });
  }

  private handleFramingError(err: unknown): void {
    this.stdoutDead = true;
    this.statsValue.framingErrors += 1;
    const error =
      err instanceof AcpError
        ? err
        : new AcpError('protocol-mismatch', `ndjson framing error: ${err instanceof Error ? err.message : String(err)}`);
    this.emitError(error);
    if (!this.closePromise && !this.exitInfo) {
      this.closing = { sigtermWaitMs: this.config.timeouts.sigtermWaitMs, reason: 'crash' };
      this.closePromise = this.terminate(this.closing);
    }
  }

  private async terminate(opts: { sigtermWaitMs: number; reason: AcpCloseReason }): Promise<AcpExitInfo> {
    const child = this.child;
    if (!child || child.pid === undefined || this.exitInfo) {
      // Never started, spawn failed, or already gone: settle (or return the
      // recorded info) without touching any process.
      return this.settleExit({ code: null, signal: null });
    }
    this.statsValue.sigtermKills += 1;
    this.safeKill(child, 'SIGTERM');
    if (!(await this.waitForExit(opts.sigtermWaitMs))) {
      this.statsValue.sigkillEscalations += 1;
      this.safeKill(child, 'SIGKILL');
      if (!(await this.waitForExit(opts.sigtermWaitMs))) {
        // Pathological: unreapable process. Settle best-effort so no caller hangs.
        return this.settleExit({ code: null, signal: 'SIGKILL' });
      }
    }
    return this.awaitSettled();
  }

  private safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // ESRCH & friends: exit is imminent or already reaped.
    }
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) this.exitWaiters.splice(index, 1);
        resolve(false);
      }, ms);
      const waiter = (_info: AcpExitInfo) => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitWaiters.push(waiter);
    });
  }

  private async awaitSettled(): Promise<AcpExitInfo> {
    if (this.exitInfo) return this.exitInfo;
    return new Promise<AcpExitInfo>((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  /** Record the exit exactly once, notify close handlers, resolve waiters. */
  private settleExit(partial: { code: number | null; signal: NodeJS.Signals | null }): AcpExitInfo {
    if (this.exitInfo) return this.exitInfo;
    const reason = this.closing?.reason ?? 'crash';
    this.exitInfo = {
      code: partial.code,
      signal: partial.signal,
      reason,
      cancelled: reason === 'cancel',
    };
    this.child?.stdin?.destroy();
    const info = this.exitInfo;
    for (const waiter of this.exitWaiters.splice(0)) waiter(info);
    this.closeHandlers.emit(info, () => {
      this.statsValue.handlerErrors += 1;
    });
    return info;
  }
}
