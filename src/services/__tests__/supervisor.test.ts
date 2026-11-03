import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
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

// Supervisors created by the current test; afterEach shuts them down so
// their log sinks (pino transport worker threads writing
// <sessionDir>/wayang.log) stop before the temp directory is removed.
const createdSupervisors: Supervisor[] = [];

function createSupervisor(tempDir: string, configOverrides?: Partial<WayangConfig>, resume?: { sessionId: string; sessionDir: string }) {
  const sup = new Supervisor({
    config: makeConfig(configOverrides),
    workspaceDir: tempDir,
    homeDir: tempDir,
    logLevel: 'silent',
    resume,
  });
  createdSupervisors.push(sup);
  return sup;
}

// --- Tests ---

describe('Supervisor', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-supervisor-test-'));
  });

  afterEach(async () => {
    // Defensive teardown, not masking. The real guarantee is product-side:
    // Supervisor.shutdown() awaits SystemContext.closeLogger(), so once a
    // supervisor is shut down its log sink's worker thread has exited and
    // the session directory is quiescent (proved by the regression test
    // "stops creating files in the session dir after shutdown" below).
    // Tests here construct supervisors without always shutting them down
    // themselves, so do it before deleting the directory.
    await Promise.allSettled(createdSupervisors.map((sup) => sup.shutdown()));
    createdSupervisors.length = 0;

    // Defensive cleanup for any other late writer. rmSync's own maxRetries
    // is NOT enough here: Node's internal retry loop re-attempts the bare
    // rmdir without re-enumerating the directory, so a file created after
    // its children pass survives every internal retry. A fresh full rmSync
    // invocation re-walks the tree and removes such a file — this recovers
    // whenever no one keeps writing, which the shutdown above guarantees
    // for the logger. Genuine failures still surface: bounded attempts,
    // rethrown after the last one.
    for (let attempt = 1; ; attempt++) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'ENOTEMPTY' || code === 'EBUSY') && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          continue;
        }
        throw err;
      }
    }
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

    it('stops creating files in the session dir after shutdown', async () => {
      const sup = createSupervisor(tempDir);
      await sup.shutdown();

      const sessionDir = sup.ctx.sessionDir;
      const filesBefore = new Set(readdirSync(sessionDir));

      // Pre-fix, the log sink's transport worker thread opened
      // <sessionDir>/wayang.log ~60ms after construction — well after
      // shutdown() had returned. Poll past that window.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const lateFiles = readdirSync(sessionDir).filter((f) => !filesBefore.has(f));
      expect(lateFiles).toEqual([]);
    });
  });
});
