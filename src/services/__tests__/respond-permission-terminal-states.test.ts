/**
 * respond_permission terminal states (issue #69).
 *
 * A respond_permission that cannot settle a pending request must still return
 * a DEFINITE terminal answer, and the worker-side wait must already have been
 * released in every path — no orphaned hang, no ambiguous "not found" that
 * leaves the controller guessing while the worker is stuck at the gate.
 *
 * Coverage (issue #69 acceptance):
 *   (a) normal response          → 'resolved', the gated call runs
 *   (b) response after timeout   → 'expired', the call already ended with a
 *                                   timeout error, the tool never ran
 *   (c) response after the worker was closed (resolver cleanup, exactly what
 *       abort/cancel/shutdown do) → 'worker-closed', the call already ended
 *                                   with a cancellation error
 *   (d) duplicate response       → second returns 'already-resolved', the
 *                                   tool ran exactly once
 * plus engine-level routing: abort while a request is pending, duplicate
 * response through the engine, and an id no live worker knows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mock the worker implementations (same shape as the permission engine tests) ---
const puppetWorkers: any[] = [];

vi.mock('@/services/agents/worker-agent', () => ({
  WorkerAgent: class FakeWorkerAgent {
    readonly id: string;
    readonly workspaceDir: string;
    run = vi.fn(() => new Promise<any>(() => { /* stays pending */ }));
    abort = vi.fn();
    getConversation = () => [];
    getState = () => null;
    acceptMessage = vi.fn(() => true);
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    constructor(...args: any[]) {
      this.id = `agent-fake-${puppetWorkers.length}`;
      this.workspaceDir = args[4];
      puppetWorkers.push(this);
    }
  },
}));

vi.mock('@/services/agents/claude-code-worker', () => ({
  ClaudeCodeWorker: class FakeClaudeCodeWorker {},
}));

import { wrapWithPermissionMiddleware } from '@/services/tools/permission-middleware';
import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import type { SignalQueue as SignalQueueType } from '@/services/signal/signal-queue';
import type { WayangConfig } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';

// --- Middleware-level harness ---

function mockSignalQueue() {
  const enqueued: any[] = [];
  return {
    enqueue: vi.fn((sig: any) => enqueued.push(sig)),
    enqueued,
  };
}

/** Gate that always asks, over one mock bash tool. */
function askGate(queue: ReturnType<typeof mockSignalQueue>, timeoutMs?: number) {
  const tool = { description: 'bash', parameters: {}, execute: vi.fn(async () => 'ran') };
  const result = wrapWithPermissionMiddleware(
    { bash: tool },
    {
      gatedTools: ['bash'],
      decide: () => ({ decision: 'ask' as const }),
      describeCall: (_name: string, args: any) => `bash: ${args.command}`,
    },
    {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'T',
      signalQueue: queue as unknown as SignalQueueType,
      ...(timeoutMs !== undefined && { timeoutMs }),
    },
  );
  return { result, tool };
}

function lastRequestId(queue: ReturnType<typeof mockSignalQueue>): string {
  const sig = queue.enqueued[queue.enqueued.length - 1];
  return sig.payload.requestId as string;
}

