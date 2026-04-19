import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Supervisor } from '@/services/supervisor';
import type { TaskDetail } from '@/types/index';
import type { WayangConfig } from '@/types/index';

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
      expect(sup.engine).toBeDefined();
      expect(sup.signalQueue).toBeDefined();
      expect(sup.controllerAgent).toBeDefined();
      expect(sup.ctx.hooks).toBeDefined();
      expect(sup.sessionManager).toBeDefined();
    });
  });

  describe('start', () => {
    it('should set session info in controller state', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();
      await sup.start();

      const session = sup.controllerAgent.getSnapshot<{ id: string; startedAt: string }>('runtimeState.session');
      expect(session.id).toBe(sup.ctx.sessionId);
      expect(session.startedAt).toBeTruthy();
    });
  });

  describe('restore', () => {
    it('should restore all states', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();
      // No crash = success
    });

    it('should mark running tasks as failed on restore (crash recovery)', async () => {
      const sup = createSupervisor(tempDir);
      await sup.restore();

      // Add a running task, then simulate crash recovery
      sup.engine.add({
        id: 't1', title: 'test', description: 'test', priority: 'normal',
        status: 'pending', createdAt: Date.now(),
      });

      // Manually move to running to simulate a task in progress
      // (scheduleNext would try to spawn a real worker, so we inject via internal state)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineState = (sup.engine as any).taskState;
      const pending: TaskDetail[] = engineState.get('tasks.pending');
      if (pending.length > 0) {
        const [task] = pending.splice(0, 1);
        engineState.set('tasks.pending', pending);
        engineState.append('tasks.running', { ...task, status: 'running', startedAt: Date.now(), workerSessionId: 'w-old' });
      }

      // Re-create supervisor with resume to trigger recovery
      const sessionDir = sup.ctx.sessionDir;
      const sessionId = sup.ctx.sessionId;
      const sup2 = createSupervisor(tempDir, undefined, { sessionId, sessionDir });
      await sup2.restore();

      const history = sup2.engine.list('failed');
      expect(history.some((t: any) => t.id === 't1' && t.status === 'failed')).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should abort system context', async () => {
      const sup = createSupervisor(tempDir);
      await sup.shutdown();
      expect(sup.ctx.abortController.signal.aborted).toBe(true);
    });
  });
});
