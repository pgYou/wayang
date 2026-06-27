import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// --- Mock the worker implementations ---
// createWorker() internally `new`s WorkerAgent / ClaudeCodeWorker. A vi.fn with
// a plain function impl is NOT a constructor, so we install a real class that
// records every constructed instance in `constructedWorkers` for test access.

/** Constructed fake worker instances, newest last. Reset per-test in beforeEach. */
const constructedWorkers: any[] = [];

vi.mock('@/services/agents/worker-agent', () => ({
  WorkerAgent: class FakeWorker {
    readonly id = `fake-${constructedWorkers.length}`;
    conversation: any[] = [];
    private deferred: { resolve: (r: any) => void } | null = null;
    run = vi.fn(() => new Promise<any>((resolve) => { this.deferred = { resolve }; }));
    abort = vi.fn();
    getConversation = () => this.conversation;
    getState = () => null;
    acceptMessage = vi.fn();
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    /** Resolve the most recently started run() promise. */
    resolveRun = (r: any) => {
      if (!this.deferred) throw new Error('no pending run to resolve');
      this.deferred.resolve(r);
      this.deferred = null;
    };
    constructor(..._args: any[]) {
      constructedWorkers.push(this);
    }
  },
}));
vi.mock('@/services/agents/claude-code-worker', () => ({
  ClaudeCodeWorker: class {},
}));

import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import { SkillRegistry } from '@/services/skills/registry';

// --- Setup ---

let tempDir: string;

function makeEngine(maxConcurrency = 3, idleTimeoutMs?: number) {
  const ctx = createMockCtx({
    sessionDir: tempDir,
    workspaceDir: tempDir,
    maxConcurrency,
    config: {
      providers: {},
      controller: {},
      worker: {},
      idleTimeoutMs,
    } as any,
  });
  const signalQueue = new SignalQueue(ctx);
  const skills = new SkillRegistry([]);
  const engine = new TaskExecuteEngine(ctx, signalQueue, skills);
  return { engine, signalQueue, ctx };
}

/** The most recently constructed fake worker. */
function lastWorker(): any {
  const w = constructedWorkers[constructedWorkers.length - 1];
  if (!w) throw new Error('no worker constructed yet');
  return w;
}

/**
 * Resolve a worker's run() promise and flush the engine's async done/fail
 * handler chain to completion.
 *
 * handleDone() is reached via the `.then()` on the spawn promise, which is a
 * microtask continuation. We run this under REAL timers (the default) because
 * fake timers interfere with microtask flushing. The TTL/reaper scenarios
 * switch to fake timers only after the worker has settled into idle.
 */
