import { vi } from 'vitest';
import type { TaskDetail } from '@wayang-ai/protocol';
import type { ResolvedModel } from '@/services/config/model-resolution';
import type { Logger } from '@/infra/logger';
import type { SystemContext } from '@/infra/system-context';
import { LifecycleHooks } from '@/services/lifecycle-hooks';

/** Shared ResolvedModel fixture for tests (issue #88). */
export const mockModel: ResolvedModel = {
  providerKey: 'default',
  modelName: 'test-model',
  baseURL: 'http://localhost:1234',
  apiKey: 'test-key',
  source: 'legacy-provider',
};

/** Create a mock Logger with all methods as vi.fn(). */
export function createMockLogger(): Logger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as any;
}

/** Create a mock SystemContext. */
export function createMockCtx(overrides?: Partial<SystemContext>): SystemContext {
  const logger = createMockLogger();
  return {
    logger,
    sessionId: 'test-session',
    sessionDir: '/tmp/test-session',
    workspaceDir: '/tmp/workspace',
    startedAt: Date.now(),
    logLevel: 'info',
    abortController: new AbortController(),
    hooks: new LifecycleHooks(),
    config: { providers: {}, controller: {}, worker: {} },
    controllerModel: mockModel,
    workerModel: mockModel,
    maxConcurrency: 1,
    ...overrides,
  } as any;
}

/** Create a TaskDetail fixture. */
export function makeTask(id: string, overrides?: Partial<TaskDetail>): TaskDetail {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    priority: 'normal',
    status: 'pending',
    createdAt: Date.now(),
    ...overrides,
  };
}
