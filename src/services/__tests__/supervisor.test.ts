import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Supervisor } from '@/services/supervisor';
import type { WayangConfig, WorkerResult, IWorkerInstance } from '@/types/index';

// --- Helpers ---

const providerConfig = {
  endpoint: 'http://localhost:1234/v1',
  apiKey: 'test-key',
  modelName: 'test-model',
};

const defaultConfig: WayangConfig = {
  providers: { default: providerConfig },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 3 },
};

function makeConfig(overrides?: Partial<WayangConfig>): WayangConfig {
  return { ...defaultConfig, ...overrides };
}

function createSupervisor(tempDir: string, configOverrides?: Partial<WayangConfig>, resume?: { sessionId: string; sessionDir: string }) {
  return new Supervisor({
    config: makeConfig(configOverrides),
    workspaceDir: tempDir,
    homeDir: tempDir,
    logLevel: 'silent',
    resume,
  });
}

// --- Tests ---

describe('Supervisor', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-supervisor-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create new session when no resume', () => {
      const sup = createSupervisor(tempDir);
      expect(sup.ctx.sessionId).toBeTruthy();
      expect(sup.ctx.sessionDir).toContain(tempDir);
    });

    it('should throw when homeDir missing for new session', () => {
      expect(() => new Supervisor({
        config: defaultConfig,
        workspaceDir: tempDir,
      })).toThrow('homeDir is required');
    });

    it('should create session from resume options', () => {
      const sessionId = '20260101-000000';
      const sessionDir = join(tempDir, 'sessions', sessionId);
      require('node:fs').mkdirSync(sessionDir, { recursive: true });

      const sup = createSupervisor(tempDir, undefined, { sessionId, sessionDir });
      expect(sup.ctx.sessionId).toBe(sessionId);
    });

    it('should initialize all core components', () => {
      const sup = createSupervisor(tempDir);
      expect(sup.taskPool).toBeDefined();
      expect(sup.signalQueue).toBeDefined();
      expect(sup.scheduler).toBeDefined();
      expect(sup.controllerAgent).toBeDefined();
      expect(sup.controllerState).toBeDefined();
      expect(sup.hooks).toBeDefined();
      expect(sup.workerFactory).toBeDefined();
      expect(sup.sessionManager).toBeDefined();
    });
  });

  describe('start', () => {
    it('should set session info in controller state', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();
      await sup.start();

      const session = sup.controllerState.get<{ id: string; startedAt: string }>('runtimeState.session');
      expect(session.id).toBe(sup.ctx.sessionId);
      expect(session.startedAt).toBeTruthy();
    });
  });

  describe('restore', () => {
    it('should restore all states', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();
      // No crash = success (each sub-restore has its own tests)
    });

    it('should recover crashed workers on restore', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();

      // No stale activeWorkers after restore
      const activeWorkers = sup.controllerState.get<any[]>('runtimeState.activeWorkers');
      expect(activeWorkers).toHaveLength(0);
    });

    it('should mark running tasks as failed on restore (crash recovery)', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();

      // Add a running task, then simulate crash recovery
      sup.taskPool.add({
        id: 't1', title: 'test', description: 'test', priority: 'normal',
        status: 'pending', createdAt: Date.now(),
      });
      sup.taskPool.moveToRunning('t1', 'w-old');

      // Re-create supervisor with resume to trigger recovery
      const sessionDir = sup.ctx.sessionDir;
      const sessionId = sup.ctx.sessionId;
      const sup2 = createSupervisor(tempDir, undefined, { sessionId, sessionDir });
      await sup2.restore();

      const history = sup2.taskPool.list('failed');
      // The crashed running task should be marked failed
      expect(history.some(t => t.id === 't1' && t.status === 'failed')).toBe(true);
    });
  });

  describe('worker management', () => {
    it('should track registered workers', () => {
      const sup = createSupervisor(tempDir);
      const mockWorker: IWorkerInstance = {
        id: 'w-test',
        run: vi.fn(),
        abort: vi.fn(),
        getState: vi.fn(() => null),
      };
      sup.registerWorker(mockWorker);
      expect(sup.getWorker('w-test')).toBe(mockWorker);
    });

    it('should return undefined for unknown worker', () => {
      const sup = createSupervisor(tempDir);
      expect(sup.getWorker('unknown')).toBeUndefined();
    });

    it('should return null state for unknown worker', () => {
      const sup = createSupervisor(tempDir);
      expect(sup.getWorkerState('unknown')).toBeNull();
    });

    it('should abort worker by task id', () => {
      const sup = createSupervisor(tempDir);
      const mockAbort = vi.fn();
      const mockWorker: IWorkerInstance = {
        id: 'w-1',
        run: vi.fn(),
        abort: mockAbort,
        getState: vi.fn(() => null),
      };
      sup.registerWorker(mockWorker);
      // Manually set workerTaskMap (normally set by spawnWorker)
      (sup as any).workerTaskMap.set('w-1', 't-1');

      sup.abortWorkerByTaskId('t-1');
      expect(mockAbort).toHaveBeenCalled();
    });

    it('should not crash when aborting unknown task', () => {
      const sup = createSupervisor(tempDir);
      expect(() => sup.abortWorkerByTaskId('nonexistent')).not.toThrow();
    });
  });

  describe('SchedulerContext implementation', () => {
    it('should add and remove active workers', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();

      sup.addActiveWorker({
        workerId: 'w-1',
        taskId: 't-1',
        startedAt: Date.now(),
        workerType: 'puppet',
        taskTitle: 'Test task',
        emoji: '🧸',
      });

      let active = sup.controllerState.get<any[]>('runtimeState.activeWorkers');
      expect(active).toHaveLength(1);

      sup.removeActiveWorker('w-1');
      active = sup.controllerState.get<any[]>('runtimeState.activeWorkers');
      expect(active).toHaveLength(0);
    });
  });

  describe('shutdown', () => {
    it('should abort all workers and cancel running tasks', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();

      // Register a mock worker
      const mockAbort = vi.fn();
      const mockWorker: IWorkerInstance = {
        id: 'w-1',
        run: vi.fn(),
        abort: mockAbort,
        getState: vi.fn(() => null),
      };
      sup.registerWorker(mockWorker);
      (sup as any).workerTaskMap.set('w-1', 't-1');

      // Add a running task
      sup.taskPool.add({
        id: 't-1', title: 'test', description: 'test', priority: 'normal',
        status: 'pending', createdAt: Date.now(),
      });
      sup.taskPool.moveToRunning('t-1', 'w-1');

      await sup.shutdown();

      expect(mockAbort).toHaveBeenCalled();
      // Running tasks should be cancelled
      const cancelled = sup.taskPool.list('cancelled');
      expect(cancelled.some(t => t.id === 't-1')).toBe(true);
      // Workers should be cleared
      expect(sup.getWorker('w-1')).toBeUndefined();
    });

    it('should abort system context', async () => {
      const sup = createSupervisor(tempDir);
      await sup.shutdown();
      expect(sup.ctx.abortController.signal.aborted).toBe(true);
    });
  });
});
