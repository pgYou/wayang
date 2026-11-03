/**
 * Task-level workspace execution.
 *
 * The engine derives the worker's workspace, the puppet tool cwd and the
 * permission-gate boundary from `task.workspace.path` (canonical). Only tasks
 * without a workspace stamp — legacy tasks, old restored sessions, internally
 * dispatched work — fall back to `ctx.workspaceDir`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mock the worker implementations ---
// createWorker() internally `new`s WorkerAgent / ClaudeCodeWorker; the fakes
// record their constructor arguments and the tools handed to run() so the
// tests can assert what workspace the engine actually wired.

/** Constructed fake puppet workers, newest last. Reset per-test in beforeEach. */
const puppetWorkers: any[] = [];
/** Constructed fake claude-code workers, newest last. */
const claudeWorkers: any[] = [];

vi.mock('@/services/agents/worker-agent', () => ({
  WorkerAgent: class FakeWorkerAgent {
    readonly id: string;
    ctorArgs: any[];
    run = vi.fn(() => new Promise<any>(() => { /* stays pending */ }));
    abort = vi.fn();
    getConversation = () => [];
    getState = () => null;
    acceptMessage = vi.fn(() => true);
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    constructor(...args: any[]) {
      this.id = `agent-fake-${puppetWorkers.length}`;
      this.ctorArgs = args;
      puppetWorkers.push(this);
    }
  },
}));

vi.mock('@/services/agents/claude-code-worker', () => ({
  ClaudeCodeWorker: class FakeClaudeCodeWorker {
    readonly id: string;
    ctorArgs: any[];
    permissionHandler = { resolvePermission: vi.fn(() => true), cleanup: vi.fn() };
    setInquirySupport = vi.fn();
    setSignalContext = vi.fn();
    run = vi.fn(() => new Promise<any>(() => { /* stays pending */ }));
    abort = vi.fn();
    getConversation = () => [];
    getState = () => null;
    acceptMessage = vi.fn(() => true);
    subscribe = () => () => {};
    getSnapshot = () => undefined;
    constructor(...args: any[]) {
      this.id = `cw-fake-${claudeWorkers.length}`;
      this.ctorArgs = args;
      claudeWorkers.push(this);
    }
  },
}));

import { TaskExecuteEngine } from '@/services/task-execute-engine';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import { SkillRegistry } from '@/services/skills/registry';
import type { TaskDetail } from '@/types/index';

let sessionDir: string;
let processWs: string;
let taskWs: string;

function makeEngine() {
  const ctx = createMockCtx({
    sessionDir,
    workspaceDir: processWs,
    maxConcurrency: 3,
    config: {
      providers: {},
      controller: {},
      worker: {},
      workers: {
        'claude-code': { type: 'claude-code', enable: true, emoji: '🦀' },
      },
    } as any,
  });
  const signalQueue = new SignalQueue(ctx);
  const skills = new SkillRegistry([]);
  const engine = new TaskExecuteEngine(ctx, signalQueue, skills);
  return { engine, signalQueue, ctx };
}

/** Task workspace identity as add_task would stamp it (realpath-canonical). */
function workspaceRef(): { path: string; slug: string } {
  return { path: realpathSync(taskWs), slug: 'task-ws' };
}

/** Tools handed to the most recently constructed puppet worker's first run. */
function firstRunTools(worker: any): Record<string, any> {
  const call = worker.run.mock.calls[0];
  if (!call) throw new Error('worker.run was not called');
  return call[1];
}

