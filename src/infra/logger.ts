import pino from 'pino';
import { join } from 'node:path';

export type Logger = pino.Logger;

/** File-only logger for TUI mode: pretty-printed to file, no terminal output. */
export function createLogger(level: string = 'info', logFilePath?: string): Logger {
  const opts: pino.LoggerOptions = {
    level,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (logFilePath) {
    // Pretty-printed to file for readability, no terminal output to avoid cluttering Ink TUI
    return pino(opts, pino.transport({
      target: 'pino-pretty',
      options: {
        destination: logFilePath,
        colorize: false,
        singleLine: true,
        ignore: 'pid,hostname',
        translateTime: 'SYS:HH:MM:ss.l',
      },
    }));
  }

  // No file path (e.g. tests): silent unless explicitly set
  if (level === 'silent') {
    return pino(opts, pino.destination('/dev/null'));
  }

  // Fallback: pretty to stderr only
  return pino(opts, pino.transport({ target: 'pino-pretty', options: { colorize: true, destination: 2 } }));
}

/** Create a child logger with module context. */
export function createChildLogger(parent: Logger, module: string): Logger {
  return parent.child({ module });
}
