/**
 * Main-process logger — the shell's own observability.
 *
 * The wayang server (utility process) already writes <sessionDir>/wayang.log
 * through SystemContext; this logger covers everything the shell does around
 * it: boot, connection lifecycle, IPC surface, quit. It lands in Electron's
 * standard logs dir (macOS: ~/Library/Logs/wayang-desktop/main.log) so
 * app-shell concerns stay out of ~/.wayang session data. Console echo makes
 * `npm run dev` and Console.app (packaged) show the same stream.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createFileLogger, type Logger } from '@wayang-ai/core/infra/logger';
import { getPaths } from '../shared/platform-config';

export interface MainLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(module: string): MainLogger;
  /** Flush and close the file sink; safe to call repeatedly. */
  close(): Promise<void>;
}

let active: MainLogger | null = null;

/** Idempotent: the first call wins, later calls return the same logger. */
export function initMainLogger(level: string = 'info'): MainLogger {
  if (active) return active;
  // Logs dir via the platform config module (决策十) — the module is the
  // only place allowed to touch Electron's path API.
  const dir = getPaths().logs;
  mkdirSync(dir, { recursive: true });
  const file = createFileLogger(level, join(dir, 'main.log'));

  const wrap = (module?: string): MainLogger => {
    const logger: Logger = module ? file.logger.child({ module }) : file.logger;
    const echo = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void => {
      logger[level](data, msg);
      const now = new Date();
      const time = `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`;
      const parts = [time, level.toUpperCase().padEnd(5)];
      if (module) parts.push(`[${module}]`);
      parts.push(msg);
      if (data) parts.push(JSON.stringify(data));
      const line = parts.join(' ');
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    };
    return {
      debug: (msg, data) => echo('debug', msg, data),
      info: (msg, data) => echo('info', msg, data),
      warn: (msg, data) => echo('warn', msg, data),
      error: (msg, data) => echo('error', msg, data),
      child: (childModule) => wrap(module ? `${module}.${childModule}` : childModule),
      close: () => file.close(),
    };
  };

  active = wrap();
  return active;
}

/** The process-wide logger; throws if initMainLogger has not run yet. */
export function mainLogger(): MainLogger {
  if (!active) throw new Error('initMainLogger() must run before mainLogger()');
  return active;
}
