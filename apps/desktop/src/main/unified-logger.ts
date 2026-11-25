/**
 * UnifiedLogger (desktop-app-design §2.9, 4.2 域二工作项②).
 *
 * The logging facade over the existing main-process file logger — the
 * "底层接现有 logger" requirement: the sink, the file layout and the console
 * echo all stay in logger.ts; this class adds the unified concerns:
 *   - correlation context (`{proc, ...}` merged into every entry, extendable
 *     with windowId / sessionId / reqId as those surfaces land),
 *   - the renderer log bridge sink (`wayang:rendererLog` entries land here
 *     tagged `proc: renderer`),
 *   - crash records for `render-process-gone` / `child-process-gone`.
 */

import type { MainLogger } from './logger';
import type { RendererLogEntry } from '../shared/ipc-contract';

export type CrashSource = 'render-process-gone' | 'child-process-gone';

export class UnifiedLogger implements MainLogger {
  /** The renderer log bridge sink, created lazily on first use. */
  private rendererSink: UnifiedLogger | null = null;

  constructor(
    private readonly inner: MainLogger,
    private readonly context: Record<string, unknown> = { proc: 'main' },
  ) {}

  /** Merge the correlation context into an entry's data. */
  private entry(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    return data === undefined ? { ...this.context } : { ...this.context, ...data };
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.inner.debug(msg, this.entry(data));
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.inner.info(msg, this.entry(data));
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.inner.warn(msg, this.entry(data));
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.inner.error(msg, this.entry(data));
  }

  child(module: string): MainLogger {
    return new UnifiedLogger(this.inner.child(module), this.context);
  }

  /** The renderer log bridge sink (§2.9): entries arrive over IPC. */
  renderer(entry: RendererLogEntry): void {
    // The renderer bridge gets its own child logger so renderer entries are
    // visually and structurally separable in the unified file.
    this.rendererSink ??= new UnifiedLogger(this.inner.child('renderer'), { proc: 'renderer' });
    this.rendererSink[entry.level](entry.message, entry.data);
  }

  /** Crash records (§2.9): renderer or child process death diagnostics. */
  crash(source: CrashSource, details: Record<string, unknown>): void {
    this.inner.error(`crash: ${source}`, { proc: 'main', source, ...details });
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
