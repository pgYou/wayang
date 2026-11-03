import pino from 'pino';
import { EventEmitter } from 'node:events';

export type Logger = pino.Logger;

/**
 * Minimal surface of a pino transport (thread-stream) that we rely on to
 * close it. Declared structurally so we do not depend on transitive typings.
 */
interface TransportStream extends EventEmitter {
  write(msg: string): boolean;
  /** Flush buffered data and signal the worker that no more is coming. */
  end(): void;
  /** True once the stream errored out and the worker was terminated. */
  readonly destroyed: boolean;
  /** True once the underlying worker thread has exited. */
  readonly closed: boolean;
}

/** A logger plus an awaitable, idempotent close path for its file sink. */
export interface FileLogger {
  logger: Logger;
  /**
   * Flush and close the file sink; resolves once the transport worker thread
   * has exited. After `await close()` resolves, this logger will never write
   * to the log file's directory again. Idempotent: repeated calls return the
   * same promise. Log calls made after (or racing with) close are safely
   * ignored — they never throw and never crash the caller.
   */
  close(): Promise<void>;
}

/**
 * End a pino transport's worker thread and resolve once it has fully exited.
 *
 * Relies on thread-stream semantics:
 * - `end()` flushes everything buffered, then blocks until the worker has
 *   consumed it and acknowledged the end signal. The worker opens the
 *   destination file during startup (before it can consume anything), so by
 *   the time end() completes the file has been created — or its open failed
 *   and the stream is already destroyed.
 * - After processing the end signal the worker exits by itself, and 'close'
 *   fires on the main thread once the thread is gone.
 * - When an async flush is still in flight, the real end is deferred to the
 *   flush tail, so we await 'close' instead of trusting end() to block.
 * - Writes made after end() emit 'error' asynchronously. pino child loggers
 *   copy their level at creation time and cannot be silenced retroactively,
 *   so a no-op 'error' listener is the only reliable way to make late
 *   writes harmless instead of fatal ("Unhandled 'error' event").
 */
function closeTransport(transport: TransportStream): Promise<void> {
  return new Promise<void>((resolve) => {
    // Must be attached before end(): writes racing with close (e.g. from
    // child loggers held by other components) land here and are dropped.
    transport.on('error', () => {
      /* late writes after close are ignored on purpose */
    });
    if (transport.closed || transport.destroyed) {
      resolve();
      return;
    }
    transport.once('close', () => resolve());
    try {
      transport.end();
    } catch {
      // A wedged worker makes end() throw; the stream then destroys itself
      // and still emits 'close'. Teardown must never break the exit flow.
    }
  });
}

/**
 * Create a logger that pretty-prints to a file via a pino transport worker
 * thread, and expose an awaitable close for that sink.
 *
 * The transport opens the destination file asynchronously from its worker
 * thread (even at level 'silent', with no log line ever written). Callers
 * that need the directory to be quiescent — e.g. before deleting it — must
 * `await close()` first.
 */
export function createFileLogger(level: string, logFilePath: string): FileLogger {
  const transport: TransportStream = pino.transport({
    target: 'pino-pretty',
    options: {
      destination: logFilePath,
      colorize: false,
      singleLine: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:HH:MM:ss.l',
    },
  });

  const logger = pino(
    {
      level,
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    transport,
  );

  let closePromise: Promise<void> | undefined;
  return {
    logger,
    close: () => (closePromise ??= closeTransport(transport)),
  };
}

/** File-only logger for TUI mode: pretty-printed to file, no terminal output. */
export function createLogger(level: string = 'info', logFilePath?: string): Logger {
  if (logFilePath) {
    return createFileLogger(level, logFilePath).logger;
  }

  // No file path (e.g. tests): silent unless explicitly set
  if (level === 'silent') {
    return pino(
      { level, serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err } },
      pino.destination('/dev/null'),
    );
  }

  // Fallback: pretty to stderr only
  return pino(
    { level, serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err } },
    pino.transport({ target: 'pino-pretty', options: { colorize: true, destination: 2 } }),
  );
}

/** Create a child logger with module context. */
export function createChildLogger(parent: Logger, module: string): Logger {
  return parent.child({ module });
}
