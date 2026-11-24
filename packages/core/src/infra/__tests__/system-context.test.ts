import { describe, it, expect, vi } from 'vitest';
import type { WayangConfig } from '@wayang-ai/protocol';

// Mock logger to avoid real filesystem writes
vi.mock('../logger.js', () => {
  const logger = {
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
  };
  return {
    createLogger: () => logger,
    createFileLogger: () => ({ logger, close: () => Promise.resolve() }),
  };
});

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
  /**
   * Deployment contracts (design 4.2): the 0.9.9-style CLI defaults — the
   * session dir doubles as log/cache dir, the workspace policy carries the
   * controller workspace and the general workspace under the data dir.
   */
  const paths = {
    storage: { dataDir: '/tmp/wayang-data', logDir: '/tmp/wayang-test', cacheDir: '/tmp/wayang-test' },
    workspace: { controllerWorkspace: '/tmp/workspace', defaultWorkerWorkspace: '/tmp/wayang-data/workspace' },
  };

  it('should create context with config values', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, paths);

    expect(ctx.sessionId).toBe('test-session');
    expect(ctx.sessionDir).toBe('/tmp/wayang-test');
    expect(ctx.workspaceDir).toBe('/tmp/workspace');
    expect(ctx.controllerModel.modelName).toBe('claude-sonnet-4-20250514');
    expect(ctx.workerModel.modelName).toBe('claude-sonnet-4-20250514');
    expect(ctx.maxConcurrency).toBe(3);
  });

  it('should have abortController', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, paths);

    expect(ctx.abortController).toBeInstanceOf(AbortController);
    expect(ctx.abortController.signal.aborted).toBe(false);

    ctx.abortController.abort();
    expect(ctx.abortController.signal.aborted).toBe(true);
  });

  it('should create logger', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, paths);

    expect(ctx.logger).toBeDefined();
    expect(typeof ctx.logger.info).toBe('function');
  });

  it('should use default log level when not specified', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, paths);

    expect(ctx.logLevel).toBe('info');
  });

  it('should use custom log level', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', 'debug', paths);

    expect(ctx.logLevel).toBe('debug');
  });

  it('should record startedAt timestamp', () => {
    const before = Date.now();
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, paths);
    const after = Date.now();

    expect(ctx.startedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.startedAt).toBeLessThanOrEqual(after);
  });

  // --- Deployment contracts (monorepo-design 4.2 改造二) ---

  it('exposes the injected StoragePaths and WorkspacePolicy verbatim', () => {
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, paths);

    expect(ctx.storagePaths).toEqual({
      dataDir: '/tmp/wayang-data',
      logDir: '/tmp/wayang-test',
      cacheDir: '/tmp/wayang-test',
    });
    expect(ctx.workspacePolicy).toEqual({
      controllerWorkspace: '/tmp/workspace',
      defaultWorkerWorkspace: '/tmp/wayang-data/workspace',
    });
  });

  it('workspaceDir is the controllerWorkspace alias and logFilePath follows the injected logDir', () => {
    const custom = {
      storage: { dataDir: '/desk/data', logDir: '/desk/logs', cacheDir: '/desk/cache' },
      workspace: { controllerWorkspace: '/desk/controller', defaultWorkerWorkspace: '/desk/tasks' },
    };
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, custom);

    expect(ctx.workspaceDir).toBe('/desk/controller');
    expect(ctx.logFilePath).toBe('/desk/logs/wayang.log');
  });

  it('CLI-default logDir (= the session dir) keeps the 0.9.9 log file path', () => {
    // paths.logDir IS the session dir here — the file the error surface
    // points at must stay <sessionDir>/wayang.log, item by item like 0.9.9.
    const ctx = new SystemContext(testConfig, 'test-session', '/tmp/wayang-test', undefined, paths);
    expect(ctx.logFilePath).toBe('/tmp/wayang-test/wayang.log');
  });
});
