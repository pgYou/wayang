import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { RotatingFileSink } from './rotating-file-sink';

export type Logger = pino.Logger;

/** Default rotation policy for the session log (issue #52): 10MB × 3 backups. */
export const DEFAULT_LOG_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 3;

/** Rotation knobs for {@link createFileLogger}; defaults above when omitted. */
export interface FileLoggerOptions {
  /** Max bytes the active log file may reach before rotation. */
  maxFileSizeBytes?: number;
  /** Number of rotated files (`wayang.log.1` … `.N`) to retain. */
  maxFiles?: number;
}

/** A logger plus an awaitable, idempotent close path for its file sink. */
export interface FileLogger {
  logger: Logger;
  /**
   * Flush and close the file sink; resolves once every accepted line is on
   * disk and the sink will never write to the log file's directory again.
   * Idempotent: repeated calls return the same promise. Log calls made after
   * (or racing with) close are safely ignored — they never throw and never
   * crash the caller.
   */
  close(): Promise<void>;
}

/**
 * Create a logger that pretty-prints to a size-rotated file.
 *
 * pino-pretty runs on the MAIN thread here (not in a pino transport worker):
 * its destination is our {@link RotatingFileSink}, the only thing that touches
 * the log directory. Appends are synchronous, so closing is trivial — end the
 * sink, and once its 'close' fires (autoDestroy after the final sync write)
 * the file is fully quiescent. Writes racing with or landing after close hit
 * an ended/destroyed stream: the no-op 'error' listeners below swallow them
 * instead of letting them crash the caller (the contract FileLogger documents).
 */
export function createFileLogger(
  level: string,
  logFilePath: string,
  options?: FileLoggerOptions,
): FileLogger {
  const sink = new RotatingFileSink(logFilePath, {
    maxFileSizeBytes: options?.maxFileSizeBytes ?? DEFAULT_LOG_MAX_FILE_SIZE_BYTES,
    maxFiles: options?.maxFiles ?? DEFAULT_LOG_MAX_FILES,
  });

  const pretty = pinoPretty({
    colorize: false,
    singleLine: true,
    ignore: 'pid,hostname',
    translateTime: 'SYS:HH:MM:ss.l',
    destination: sink,
  });

  // Late writes after close land on an ended stream and surface as an
  // asynchronous 'error' — ignore them on purpose (see FileLogger.close).
  pretty.on('error', () => {
    /* late writes after close are ignored on purpose */
  });
  sink.on('error', () => {
    /* append failures are handled inside the sink */
  });

  const logger = pino(
    {
      level,
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    pretty,
  );

  let closePromise: Promise<void> | undefined;
  return {
    logger,
    close: () =>
      (closePromise ??= new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const endSink = () => {
          sink.once('close', settle);
          try {
            sink.end();
          } catch {
            settle();
          }
        };
        // Drain the pretty pipe first: its 'finish' fires once every accepted
        // line has been handed down to the sink, so ending the sink right
        // after cannot drop a line that was logged before close(). The sink's
        // writes are synchronous, so its 'close' (autoDestroy after 'finish')
        // means the file is fully on disk. The pump's own end propagation may
        // end the sink first — a second end() throws and settles instead of
        // hanging shutdown.
        if (pretty.destroyed || pretty.writableEnded) {
          endSink();
          return;
        }
        pretty.once('finish', endSink);
        pretty.once('error', endSink);
        try {
          pretty.end();
        } catch {
          endSink();
        }
      })),
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
