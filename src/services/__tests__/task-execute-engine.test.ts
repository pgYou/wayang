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
    /** Mirror the real ctor: (provider, ctx, skills, toolChoice, workspaceDir). */
    readonly workspaceDir: string;
    conversation: any[] = [];
    private deferred: { resolve: (r: any) => void } | null = null;
    run = vi.fn(() => new Promise<any>((resolve) => { this.deferred = { resolve }; }));
    abort = vi.fn();
    getConversation = () => this.conversation;
    getState = () => null;
    acceptMessage = vi.fn(() => true);
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    /** Resolve the most recently started run() promise. */
    resolveRun = (r: any) => {
      if (!this.deferred) throw new Error('no pending run to resolve');
      this.deferred.resolve(r);
      this.deferred = null;
    };
    constructor(...args: any[]) {
      this.workspaceDir = args[4];
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
import type { ControllerSignal } from '@/types/index';

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

  it('parked idle entry keeps taskId + taskTitle for the TUI label fallback', async () => {
    // The status bar falls back to ActiveWorkerInfo.taskTitle once the task
    // moved to history — the idle entry must carry it (and the task id the
    // row keying depends on) through the moveToIdle transition.
    const { engine } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t9', { multiStage: true, title: 'Research stage' }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 's1' });

    const active = engine.getActiveWorkers();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('idle');
    expect(active[0].taskId).toBe('t9');
    expect(active[0].taskTitle).toBe('Research stage');
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

    // Regression (v0.5): the assigned task must be state-tracked — visible in
    // running, then history with its origin — not just executed invisibly.
    const running = engine.list('running').find((t) => t.id === 't2');
    expect(running).toBeTruthy();
    expect(running?.status).toBe('running');

    await resolveAndSettle(worker, { status: 'completed', summary: 's2' });
    const done = engine.list('completed').find((t) => t.id === 't2');
    expect(done?.status).toBe('completed');
    expect(done?.result).toBe('s2');
    expect(done?.assignedFromWorkerId).toBe(idleId);
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

describe('TaskExecuteEngine — cancel semantics', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-engine-test-'));
    constructedWorkers.length = 0;
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('cancelling a running task emits task_cancelled (not failed) and survives the aborted worker resolution', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1'));
    const worker = lastWorker();
    expect(engine.cancel('t1')).toBe(true);

    // Task terminated as cancelled…
    expect(engine.list('cancelled')).toHaveLength(1);
    // …announced with the dedicated subtype, not a failure.
    const cancelledSignals = signalQueue.getUnreadSignals().filter(s => s.type === 'task_cancelled');
    expect(cancelledSignals).toHaveLength(1);
    expect(cancelledSignals[0].payload).toMatchObject({ taskId: 't1' });
    expect(signalQueue.getUnreadSignals().some(s => s.type === 'failed')).toBe(false);

    // The aborted worker resolves 'failed' afterwards — no failed signal, no
    // state override (task stays cancelled).
    await resolveAndSettle(worker, { status: 'failed', error: 'Aborted' });
    expect(engine.list('cancelled')).toHaveLength(1);
    expect(engine.list('failed')).toHaveLength(0);
    expect(signalQueue.getUnreadSignals().some(s => s.type === 'failed')).toBe(false);
    expect(engine.getActiveWorkers()).toHaveLength(0);
  });

  it('cancelling a running task suppresses even a race-completed worker resolution', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1'));
    const worker = lastWorker();
    engine.cancel('t1');

    await resolveAndSettle(worker, { status: 'completed', summary: 'done too late' });
    expect(engine.list('cancelled')).toHaveLength(1);
    expect(engine.list('completed')).toHaveLength(0);
    expect(signalQueue.getUnreadSignals().some(s => s.type === 'completed')).toBe(false);
  });

  it('cancelling a pending task emits task_cancelled without spawning a worker', async () => {
    const { engine, signalQueue } = makeEngine(0); // maxConcurrency 0 → stays pending
    await engine.restore();

    engine.add(makeTask('t1'));
    expect(constructedWorkers).toHaveLength(0);
    expect(engine.cancel('t1')).toBe(true);

    expect(engine.list('pending')).toHaveLength(0);
    expect(engine.list('cancelled')).toHaveLength(1);
    const cancelledSignals = signalQueue.getUnreadSignals().filter(s => s.type === 'task_cancelled');
    expect(cancelledSignals).toHaveLength(1);
    expect(cancelledSignals[0].payload).toMatchObject({ taskId: 't1' });
  });

  it('a genuinely failed task still emits failed (cancel path does not shadow real failures)', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1'));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'failed', error: 'boom' });

    expect(engine.list('failed')).toHaveLength(1);
    const failedSignals = signalQueue.getUnreadSignals().filter(s => s.type === 'failed');
    expect(failedSignals).toHaveLength(1);
    expect(signalQueue.getUnreadSignals().some(s => s.type === 'task_cancelled')).toBe(false);
  });
});

