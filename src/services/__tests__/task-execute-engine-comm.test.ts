import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Fake WorkerAgent: records the tools the engine wires in, exposes
// pendingMessages for undelivered reporting, and parks run() like the real one.
const constructedWorkers: any[] = [];

vi.mock('@/services/agents/worker-agent', () => ({
  WorkerAgent: class FakeWorker {
    readonly id = `fake-${constructedWorkers.length}`;
    lastTools: Record<string, any> | null = null;
    pending: string[] = [];
    private deferred: { resolve: (r: any) => void } | null = null;
    run = vi.fn((task: any, tools: Record<string, any>) => {
      this.lastTools = tools;
      return new Promise<any>((resolve) => { this.deferred = { resolve }; });
    });
    abort = vi.fn();
    getConversation = () => [];
    getState = () => null;
    acceptMessage = vi.fn((m: string) => { this.pending.push(m); });
    pendingMessages = () => [...this.pending];
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    resolveRun = (r: any) => {
      if (!this.deferred) throw new Error('no pending run to resolve');
      this.deferred.resolve(r);
      this.deferred = null;
    };
    /** Simulate the worker reading its inbox (prepareStep drain). */
    readInbox = () => { this.pending = []; };
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

let tempDir: string;

function makeEngine(maxConcurrency = 3) {
  const ctx = createMockCtx({
    sessionDir: tempDir,
    workspaceDir: tempDir,
    maxConcurrency,
    config: { providers: {}, controller: {}, worker: {} } as any,
  });
  const signalQueue = new SignalQueue(ctx);
  const engine = new TaskExecuteEngine(ctx, signalQueue, new SkillRegistry([]));
  return { engine, signalQueue };
}

function lastWorker(): any {
  const w = constructedWorkers[constructedWorkers.length - 1];
  if (!w) throw new Error('no worker constructed');
  return w;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TaskExecuteEngine: ask_controller / respond_inquiry spine', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'wayang-comm-')); constructedWorkers.length = 0; });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); vi.useRealTimers(); });

  it('wires an ask_controller tool that blocks until the engine resolves the inquiry', async () => {
    const { engine, signalQueue } = makeEngine();
    engine.add(makeTask('t-comm-a'));

    const tools = lastWorker().lastTools!;
    expect(typeof tools.ask_controller?.execute).toBe('function');

    const ask = tools.ask_controller.execute({ question: 'Which database?' });
    await flushMicrotasks();

    const signals = signalQueue.query({ type: 'worker_inquiry' });
    expect(signals).toHaveLength(1);
    const inquiryId = (signals[0].payload as any).inquiryId;
    expect((signals[0].payload as any).question).toBe('Which database?');

    expect(engine.resolveInquiry(inquiryId, 'use postgres')).toBe('answered');
    await expect(ask).resolves.toBe('[Controller] use postgres');
  });

  it('reports not_found when the inquiry already settled, worker_gone when no registry exists', async () => {
    const { engine, signalQueue } = makeEngine();
    // No worker spawned yet — every registry absent.
    expect(engine.resolveInquiry('inq-x', 'a')).toBe('worker_gone');

    engine.add(makeTask('t-comm-a'));
    const tools = lastWorker().lastTools!;
    const ask = tools.ask_controller.execute({ question: 'q' });
    await flushMicrotasks();
    const inquiryId = (signalQueue.query({ type: 'worker_inquiry' })[0].payload as any).inquiryId;

    // Settle it, then a late answer must be not_found (registry still exists).
    expect(engine.resolveInquiry(inquiryId, 'first')).toBe('answered');
    expect(engine.resolveInquiry(inquiryId, 'late')).toBe('not_found');
    await expect(ask).resolves.toBe('[Controller] first');
  });

  it('times out after 5 minutes: worker continues, inquiry_timeout signal emitted', async () => {
    vi.useFakeTimers();
    const { engine, signalQueue } = makeEngine();
    engine.add(makeTask('t-comm-a'));
    const tools = lastWorker().lastTools!;

    const ask = tools.ask_controller.execute({ question: 'stuck?' });
    const askStarted = Promise.resolve().then(() => ask);
    await flushMicrotasks();

    vi.advanceTimersByTime(300_000 + 10);

    await expect(askStarted).resolves.toContain('[TIMEOUT]');
    const timeouts = signalQueue.query({ type: 'inquiry_timeout' });
    expect(timeouts).toHaveLength(1);
    expect((timeouts[0].payload as any).question).toBe('stuck?');
  });

  it('aborts pending inquiries when the task is cancelled (clean tool return, registry cleaned)', async () => {
    const { engine } = makeEngine();
    const task = makeTask('t-comm-a');
    engine.add(task);
    const worker = lastWorker();
    const ask = worker.lastTools!.ask_controller.execute({ question: 'q' });

    engine.cancel(task.id);
    await expect(ask).resolves.toBe('[ABORTED] Worker is shutting down.');
  });
});

describe('TaskExecuteEngine: chat_worker delivery semantics', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'wayang-comm-')); constructedWorkers.length = 0; });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it('returns not_running before spawn, delivered while the puppet runs, and not_running again right after completion (disposal window)', async () => {
    const { engine } = makeEngine();
    expect(engine.sendMessageToWorker('w-none', 'hi')).toBe('not_running');

    const task = makeTask('t-comm-a');
    engine.add(task);
    const workerId = engine.getActiveWorkers()[0].workerId;
    expect(engine.sendMessageToWorker(workerId, 'mid-task correction')).toBe('delivered');

    // The worker consumes the message (prepareStep drain) before finishing.
    lastWorker().readInbox();
    lastWorker().resolveRun({ status: 'completed', summary: 'done' });
    await flushMicrotasks();

    // handleDone removed the worker from activeWorkers synchronously; the
    // workers Map lingers one setTimeout(0) tick — delivery must still be
    // refused in that window (no false "delivered").
    expect(engine.sendMessageToWorker(workerId, 'too late')).toBe('not_running');
  });

  it('reports queued for an idle multi-stage worker (read at next stage)', async () => {
    const { engine } = makeEngine();
    engine.add(makeTask('t-comm-b', { multiStage: true }));
    const workerId = engine.getActiveWorkers()[0].workerId;
    lastWorker().resolveRun({ status: 'completed', summary: 'stage 1 done' });
    await flushMicrotasks();

    const info = engine.getActiveWorkers().find(w => w.workerId === workerId);
    expect(info?.status).toBe('idle');
    expect(engine.sendMessageToWorker(workerId, 'for next stage')).toBe('queued');
  });
});

