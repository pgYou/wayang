import { describe, it, expect, vi } from 'vitest';
import type { WayangConfig } from '@/types/index';

// Mock logger to avoid real filesystem writes
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  }),
}));

import { SystemContext } from '@/infra/system-context';

const testConfig: WayangConfig = {
  providers: {
    default: {
      endpoint: 'https://api.anthropic.com',
      apiKey: 'test-key',
      modelName: 'claude-sonnet-4-20250514',
    },
  },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 3 },
};

describe('SystemContext', () => {
  it('should create context with config values', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', '/tmp/workspace');

    expect(ctx.sessionId).toBe('test-session');
    expect(ctx.sessionDir).toBe('/tmp/wayang-test');
    expect(ctx.workspaceDir).toBe('/tmp/workspace');
    expect(ctx.controllerProvider.modelName).toBe('claude-sonnet-4-20250514');
    expect(ctx.workerProvider.modelName).toBe('claude-sonnet-4-20250514');
    expect(ctx.maxConcurrency).toBe(3);
  });

  it('should have abortController', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', '/tmp/workspace');

    expect(ctx.abortController).toBeInstanceOf(AbortController);
    expect(ctx.abortController.signal.aborted).toBe(false);

    ctx.abortController.abort();
    expect(ctx.abortController.signal.aborted).toBe(true);
  });

  it('should create logger', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', '/tmp/workspace');

    expect(ctx.logger).toBeDefined();
    expect(typeof ctx.logger.info).toBe('function');
  });

  it('should use default log level when not specified', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', '/tmp/workspace');

    expect(ctx.logLevel).toBe('info');
  });

  it('should use custom log level', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', '/tmp/workspace', 'debug');

    expect(ctx.logLevel).toBe('debug');
  });

  it('should record startedAt timestamp', () => {
    const before = Date.now();
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', '/tmp/workspace');
    const after = Date.now();

    expect(ctx.startedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.startedAt).toBeLessThanOrEqual(after);
  });
});
