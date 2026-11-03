/**
 * Worker permission gate wired to the shared access policy.
 *
 * These tests exercise the REAL tool set handed to a puppet worker (bash +
 * the five file tools) through the engine, so they assert the end-to-end
 * contract rather than the policy in isolation:
 *
 *   allow → executes, NO permission_request
 *   ask   → permission_request, approval runs / rejection does not
 *   deny  → refused immediately, NO permission_request (denylist hit)
 *
 * The home directory is a temp dir injected into the engine, so the denylist
 * (`<home>/.ssh`, …) is exercised without touching the real user's home.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mock the worker implementations (same shape as the workspace tests) ---
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

import { TaskExecuteEngine, type TaskExecuteEngineOptions } from '@/services/task-execute-engine';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx, makeTask } from '@/__tests__/helpers';
import { SkillRegistry } from '@/services/skills/registry';
import type { PermissionConfig } from '@/types/config';
import type { WayangConfig } from '@/types/index';

/** Stand-in user home: `<home>/ws` is the task workspace. */
let home: string;
let taskWs: string;
let shared: string;
let allowedDir: string;
let autoDir: string;

/**
 * The permission section is injected through the engine option (it defaults to
 * `ctx.config.permission`); the home dir is injected too, so both policy inputs
 * are explicit at the assembly point instead of read from the environment.
 */