describe('TaskExecuteEngine: message_undelivered reporting', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'wayang-comm-')); constructedWorkers.length = 0; });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it('reports unread messages when the task finishes (puppet inbox)', async () => {
    const { engine, signalQueue } = makeEngine();
    engine.add(makeTask('t-comm-a'));
    const workerId = engine.getActiveWorkers()[0].workerId;

    engine.sendMessageToWorker(workerId, 'never read');
    lastWorker().resolveRun({ status: 'completed', summary: 'done' });
    await flushMicrotasks();

    const signals = signalQueue.query({ type: 'message_undelivered' });
    expect(signals).toHaveLength(1);
    const payload = signals[0].payload as any;
    expect(payload.reason).toBe('task_finished');
    expect(payload.messages).toEqual(['never read']);
  });

  it('does not report for a multi-stage worker parking idle (messages persist for the next stage)', async () => {
    const { engine, signalQueue } = makeEngine();
    engine.add(makeTask('t-comm-b', { multiStage: true }));
    const workerId = engine.getActiveWorkers()[0].workerId;

    engine.sendMessageToWorker(workerId, 'kept for stage 2');
    lastWorker().resolveRun({ status: 'completed', summary: 'stage 1' });
    await flushMicrotasks();

    expect(signalQueue.query({ type: 'message_undelivered' })).toHaveLength(0);
  });

  it('reports when an idle worker is disposed with unread messages', async () => {
    const { engine, signalQueue } = makeEngine();
    engine.add(makeTask('t-comm-b', { multiStage: true }));
    const workerId = engine.getActiveWorkers()[0].workerId;
    lastWorker().resolveRun({ status: 'completed', summary: 'stage 1' });
    await flushMicrotasks();

    engine.sendMessageToWorker(workerId, 'dying message');
    expect(engine.abortByWorkerId(workerId)).toBe(true);
    await flushMicrotasks();

    const signals = signalQueue.query({ type: 'message_undelivered' });
    expect(signals).toHaveLength(1);
    expect((signals[0].payload as any).reason).toBe('worker_disposed');
  });
});