describe('TaskExecuteEngine — worker transcript id', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-engine-test-'));
    constructedWorkers.length = 0;
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stamps workerTranscriptId on the running task and keeps it in history after completion', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1'));
    const worker = lastWorker();
    const engineId = engine.getActiveWorkers()[0].workerId;
    expect(engineId).toMatch(/^w-/);

    // The engine worker id and the worker instance's own id are different
    // namespaces — the engine exposes the mapping while it tracks the worker.
    expect(worker.id).toMatch(/^fake-/);
    expect(worker.id).not.toBe(engineId);
    expect(engine.getWorkerTranscriptId(engineId)).toBe(worker.id);
    expect(engine.get('t1')?.workerSessionId).toBe(engineId);
    expect(engine.get('t1')?.workerTranscriptId).toBe(worker.id);

    // The in-memory conversation is reachable by worker id too.
    worker.conversation = [{ type: 'user' } as any];
    expect(engine.getWorkerConversationByWorkerId(engineId)).toEqual([{ type: 'user' }]);

    await resolveAndSettle(worker, { status: 'completed', summary: 'done' });

    // After disposal the live lookup is gone, but the persisted task field
    // still locates the on-disk transcript directory.
    expect(engine.getWorkerTranscriptId(engineId)).toBeUndefined();
    const done = engine.list('completed').find(t => t.id === 't1');
    expect(done?.workerSessionId).toBe(engineId);
    expect(done?.workerTranscriptId).toBe(worker.id);
  });

  it('assignToExistingWorker stamps the reused worker\'s transcript id on the new task', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 'stage 1' });

    const engineId = engine.getActiveWorkers()[0].workerId;
    expect(engine.assignToExistingWorker(engineId, makeTask('t2'))).toBe(true);

    const t2 = engine.get('t2');
    expect(t2?.status).toBe('running');
    expect(t2?.workerSessionId).toBe(engineId);
    expect(t2?.workerTranscriptId).toBe(worker.id);
    // Same instance keeps the same transcript directory across stages.
    expect(engine.getWorkerTranscriptId(engineId)).toBe(worker.id);
  });
});

describe('TaskExecuteEngine — dispatch lifecycle signals (issue #30)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wayang-engine-test-'));
    constructedWorkers.length = 0;
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** All enqueued signals so far, oldest first. */
  function allSignals(signalQueue: SignalQueue) {
    return signalQueue.getSnapshot<ControllerSignal[]>('signals');
  }

  it('immediate schedule: worker_started (reused=false) emitted, no task_queued, add() returns the worker id', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    const workerId = engine.add(makeTask('t1', { title: 'Solo task' }));

    // The returned id is the engine worker id now stamped on the task.
    expect(workerId).toMatch(/^w-/);
    expect(engine.get('t1')?.workerSessionId).toBe(workerId);

    const sigs = allSignals(signalQueue);
    const started = sigs.filter(s => s.type === 'worker_started');
    expect(started).toHaveLength(1);
    expect(started[0]!.source).toBe('worker');
    expect(started[0]!.payload).toMatchObject({
      taskId: 't1',
      workerId,
      taskTitle: 'Solo task',
      workerType: 'puppet',
      reused: false,
    });
    // Scheduled right away — no queued signal.
    expect(sigs.filter(s => s.type === 'task_queued')).toHaveLength(0);
  });

  it('concurrency full: task_queued emitted exactly once with task-only payload, add() returns undefined', async () => {
    const { engine, signalQueue } = makeEngine(1);
    await engine.restore();

    engine.add(makeTask('t1'));
    expect(allSignals(signalQueue).filter(s => s.type === 'worker_started')).toHaveLength(1);

    const second = engine.add(makeTask('t2', { title: 'Queued task' }));
    expect(second).toBeUndefined();

    const queued = allSignals(signalQueue).filter(s => s.type === 'task_queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.source).toBe('system');
    expect(queued[0]!.payload).toMatchObject({
      taskId: 't2',
      taskTitle: 'Queued task',
      workerType: 'puppet',
    });
    // No worker exists yet — the payload must not claim one.
    expect(queued[0]!.payload).not.toHaveProperty('workerId');

    // The queued task stays pending and no worker was constructed for it.
    expect(engine.list('pending').map(t => t.id)).toEqual(['t2']);
    expect(constructedWorkers).toHaveLength(1);
  });

  it('queued task emits worker_started (not another task_queued) once a slot frees', async () => {
    const { engine, signalQueue } = makeEngine(1);
    await engine.restore();

    engine.add(makeTask('t1'));
    const firstWorker = lastWorker();
    expect(engine.add(makeTask('t2'))).toBeUndefined();

    // Finish t1 → slot frees → t2 starts automatically.
    await resolveAndSettle(firstWorker, { status: 'completed', summary: 'done' });

    const sigs = allSignals(signalQueue);
    const started = sigs.filter(s => s.type === 'worker_started');
    expect(started).toHaveLength(2);
    expect(started[1]!.payload).toMatchObject({ taskId: 't2', reused: false });
    expect(started[1]!.payload).toHaveProperty('workerId');
    // Still exactly one queued signal — scheduling does not re-announce it.
    expect(sigs.filter(s => s.type === 'task_queued')).toHaveLength(1);
    expect(engine.get('t2')?.status).toBe('running');
  });

  it('idle worker reuse: worker_started carries reused=true and the reused worker id', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1', { multiStage: true }));
    const worker = lastWorker();
    await resolveAndSettle(worker, { status: 'completed', summary: 'stage 1' });

    const engineId = engine.getActiveWorkers()[0]!.workerId;
    expect(engine.assignToExistingWorker(engineId, makeTask('t2'))).toBe(true);

    const started = allSignals(signalQueue).filter(s => s.type === 'worker_started');
    expect(started).toHaveLength(2);
    expect(started[1]!.payload).toMatchObject({
      taskId: 't2',
      workerId: engineId,
      reused: true,
    });
  });

  it('spawn failure: existing failed signal only — no worker_started, no task_queued', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    // Unknown worker type slips past validation → createWorker throws inside
    // spawnWorker, before the started signal would be emitted.
    engine.add(makeTask('t1', { workerType: 'no-such-worker' }));
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    const types = allSignals(signalQueue).map(s => s.type);
    expect(types).toContain('failed');
    expect(types).not.toContain('worker_started');
    expect(types).not.toContain('task_queued');
    expect(engine.list('failed')).toHaveLength(1);
  });
});