function makeEngine(opts: { permission?: PermissionConfig } = {}) {
  const ctx = createMockCtx({
    sessionDir: join(home, '.wayang', 'sessions', 's1'),
    workspaceDir: taskWs,
    config: { providers: {}, controller: {}, worker: {} } as unknown as WayangConfig,
  });
  const signalQueue = new SignalQueue(ctx);
  const engineOptions: TaskExecuteEngineOptions = { homeDir: home, permission: opts.permission };
  const engine = new TaskExecuteEngine(ctx, signalQueue, new SkillRegistry([]), engineOptions);
  return { engine, signalQueue };
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

function permissionRequests(signalQueue: SignalQueue): any[] {
  return signalQueue.getUnreadSignals().filter((s) => s.type === 'permission_request').map((s) => s.payload as any);
}

describe('worker permission gate — policy-backed decisions', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wayang-perm-engine-home-'));
    taskWs = join(home, 'ws');
    shared = join(home, 'shared');
    allowedDir = join(home, 'allowed');
    autoDir = join(home, 'auto');
    for (const dir of [taskWs, shared, allowedDir, autoDir, join(home, '.ssh')]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE-KEY');
    writeFileSync(join(home, '.zshrc'), 'export PATH');
    puppetWorkers.length = 0;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Add a task and return the tool set its worker was handed. */
  async function startTask(engine: TaskExecuteEngine, overrides: Record<string, unknown> = {}) {
    await engine.restore();
    engine.add(makeTask('t1', { workspace: { path: taskWs, slug: 'ws' }, ...overrides }));
    return firstRunTools(puppetWorkers[puppetWorkers.length - 1]);
  }

  it('1. reads and writes inside the task workspace run without asking', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const wrote = await tools.write_file.execute({ path: 'a.txt', content: 'hello' });
    expect(wrote).toContain('Written');
    const read = await tools.read_file.execute({ path: 'a.txt' });
    expect(read).toContain('hello');

    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('2. task allowedDirs are allowed without asking', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine, { taskAllowedDirs: [shared] });

    const wrote = await tools.write_file.execute({ path: join(shared, 'x.txt'), content: 'granted' });
    expect(wrote).toContain('Written');
    expect(readFileSync(join(shared, 'x.txt'), 'utf-8')).toBe('granted');

    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('3. config allowedDirs / autoAllowRoots are allowed without asking', async () => {
    const withAllowed = makeEngine({ permission: { allowedDirs: [allowedDir] } });
    const allowedTools = await startTask(withAllowed.engine);
    const wroteAllowed = await allowedTools.write_file.execute({ path: join(allowedDir, 'x.txt'), content: 'ok' });
    expect(wroteAllowed).toContain('Written');
    expect(permissionRequests(withAllowed.signalQueue)).toHaveLength(0);

    // Fresh engine: the previous test's worker/tool set must not leak in.
    puppetWorkers.length = 0;
    const withAuto = makeEngine({ permission: { autoAllowRoots: ['auto'] } });
    const autoTools = await startTask(withAuto.engine);
    const wroteAuto = await autoTools.write_file.execute({ path: join(autoDir, 'y.txt'), content: 'ok' });
    expect(wroteAuto).toContain('Written');
    expect(permissionRequests(withAuto.signalQueue)).toHaveLength(0);
  });

  it('4a. access outside every allowed scope asks, and approval runs the call', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.read_file.execute({ path: '/etc/hosts' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('read_file');

    engine.resolvePermission(requests[0].requestId, true);
    const output = await pending;
    expect(output).toContain('localhost');
  });

  it('4b. access outside every allowed scope asks, and rejection blocks the call', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const target = join(tmpdir(), `wayang-perm-engine-outside-${process.pid}.txt`);
    const pending = tools.write_file.execute({ path: target, content: 'nope' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('write_file');

    engine.resolvePermission(requests[0].requestId, false, 'not allowed');
    const output = await pending;

    expect(output).toContain('Permission denied');
    expect(output).not.toContain('Written');
    expect(existsSync(target)).toBe(false);
  });

  it('4c. a READ elsewhere in home still asks (worker reads are not home-wide)', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    // `<home>/.zshrc` is not denylisted, but it is outside the worker's
    // workspace — a silent read there would expose .env files, keys and other
    // projects' sources, so the worker must ask (unlike the controller).
    const pending = tools.read_file.execute({ path: join(home, '.zshrc') });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('read_file');

    engine.resolvePermission(requests[0].requestId, true);
    expect(await pending).toContain('export PATH');
  });

  it('5. a denylisted path is refused outright — no permission_request is emitted', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const output = await tools.read_file.execute({ path: join(home, '.ssh', 'id_rsa') });
    expect(output).toContain('[ERROR]');
    expect(output).toContain('deny list');
    expect(output).not.toContain('PRIVATE-KEY');

    // Deny must not become "ask": the signal count is the assertion.
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('5b. a denylisted WRITE is refused even with a task allowedDirs grant', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine, { taskAllowedDirs: [join(home, '.ssh')] });

    const output = await tools.write_file.execute({ path: join(home, '.ssh', 'new_key'), content: 'x' });
    expect(output).toContain('[ERROR]');
    expect(existsSync(join(home, '.ssh', 'new_key'))).toBe(false);
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('6. a symlink inside the workspace cannot reach the denylist', async () => {
    symlinkSync(join(home, '.ssh'), join(taskWs, 'ssh-link'));

    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const output = await tools.read_file.execute({ path: 'ssh-link/id_rsa' });
    expect(output).toContain('[ERROR]');
    expect(output).toContain('deny list');
    expect(output).not.toContain('PRIVATE-KEY');
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('7a. bash touching a denylisted path is refused as a whole, without asking', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const output = await tools.bash.execute({ command: 'cat ~/.ssh/id_rsa' });
    expect(output).toContain('[ERROR]');
    expect(output).toContain('deny list');
    // The command never ran, so the secret cannot leak into the transcript.
    expect(output).not.toContain('PRIVATE-KEY');
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('7b. a mixed bash command is refused when ANY candidate is denylisted', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);
    writeFileSync(join(taskWs, 'ok.txt'), 'ok');

    const output = await tools.bash.execute({ command: 'cat ok.txt && cat ~/.ssh/id_rsa' });
    expect(output).toContain('[ERROR]');
    expect(output).not.toContain('PRIVATE-KEY');
    expect(output).not.toContain('ok');
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('7c. bash with an ordinary path outside the workspace still asks (unchanged)', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.bash.execute({ command: 'cat /etc/hosts' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('bash');

    engine.resolvePermission(requests[0].requestId, true);
    const output = await pending;
    expect(output).toContain('localhost');
  });

  it('8. without task allowedDirs the boundary is unchanged (workspace allow / outside ask / denylist deny)', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine); // no taskAllowedDirs

    // inside the workspace → allowed
    writeFileSync(join(taskWs, 'inside.txt'), 'inside');
    expect(await tools.read_file.execute({ path: 'inside.txt' })).toContain('inside');
    expect(permissionRequests(signalQueue)).toHaveLength(0);

    // a sibling dir that is NOT granted → asks
    writeFileSync(join(shared, 'sibling.txt'), 'sibling');
    const pending = tools.write_file.execute({ path: join(shared, 'created.txt'), content: 'x' });
    await flush();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    engine.resolvePermission(requests[0].requestId, false, 'outside the task workspace');
    expect(await pending).toContain('Permission denied');
    expect(existsSync(join(shared, 'created.txt'))).toBe(false);

    // denylist → deny (the ONE deliberate change: it no longer asks)
    expect(await tools.read_file.execute({ path: join(home, '.ssh', 'id_rsa') })).toContain('deny list');
    expect(permissionRequests(signalQueue)).toHaveLength(1); // still just the write request
  });
});