describe('wrapWithPermissionMiddleware — respond_permission terminal states (#69)', () => {
  it('(a) resolves a pending request and releases the wait', async () => {
    const queue = mockSignalQueue();
    const { result, tool } = askGate(queue);
    const pending = result.wrappedTools.bash.execute({ command: 'ls' });
    const requestId = lastRequestId(queue);

    expect(result.resolvePermission(requestId, true)).toBe('resolved');
    expect(await pending).toBe('ran');
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('(b) reports expired after the request timed out — the wait was already released', async () => {
    vi.useFakeTimers();
    try {
      const queue = mockSignalQueue();
      const { result, tool } = askGate(queue, 1_000);
      const pending = result.wrappedTools.bash.execute({ command: 'ls' });
      const requestId = lastRequestId(queue);

      await vi.advanceTimersByTimeAsync(1_000);

      // The worker-side wait is released by the timeout itself, with a
      // definite error — the call does not hang waiting for anyone.
      expect(await pending).toContain('Permission request timed out');
      expect(tool.execute).not.toHaveBeenCalled();

      // A late response gets a distinguishable terminal answer, not "not found".
      expect(result.resolvePermission(requestId, true)).toBe('expired');
      expect(tool.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) reports worker-closed after cleanup — the wait was already released', async () => {
    const queue = mockSignalQueue();
    const { result, tool } = askGate(queue);
    const pending = result.wrappedTools.bash.execute({ command: 'ls' });
    const requestId = lastRequestId(queue);

    result.cleanup(); // what worker abort / cancel / shutdown do to the resolver

    // The wait is released with a definite cancellation, not left hanging.
    expect(await pending).toContain('Permission request cancelled');
    expect(tool.execute).not.toHaveBeenCalled();

    // A late response gets a definite terminal answer.
    expect(result.resolvePermission(requestId, true)).toBe('worker-closed');
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('(d) reports already-resolved for a duplicate response; the tool runs once', async () => {
    const queue = mockSignalQueue();
    const { result, tool } = askGate(queue);
    const pending = result.wrappedTools.bash.execute({ command: 'ls' });
    const requestId = lastRequestId(queue);

    expect(result.resolvePermission(requestId, true)).toBe('resolved');
    expect(result.resolvePermission(requestId, true)).toBe('already-resolved');

    expect(await pending).toBe('ran');
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('reports not-found for an id no gate ever issued', () => {
    const queue = mockSignalQueue();
    const { result } = askGate(queue);
    expect(result.resolvePermission('perm-never-issued', true)).toBe('not-found');
  });
});

// --- Engine-level harness ---

let home: string;
let taskWs: string;
/** Writable dir outside every allowed scope — gated calls targeting it must ask. */
let outsideDir: string;

function makeEngine() {
  const ctx = createMockCtx({
    sessionDir: join(home, '.wayang', 'sessions', 's1'),
    workspaceDir: taskWs,
    config: { providers: {}, controller: {}, worker: {} } as unknown as WayangConfig,
  });
  const signalQueue = new SignalQueue(ctx);
  const engine = new TaskExecuteEngine(ctx, signalQueue, new SkillRegistry([]), { userHome: home });
  return { engine, signalQueue };
}

/** Add a task and return the tool set its worker was handed. */
async function startTask(engine: TaskExecuteEngine): Promise<Record<string, any>> {
  await engine.restore();
  engine.add(makeTask('t1', { workspace: { path: taskWs, slug: 'ws' } }));
  const worker = puppetWorkers[puppetWorkers.length - 1];
  const call = worker.run.mock.calls[0];
  if (!call) throw new Error('worker.run was not called');
  return call[1];
}

/** Let the wrapped tool's async gate/execute chain reach its await point. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

function permissionRequests(signalQueue: SignalQueueType): any[] {
  return signalQueue
    .getUnreadSignals()
    .filter((s) => s.type === 'permission_request')
    .map((s) => s.payload as any);
}

describe('TaskExecuteEngine — respond_permission terminal states (#69)', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wayang-perm-terminal-home-'));
    taskWs = join(home, 'ws');
    mkdirSync(taskWs, { recursive: true });
    outsideDir = mkdtempSync(join(tmpdir(), 'wayang-perm-terminal-out-'));
    puppetWorkers.length = 0;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('(c) aborting the worker releases the pending wait and later responses report worker-closed', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const target = join(outsideDir, 'aborted.txt');
    const pending = tools.write_file.execute({ path: target, content: 'nope' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);

    engine.abortByTaskId('t1'); // worker closed while the request is pending

    // The worker-side wait is released with a definite cancellation —
    // the call does not hang at the permission gate.
    expect(await pending).toContain('Permission request cancelled');
    expect(existsSync(target)).toBe(false);

    // A late respond_permission gets a definite terminal answer.
    expect(engine.resolvePermission(requests[0].requestId, true)).toBe('worker-closed');
  });

  it('(d) a duplicate response through the engine reports already-resolved and runs the tool once', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const target = join(outsideDir, 'duplicate.txt');
    const pending = tools.write_file.execute({ path: target, content: 'ok' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    const requestId = requests[0].requestId;

    expect(engine.resolvePermission(requestId, true)).toBe('resolved');
    expect(engine.resolvePermission(requestId, true)).toBe('already-resolved');

    expect(await pending).toContain('Written');
    expect(readFileSync(target, 'utf-8')).toBe('ok');
  });

  it('reports not-found for an id no live worker knows', async () => {
    const { engine } = makeEngine();
    await startTask(engine);
    expect(engine.resolvePermission('perm-never-issued', true)).toBe('not-found');
  });
});
