/**
 * Approval memory through the ENGINE — the lifecycle half (issue #46).
 *
 * The grant store is task-scoped by definition, so the interesting assertion is
 * not "the second read is silent" (that is covered by
 * `src/services/tools/__tests__/permission-approval-memory.test.ts`) but WHO
 * drops the grant: the engine, on the three terminal transitions
 * (completed / failed / cancelled), by a direct call — not a lifecycle hook.
 *
 * Every case here drives a real `TaskExecuteEngine` with a fake worker, so the
 * cleanup is exercised on the same code path production uses:
 *
 *   task 1 reads A, approves → task 1 reads A again silently
 *   task 1 ends (completed | failed | cancelled) → the store is empty
 *   task 2 (same process, same engine) reads A → asks again
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Fake puppet workers, newest last. */
const puppetWorkers: any[] = [];

vi.mock('@/services/agents/worker-agent', () => ({
  WorkerAgent: class FakeWorkerAgent {
    readonly id: string;
    readonly workspaceDir: string;
    private deferred: { resolve: (r: any) => void } | null = null;
    run = vi.fn(() => new Promise<any>((resolve) => { this.deferred = { resolve }; }));
    abort = vi.fn();
    getConversation = () => [];
    getState = () => null;
    acceptMessage = vi.fn(() => true);
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    /** Resolve the pending run() promise so the engine's done/fail chain runs. */
    resolveRun = (r: any) => {
      if (!this.deferred) throw new Error('no pending run to resolve');
      this.deferred.resolve(r);
      this.deferred = null;
    };
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

import { TaskExecuteEngine, type TaskExecuteEngineOptions } from '@/services/task-execute-engine';
import { SignalQueue } from '@/services/signal/signal-queue';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import type { SystemContext } from '@/infra/system-context';
import type { PermissionConfig } from '@/types/config';
import type { WayangConfig } from '@/types/index';

/** Stand-in user home; `<home>/ws` is the task workspace. */
let home: string;
let taskWs: string;
/** Ordinary target: inside home, outside the workspace → a READ there asks. */
let target: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-grant-engine-home-'));
  taskWs = join(home, 'ws');
  mkdirSync(taskWs, { recursive: true });
  mkdirSync(join(home, 'shared'), { recursive: true });
  target = join(home, 'shared', 'notes.txt');
  writeFileSync(target, 'SECRET-CONTENT');
  puppetWorkers.length = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function makeEngine(opts: { permission?: PermissionConfig } = {}) {
  const ctx = createMockCtx({
    sessionDir: join(home, '.wayang', 'sessions', 's1'),
    workspaceDir: taskWs,
    config: { providers: {}, controller: {}, worker: {} } as unknown as WayangConfig,
  });
  const signalQueue = new SignalQueue(ctx);
  const engineOptions: TaskExecuteEngineOptions = { userHome: home, permission: opts.permission };
  const engine = new TaskExecuteEngine(ctx, signalQueue, new SkillRegistry([]), engineOptions);
  return { engine, signalQueue, ctx };
}

/** Tools handed to the most recently constructed puppet worker. */
function latestTools(): Record<string, any> {
  const worker = puppetWorkers[puppetWorkers.length - 1];
  const call = worker.run.mock.calls[0];
  if (!call) throw new Error('worker.run was not called');
  return call[1];
}

/** Let the wrapped tool's async gate/execute chain reach its await point. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Resolve a worker's run() and let the engine's done/fail chain settle. */
async function resolveAndSettle(worker: any, result: { status: string; summary?: string; error?: string }): Promise<void> {
  worker.resolveRun(result);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function permissionRequests(signalQueue: SignalQueue): any[] {
  return signalQueue.getUnreadSignals().filter((s) => s.type === 'permission_request').map((s) => s.payload as any);
}

/** Permission audit records written to the session logger, in order. */
function auditRecords(ctx: SystemContext): Record<string, unknown>[] {
  return (ctx.logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((record) => record && record.audit === 'permission');
}

/** Read `path` once through the worker's tool set, answering any request. */
async function readOnce(
  engine: TaskExecuteEngine,
  signalQueue: SignalQueue,
  tools: Record<string, any>,
  path: string,
  approve = true,
): Promise<{ requests: any[]; output: string }> {
  const before = permissionRequests(signalQueue).length;
  const pending = tools.read_file.execute({ path });
  await flush();
  const requests = permissionRequests(signalQueue).slice(before);
  for (const request of requests) engine.resolvePermission(request.requestId, approve);
  const output = (await pending) as string;
  return { requests, output };
}

describe('approval memory — grants die with the task', () => {
  it('1. a COMPLETED task drops its grants; a new task asks again', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1', { workspace: { path: taskWs, slug: 'ws' } }));
    const worker = puppetWorkers[puppetWorkers.length - 1];
    const tools = latestTools();

    const first = await readOnce(engine, signalQueue, tools, target, true);
    expect(first.requests).toHaveLength(1);
    expect(engine.approvalGrants.size()).toBe(1);

    // Silent the second time — and audited as granted-by-memory, not approved.
    const second = await readOnce(engine, signalQueue, tools, target);
    expect(second.requests).toHaveLength(0);
    expect(auditRecords(ctx).at(-1)).toMatchObject({
      decision: 'granted-by-memory',
      access: 'read',
      taskId: 't1',
      resolvedPath: target,
    });

    await resolveAndSettle(worker, { status: 'completed', summary: 'done' });
    expect(engine.list('completed')).toHaveLength(1);
    // The engine cleared the task's slice (direct call, not a hook).
    expect(engine.approvalGrants.size()).toBe(0);

    // New task, same process, same path: the question is asked again.
    engine.add(makeTask('t2', { workspace: { path: taskWs, slug: 'ws' } }));
    const third = await readOnce(engine, signalQueue, latestTools(), target, true);
    expect(third.requests).toHaveLength(1);
    expect(auditRecords(ctx).at(-1)).toMatchObject({ decision: 'approved', taskId: 't2' });
  });

  it('2. a FAILED task drops its grants; a new task asks again', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1', { workspace: { path: taskWs, slug: 'ws' } }));
    const worker = puppetWorkers[puppetWorkers.length - 1];
    const tools = latestTools();

    await readOnce(engine, signalQueue, tools, target, true);
    expect(engine.approvalGrants.size()).toBe(1);

    await resolveAndSettle(worker, { status: 'failed', error: 'boom' });
    expect(engine.list('failed')).toHaveLength(1);
    expect(engine.approvalGrants.size()).toBe(0);

    engine.add(makeTask('t2', { workspace: { path: taskWs, slug: 'ws' } }));
    const again = await readOnce(engine, signalQueue, latestTools(), target, true);
    expect(again.requests).toHaveLength(1);
    expect(auditRecords(ctx).at(-1)).toMatchObject({ decision: 'approved', taskId: 't2' });
  });

  it('3. a CANCELLED task drops its grants; a new task asks again', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1', { workspace: { path: taskWs, slug: 'ws' } }));
    const worker = puppetWorkers[puppetWorkers.length - 1];
    const tools = latestTools();

    await readOnce(engine, signalQueue, tools, target, true);
    expect(engine.approvalGrants.size()).toBe(1);

    expect(engine.cancel('t1')).toBe(true);
    expect(engine.list('cancelled')).toHaveLength(1);
    expect(engine.approvalGrants.size()).toBe(0);
    // The aborted worker still resolves; the engine swallows its failure and
    // schedules the next task (the cancellation must not re-classify it).
    await resolveAndSettle(worker, { status: 'failed', error: 'Aborted' });
    expect(engine.list('failed')).toHaveLength(0);

    engine.add(makeTask('t2', { workspace: { path: taskWs, slug: 'ws' } }));
    const again = await readOnce(engine, signalQueue, latestTools(), target, true);
    expect(again.requests).toHaveLength(1);
    expect(auditRecords(ctx).at(-1)).toMatchObject({ decision: 'approved', taskId: 't2' });
  });

  it('4. cancelling a PENDING task clears its slice too', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    // A grant left behind by a task that never reaches moveToHistory: the
    // pending branch of cancel() must clear it as well.
    engine.approvalGrants.remember('t-pending', `read:${target}`);

    engine.add(makeTask('t1', { workspace: { path: taskWs, slug: 'ws' }, priority: 'high' }));
    // maxConcurrency is 1, so the second task stays pending.
    engine.add(makeTask('t-pending', { workspace: { path: taskWs, slug: 'ws' } }));
    expect(engine.list('pending').map((t) => t.id)).toContain('t-pending');

    expect(engine.cancel('t-pending')).toBe(true);
    expect(engine.list('cancelled').map((t) => t.id)).toContain('t-pending');
    expect(engine.approvalGrants.has('t-pending', `read:${target}`)).toBe(false);
  });

  it("5. permission.approvalMemory: 'off' — approvals are not remembered by the engine path either", async () => {
    const { engine, signalQueue } = makeEngine({ permission: { approvalMemory: 'off' } });
    await engine.restore();

    engine.add(makeTask('t1', { workspace: { path: taskWs, slug: 'ws' } }));
    const tools = latestTools();

    const first = await readOnce(engine, signalQueue, tools, target, true);
    const second = await readOnce(engine, signalQueue, tools, target, true);

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(engine.approvalGrants.size()).toBe(0);
  });
});