async function resolveAndSettle(worker: any, result: { status: string; summary?: string; error?: string }): Promise<void> {
  worker.resolveRun(result);
  // Yield a few macrotask ticks so the full async chain (.then(handleDone) →
  // scheduleNext → any deferred setTimeout(0) cleanup) runs to completion.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('TaskExecuteEngine — multi-stage worker lifecycle', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-engine-test-'));
    constructedWorkers.length = 0;
    // Real timers by default — needed to flush the async done/fail chain.
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('default (non-multiStage) task: completes and disposes worker', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1'));
    const worker = lastWorker();
    expect(worker.run).toHaveBeenCalledTimes(1);

    await resolveAndSettle(worker, { status: 'completed', summary: 'done' });

    expect(engine.getActiveWorkers()).toHaveLength(0);
    expect(engine.list('completed')).toHaveLength(1);
  });

  it('multiStage task: completes and parks worker in idle (not disposed)', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 'stage 1 done' });

    const active = engine.getActiveWorkers();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('idle');
    expect(active[0].lastStageSummary).toBe('stage 1 done');
    expect(active[0].idleSinceMs).toBeTruthy();
    // Stage task is recorded as completed in history
    expect(engine.list('completed')).toHaveLength(1);
  });

  it('failed multiStage task: does NOT park in idle (failure always disposes)', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'failed', error: 'boom' });

    expect(engine.getActiveWorkers()).toHaveLength(0);
    expect(engine.list('failed')).toHaveLength(1);
  });

  it('assignToExistingWorker reuses an idle worker and resumes running', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    // Stage 1: complete into idle
    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 's1' });
    const idleId = engine.getActiveWorkers()[0].workerId;
    expect(engine.getActiveWorkers()[0].status).toBe('idle');

    // Stage 2: assign a follow-up task to the idle worker (same instance)
    const ok = engine.assignToExistingWorker(idleId, makeTask('t2'));
    expect(ok).toBe(true);
    expect(worker.run).toHaveBeenCalledTimes(2); // reused, not reconstructed

    const active = engine.getActiveWorkers();
    expect(active[0].status).toBe('running');
    expect(active[0].taskId).toBe('t2');
  });

  it('assignToExistingWorker rejects a non-existent or running worker', () => {
    const { engine } = makeEngine();
    engine.restore();

    expect(engine.assignToExistingWorker('nope', makeTask('tx'))).toBe(false);

    // A running worker is not assignable
    engine.add(makeTask('t1', { multiStage: true }));
    const workerId = engine.getActiveWorkers()[0].workerId;
    expect(engine.validateIdleWorker(workerId)).not.toBeNull();
    expect(engine.assignToExistingWorker(workerId, makeTask('ty'))).toBe(false);
  });

  it('idle worker occupies a maxConcurrency slot', async () => {
    const { engine } = makeEngine(1); // concurrency = 1

    await engine.restore();
    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 's1' });

    // Worker is idle → occupies the only slot. A new pending task must NOT spawn.
    expect(engine.getOccupiedSlots()).toBe(1);
    const before = constructedWorkers.length;
    engine.add(makeTask('t2'));
    expect(constructedWorkers.length).toBe(before); // no new worker constructed
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it('idle worker is reaped after idleTimeoutMs and frees its slot', async () => {
    const { engine, signalQueue } = makeEngine(3, 5_000); // 5s idle TTL

    // Use fake timers for the whole test so the reaper timer is fake too.
    vi.useFakeTimers();
    await engine.restore();
    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();

    // Resolve the worker run; advanceTimersByTimeAsync flushes the microtask
    // continuation (handleDone → moveToIdle) plus any resulting timers.
    worker.resolveRun({ status: 'completed', summary: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getActiveWorkers()).toHaveLength(1);
    expect(engine.getActiveWorkers()[0].status).toBe('idle');

    // Advance past the idle TTL → reaper disposes the worker.
    const before = signalQueue.getUnreadSignals().length;
    await vi.advanceTimersByTimeAsync(6_000);

    expect(engine.getActiveWorkers()).toHaveLength(0);
    expect(engine.getOccupiedSlots()).toBe(0);
    // A 'cancelled' signal should have been emitted on dispose
    expect(signalQueue.getUnreadSignals().length).toBeGreaterThan(before);
  });

  it('reuse cancels the idle reaper timer', async () => {
    const { engine } = makeEngine(3, 5_000);

    vi.useFakeTimers();
    await engine.restore();
    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    worker.resolveRun({ status: 'completed', summary: 's1' });
    await vi.advanceTimersByTimeAsync(0);

    // Assign a follow-up before TTL expires
    const idleId = engine.getActiveWorkers()[0].workerId;
    expect(engine.assignToExistingWorker(idleId, makeTask('t2'))).toBe(true);

    // Advance well past the original TTL — worker should still be running, not disposed
    await vi.advanceTimersByTimeAsync(10_000);

    const active = engine.getActiveWorkers();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('running');
  });

  it('abortByWorkerId disposes an idle worker manually', async () => {
    const { engine } = makeEngine();

    await engine.restore();
    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 's1' });

    const idleId = engine.getActiveWorkers()[0].workerId;
    expect(engine.abortByWorkerId(idleId)).toBe(true);
    // Allow the deferred tracking cleanup (setTimeout 0) to run
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.getActiveWorkers()).toHaveLength(0);
  });

  it('abortAll disposes idle workers and clears the active list', async () => {
    const { engine } = makeEngine();

    await engine.restore();
    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 's1' });
    expect(engine.getActiveWorkers()).toHaveLength(1);

    engine.abortAll();
    expect(engine.getActiveWorkers()).toHaveLength(0);
  });
});
