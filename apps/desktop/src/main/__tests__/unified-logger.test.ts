import { describe, it, expect, vi } from 'vitest';
import { UnifiedLogger } from '../unified-logger';
import type { MainLogger } from '../logger';

/**
 * UnifiedLogger pins (§2.9, 4.2 验收「render-process-gone / child-process-gone
 * 记录入统一日志」): the facade delegates to the existing main logger while
 * adding the correlation context, the renderer log bridge sink and the crash
 * records.
 */
describe('UnifiedLogger (§2.9 三进程日志汇聚)', () => {
  const makeInner = (): MainLogger & { calls: Array<[string, string, Record<string, unknown> | undefined]> } => {
    const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const wrap = (prefix: string) => ({
      debug: (msg: string, data?: Record<string, unknown>) => calls.push([`${prefix}debug`, msg, data]),
      info: (msg: string, data?: Record<string, unknown>) => calls.push([`${prefix}info`, msg, data]),
      warn: (msg: string, data?: Record<string, unknown>) => calls.push([`${prefix}warn`, msg, data]),
      error: (msg: string, data?: Record<string, unknown>) => calls.push([`${prefix}error`, msg, data]),
      child: (module: string) => {
        const label = prefix ? `${prefix.slice(0, -1)}.${module}` : module;
        calls.push(['child', label, undefined]);
        return wrap(`${label}:`);
      },
      close: () => Promise.resolve(),
    });
    const inner = { calls, ...wrap('') };
    return inner as unknown as MainLogger & { calls: Array<[string, string, Record<string, unknown> | undefined]> };
  };

  it('delegates to the existing main logger with the correlation context merged', () => {
    const inner = makeInner();
    const logger = new UnifiedLogger(inner);
    logger.info('app ready', { version: '1.0.0' });
    expect(inner.calls).toContainEqual(['info', 'app ready', { proc: 'main', version: '1.0.0' }]);
    logger.error('boom');
    expect(inner.calls).toContainEqual(['error', 'boom', { proc: 'main' }]);
  });

  it('renderer bridge entries land on a renderer-tagged child logger', () => {
    const inner = makeInner();
    const logger = new UnifiedLogger(inner);
    logger.renderer({ level: 'warn', message: 'console.warn from the page', data: { url: 'x' } });
    expect(inner.calls).toContainEqual([
      'renderer:warn',
      'console.warn from the page',
      { proc: 'renderer', url: 'x' },
    ]);
    logger.renderer({ level: 'error', message: 'window error' });
    expect(inner.calls).toContainEqual(['renderer:error', 'window error', { proc: 'renderer' }]);
  });

  it('crash records carry the source and details into the unified log', () => {
    const inner = makeInner();
    const logger = new UnifiedLogger(inner);
    logger.crash('render-process-gone', { reason: 'crashed', exitCode: 11 });
    logger.crash('child-process-gone', { type: 'Utility Process', reason: 'killed' });
    expect(inner.calls).toContainEqual([
      'error',
      'crash: render-process-gone',
      { proc: 'main', source: 'render-process-gone', reason: 'crashed', exitCode: 11 },
    ]);
    expect(inner.calls).toContainEqual([
      'error',
      'crash: child-process-gone',
      { proc: 'main', source: 'child-process-gone', type: 'Utility Process', reason: 'killed' },
    ]);
  });

  it('close() flushes the underlying sink', async () => {
    const inner = makeInner();
    const close = vi.fn(() => Promise.resolve());
    (inner as unknown as { close: () => Promise<void> }).close = close;
    const logger = new UnifiedLogger(inner);
    await logger.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