/** Let the wrapped tool's async gate/execute chain reach its await point. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('TaskExecuteEngine — task-level workspace execution', () => {
  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'wayang-ws-engine-session-'));
    processWs = mkdtempSync(join(tmpdir(), 'wayang-ws-engine-proc-'));
    taskWs = mkdtempSync(join(tmpdir(), 'wayang-ws-engine-task-'));
    puppetWorkers.length = 0;
    claudeWorkers.length = 0;
  });
  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(processWs, { recursive: true, force: true });
    rmSync(taskWs, { recursive: true, force: true });
  });

  it('cross-workspace task: worker and tool cwd come from task.workspace.path', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    const ws = workspaceRef();
    engine.add(makeTask('t1', { workspace: ws }));

    // WorkerAgent's 5th ctor arg is the execution workspace.
    expect(puppetWorkers).toHaveLength(1);
    expect(puppetWorkers[0].ctorArgs[4]).toBe(ws.path);

    const tools = firstRunTools(puppetWorkers[0]);
    const pwd = await tools.bash.execute({ command: 'pwd' });
    expect((pwd as string).trim()).toBe(ws.path);

    writeFileSync(join(taskWs, 'marker.txt'), 'task-workspace-marker');
    const read = await tools.read_file.execute({ path: 'marker.txt' });
    expect(read).toContain('task-workspace-marker');
  });

  it('claude-code worker: constructed with the task workspace', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    const ws = workspaceRef();
    engine.add(makeTask('t1', { workerType: 'claude-code', workspace: ws }));

    expect(claudeWorkers).toHaveLength(1);
    // ClaudeCodeWorker(config, sessionDir, workspaceDir, ctx, skills)
    expect(claudeWorkers[0].ctorArgs[2]).toBe(ws.path);
  });

  it('no workspace given: unchanged — the process workspace is used', async () => {
    const { engine } = makeEngine();
    await engine.restore();

    engine.add(makeTask('t1'));

    expect(puppetWorkers[0].ctorArgs[4]).toBe(processWs);

    const tools = firstRunTools(puppetWorkers[0]);
    writeFileSync(join(processWs, 'proc-marker.txt'), 'process-workspace-marker');
    const read = await tools.read_file.execute({ path: 'proc-marker.txt' });
    expect(read).toContain('process-workspace-marker');

    const pwd = await tools.bash.execute({ command: 'pwd' });
    expect((pwd as string).trim()).toBe(realpathSync(processWs));
  });

  it('legacy task without a workspace stamp: falls back to ctx.workspaceDir, no error', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    // Simulate a task persisted before workspaces existed: no `workspace` field.
    const legacy: TaskDetail = makeTask('legacy-1');
    expect(legacy.workspace).toBeUndefined();
    engine.add(legacy);

    expect(puppetWorkers[0].ctorArgs[4]).toBe(processWs);

    const tools = firstRunTools(puppetWorkers[0]);
    writeFileSync(join(processWs, 'legacy.txt'), 'legacy-marker');
    const read = await tools.read_file.execute({ path: join(realpathSync(processWs), 'legacy.txt') });
    expect(read).toContain('legacy-marker');

    // Nothing was rejected or gated during the fallback run.
    const failures = signalQueue.getUnreadSignals().filter((s) => s.type === 'failed');
    expect(failures).toHaveLength(0);
    expect(signalQueue.getUnreadSignals().filter((s) => s.type === 'permission_request')).toHaveLength(0);
  });

  it('permission gate: task workspace inside → allowed, process workspace inside → gated', async () => {
    const { engine, signalQueue } = makeEngine();
    await engine.restore();

    const ws = workspaceRef();
    engine.add(makeTask('t1', { workspace: ws }));
    const tools = firstRunTools(puppetWorkers[0]);

    // (a) ALLOW: a path inside the task's workspace needs no approval, even
    // though the process workspace is a different directory.
    writeFileSync(join(taskWs, 'inside.txt'), 'inside-marker');
    const allowed = await tools.read_file.execute({ path: join(ws.path, 'inside.txt') });
    expect(allowed).toContain('inside-marker');
    expect(signalQueue.getUnreadSignals().filter((s) => s.type === 'permission_request')).toHaveLength(0);

    // (b) DENY: a path inside the PROCESS workspace is outside the task's
    // workspace, so it must go through the controller.
    writeFileSync(join(processWs, 'outside.txt'), 'outside-marker');
    const pending = tools.read_file.execute({ path: join(realpathSync(processWs), 'outside.txt') });
    await flush();

    const requests = signalQueue.getUnreadSignals().filter((s) => s.type === 'permission_request');
    expect(requests).toHaveLength(1);
    const request = requests[0].payload as any;
    expect(request.description).toContain('outside.txt');

    engine.resolvePermission(request.requestId, false, 'outside the task workspace');
    const denied = await pending;
    expect(denied).toContain('Permission denied');
    expect(denied).not.toContain('outside-marker');

    // (c) The same boundary applies to bash: an absolute path in the process
    // workspace is gated, one in the task workspace is not.
    const bashPending = tools.bash.execute({
      command: `cat ${join(realpathSync(processWs), 'outside.txt')}`,
    });
    await flush();
    const bashRequest = signalQueue.getUnreadSignals()
      .filter((s) => s.type === 'permission_request')
      .map((s) => s.payload as any)
      .find((p) => p.toolName === 'bash');
    expect(bashRequest).toBeTruthy();
    engine.resolvePermission(bashRequest.requestId, true);
    const bashAllowed = await bashPending;
    expect(bashAllowed).toContain('outside-marker');

    const bashInside = await tools.bash.execute({ command: `cat ${join(ws.path, 'inside.txt')}` });
    expect(bashInside).toContain('inside-marker');
  });
});
