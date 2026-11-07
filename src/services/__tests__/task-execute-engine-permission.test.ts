/**
 * Worker permission gate wired to the shared access policy.
 *
 * These tests exercise the REAL tool set handed to a puppet worker (bash +
 * the five file tools) through the engine, so they assert the end-to-end
 * contract rather than the policy in isolation:
 *
 *   allow → executes, NO permission_request
 *   ask   → permission_request, approval runs / rejection does not
 *   deny  → refused immediately, NO permission_request (`sensitiveMode: 'deny'`
 *           on a sensitive hit only: under the default mode a sensitive hit —
 *           read OR write — asks like anything else)
 *
 * The home directory is a temp dir injected into the engine, so the sensitive
 * list (`<home>/.ssh`, …) is exercised without touching the real user's home.
 * Every answered request and every hard refusal must leave an audit record on
 * the session logger (`audit: 'permission'`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
import type { SystemContext } from '@/infra/system-context';
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
  const engineOptions: TaskExecuteEngineOptions = { userHome: home, permission: opts.permission };
  const engine = new TaskExecuteEngine(ctx, signalQueue, new SkillRegistry([]), engineOptions);
  return { engine, signalQueue, ctx };
}

/**
 * Canonical spelling of a path, mirroring the policy's `normalizePath`
 * semantics WITHOUT importing it (the tests must not borrow the code under
 * test to compute their own expectations).
 *
 * `mkdtempSync(join(tmpdir(), …))` hands back the platform's spelling of the
 * temp dir, which on macOS is the un-resolved `/var/folders/…` — while the
 * gate `realpath`s what it judges and reports `/private/var/folders/…`. Both
 * name the same file; only the spelling differs. Resolve the deepest EXISTING
 * ancestor with `realpathSync` and glue the missing tail back on:
 *
 *   /tmp/link/new_key   (/tmp/link -> /home/u)  =>  /home/u/new_key
 */
function canonical(p: string): string {
  const lexical = resolve(p);
  const peeled: string[] = [];
  let candidate = lexical;

  for (let depth = 0; depth <= 32; depth += 1) {
    try {
      const resolved = realpathSync(candidate);
      return peeled.length === 0 ? resolved : resolve(join(resolved, ...peeled));
    } catch {
      // Missing or unreadable — peel one segment and retry on the parent.
    }
    const parent = dirname(candidate);
    if (parent === candidate) break; // hit the filesystem root
    peeled.unshift(basename(candidate));
    candidate = parent;
  }

  return lexical;
}

/** Permission audit records written to the session logger, in order. */
function auditRecords(ctx: SystemContext): Record<string, unknown>[] {
  return (ctx.logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((record) => record && record.audit === 'permission');
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

    // `<home>/.zshrc` is not sensitive, but it is outside the worker's
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

  it('5a. a sensitive READ asks once; approval reads the original content and is audited', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.read_file.execute({ path: join(home, '.ssh', 'id_rsa') });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('read_file');
    // The request must explain WHAT matched and WHERE — without the content.
    expect(requests[0].matchedEntry).toBe('.ssh');
    expect(requests[0].matchedRule).toBe('sensitive-list');
    expect(requests[0].sensitive).toBe(true);
    expect(requests[0].resolvedPath).toBe(canonical(join(home, '.ssh', 'id_rsa')));
    expect(requests[0].operation).toBe('read');
    expect(requests[0].description).toContain('hit: .ssh');
    expect(requests[0].description).not.toContain('PRIVATE-KEY');

    engine.resolvePermission(requests[0].requestId, true);
    expect(await pending).toContain('PRIVATE-KEY');

    const audits = auditRecords(ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      audit: 'permission',
      decision: 'approved',
      operation: 'read',
      // #43: a file read is judged as a read, recorded next to the operation.
      access: 'read',
      matchedEntry: '.ssh',
      matchedRule: 'sensitive-list',
      resolvedPath: canonical(join(home, '.ssh', 'id_rsa')),
      taskId: 't1',
    });
    // …and the audit never quotes the file.
    expect(JSON.stringify(audits[0])).not.toContain('PRIVATE-KEY');
  });

  it('5b. a rejected sensitive READ leaks neither content nor the matched entry', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.read_file.execute({ path: join(home, '.ssh', 'id_rsa') });
    await flush();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);

    engine.resolvePermission(requests[0].requestId, false, 'no need for this task');
    const output = await pending;

    expect(output).toContain('Permission denied');
    expect(output).not.toContain('PRIVATE-KEY');
    expect(output).not.toContain('.ssh');

    const audits = auditRecords(ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: 'denied', matchedEntry: '.ssh', source: 'controller' });
  });

  /**
   * 0.8.4: a sensitive WRITE is approvable. Even with the task granted the
   * directory (`taskAllowedDirs: [.ssh]`) the sensitive rule outranks the
   * grant, so the call asks — and, once approved, performs exactly the write
   * the controller saw described.
   */
  it('5c. a sensitive WRITE asks once; approval performs it and is audited', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine, { taskAllowedDirs: [join(home, '.ssh')] });

    const pending = tools.write_file.execute({ path: join(home, '.ssh', 'new_key'), content: 'x' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('write_file');
    expect(requests[0].matchedRule).toBe('sensitive-list');
    expect(requests[0].matchedEntry).toBe('.ssh');
    expect(requests[0].matchedSource).toBe('segment');
    expect(requests[0].resolvedPath).toBe(canonical(join(home, '.ssh', 'new_key')));
    expect(requests[0].access).toBe('write');
    expect(requests[0].operation).toBe('write');
    // The approval DESCRIPTION quotes the path and the hit, never the content
    // (the raw `toolArgs` travel with the signal as before, so the controller
    // can see what would happen).
    expect(requests[0].description).toContain('hit: .ssh (segment)');
    expect(requests[0].description).not.toContain('content');
    // Nothing has been written yet.
    expect(existsSync(join(home, '.ssh', 'new_key'))).toBe(false);

    engine.resolvePermission(requests[0].requestId, true);
    await pending;
    expect(existsSync(join(home, '.ssh', 'new_key'))).toBe(true);

    const audits = auditRecords(ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      decision: 'approved',
      // `operation` is the tool category, `access` the judged direction.
      operation: 'write',
      access: 'write',
      matchedEntry: '.ssh',
      matchedRule: 'sensitive-list',
      resolvedPath: canonical(join(home, '.ssh', 'new_key')),
      taskId: 't1',
    });
  });

  it('5c2. a REJECTED sensitive write performs nothing', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine, { taskAllowedDirs: [join(home, '.ssh')] });

    const pending = tools.write_file.execute({ path: join(home, '.ssh', 'new_key'), content: 'x' });
    await flush();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);

    engine.resolvePermission(requests[0].requestId, false, 'not in this task');
    expect(await pending).toContain('Permission denied');
    expect(existsSync(join(home, '.ssh', 'new_key'))).toBe(false);
    expect(auditRecords(ctx)[0]).toMatchObject({
      decision: 'denied',
      operation: 'write',
      access: 'write',
      matchedEntry: '.ssh',
      source: 'controller',
    });
  });

  it('5d. sensitiveMode: deny refuses BOTH directions without asking', async () => {
    const { engine, signalQueue, ctx } = makeEngine({ permission: { sensitiveMode: 'deny' } });
    const tools = await startTask(engine);

    const read = await tools.read_file.execute({ path: join(home, '.ssh', 'id_rsa') });
    expect(read).toContain('[ERROR]');
    expect(read).not.toContain('PRIVATE-KEY');

    const write = await tools.write_file.execute({ path: join(home, '.ssh', 'id_rsa'), content: 'x' });
    expect(write).toContain('[ERROR]');
    expect(write).toContain('sensitive list');
    expect(write).toContain('refusing to write');
    // Not a single request: the mode refuses instead of prompting.
    expect(permissionRequests(signalQueue)).toHaveLength(0);

    const audits = auditRecords(ctx);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ decision: 'hard-denied', operation: 'read', access: 'read', matchedRule: 'sensitive-list' });
    expect(audits[1]).toMatchObject({
      decision: 'hard-denied',
      operation: 'write',
      access: 'write',
      matchedRule: 'sensitive-list',
      matchedEntry: '.ssh',
    });
    expect(readFileSync(join(home, '.ssh', 'id_rsa'), 'utf-8')).not.toBe('x');
  });

  it('6. a symlink inside the workspace cannot smuggle a sensitive path', async () => {
    symlinkSync(join(home, '.ssh'), join(taskWs, 'ssh-link'));

    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.read_file.execute({ path: 'ssh-link/id_rsa' });
    await flush();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].matchedEntry).toBe('.ssh');
    // The canonical target is what the controller sees.
    expect(requests[0].resolvedPath).toBe(canonical(join(home, '.ssh', 'id_rsa')));

    engine.resolvePermission(requests[0].requestId, false, 'not needed');
    expect(await pending).not.toContain('PRIVATE-KEY');
  });

  it('7a. bash WRITING a sensitive path asks once, and a rejection keeps the key', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.bash.execute({ command: 'rm -rf ~/.ssh/id_rsa' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].matchedEntry).toBe('.ssh');
    expect(requests[0].access).toBe('write');
    // The tool CATEGORY stays exec even though the direction is a write (#43).
    expect(requests[0].operation).toBe('exec');

    engine.resolvePermission(requests[0].requestId, false, 'no');
    expect(await pending).toContain('[ERROR]');
    // The command never ran, so the key file is untouched.
    expect(existsSync(join(home, '.ssh', 'id_rsa'))).toBe(true);
    expect(auditRecords(ctx)[0]).toMatchObject({
      decision: 'denied',
      operation: 'exec',
      access: 'write',
      matchedEntry: '.ssh',
    });
  });

  it('7a2. bash READING a sensitive path asks once (a read is not a refusal)', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    // Absolute path: a real shell's `~` is the process HOME, not this fixture.
    const pending = tools.bash.execute({ command: `cat ${join(home, '.ssh', 'id_rsa')}` });
    await flush();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('bash');
    expect(requests[0].matchedEntry).toBe('.ssh');
    expect(requests[0].operation).toBe('exec');

    engine.resolvePermission(requests[0].requestId, true);
    expect(await pending).toContain('PRIVATE-KEY');
  });

  /**
   * #42: the destructive tier must not swallow the sensitive hit. The approval
   * names the danger AND the entry, and the audit keeps both — plus the judged
   * direction as its own `access` field (#43), separate from `operation: exec`.
   */
  it('7a3. a DANGEROUS command hitting a sensitive path names both in the approval', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.bash.execute({ command: `sudo cat ${join(home, '.ssh', 'id_rsa')}` });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('bash');
    expect(requests[0].matchedRule).toBe('dangerous-bash');
    expect(requests[0].matchedEntry).toBe('.ssh');
    expect(requests[0].sensitive).toBe(true);
    expect(requests[0].description).toContain('dangerous-bash');
    expect(requests[0].description).toContain('hit: .ssh');
    // Still only asks — the dangerous tier never refuses on its own.
    expect(requests[0].description).not.toContain('PRIVATE-KEY');

    engine.resolvePermission(requests[0].requestId, false, 'no');
    await pending;

    expect(auditRecords(ctx)[0]).toMatchObject({
      decision: 'denied',
      operation: 'exec',
      // #47: `sudo` is stripped before the read-only lookup, so the audit names
      // the direction (`cat` reads) while the danger rule still asks.
      access: 'read',
      matchedRule: 'dangerous-bash',
      matchedEntry: '.ssh',
      resolvedPath: canonical(join(home, '.ssh', 'id_rsa')),
      toolName: 'bash',
    });
  });

  it('7a4. a dangerous command with no sensitive hit shows no hit block', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.bash.execute({ command: 'sudo cat /etc/hostname' });
    await flush();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].description).toContain('/etc/hostname');
    expect(requests[0].description).not.toContain('hit:');
    expect(requests[0].description).not.toContain('rule:');

    engine.resolvePermission(requests[0].requestId, false, 'no');
    await pending;
  });

  it('7b. a mixed bash command asks when ANY candidate is a sensitive write', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);
    writeFileSync(join(taskWs, 'ok.txt'), 'ok');

    const pending = tools.bash.execute({ command: 'cat ok.txt && tee ~/.ssh/authorized_keys' });
    await flush();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].matchedEntry).toBe('.ssh');
    expect(requests[0].access).toBe('write');

    engine.resolvePermission(requests[0].requestId, false, 'no');
    const output = await pending;
    expect(output).toContain('[ERROR]');
    expect(output).not.toContain('ok');
    expect(existsSync(join(home, '.ssh', 'authorized_keys'))).toBe(false);
  });

  it('7b2. a mixed bash command of READS asks once instead of refusing', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);
    writeFileSync(join(taskWs, 'ok.txt'), 'ok');

    const pending = tools.bash.execute({ command: 'cat ok.txt && cat ~/.ssh/id_rsa' });
    await flush();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].matchedEntry).toBe('.ssh');

    engine.resolvePermission(requests[0].requestId, false, 'no');
    const output = await pending;
    expect(output).toContain('[ERROR]');
    expect(output).not.toContain('PRIVATE-KEY');
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

  it('8. without task allowedDirs the boundary is unchanged (workspace allow / outside ask / sensitive ask)', async () => {
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

    // a sensitive WRITE → asks, and it is a SECOND request (the grant above is
    // irrelevant: the sensitive rule outranks it)
    const sensitive = tools.write_file.execute({ path: join(home, '.ssh', 'id_rsa'), content: 'x' });
    await flush();
    const sensitiveRequests = permissionRequests(signalQueue);
    expect(sensitiveRequests).toHaveLength(2);
    expect(sensitiveRequests[1].matchedEntry).toBe('.ssh');
    expect(sensitiveRequests[1].access).toBe('write');
    engine.resolvePermission(sensitiveRequests[1].requestId, false, 'no');
    expect(await sensitive).toContain('Permission denied');
    expect(readFileSync(join(home, '.ssh', 'id_rsa'), 'utf-8')).toBe('PRIVATE-KEY');
  });

  it('13. the boundary anchors on the process home, never on the session layout (0.8.4)', async () => {
    // The session dir sits under a CUSTOM root (`<home>` here stands in for
    // what `--wayang-root` produces) while $HOME points elsewhere. The old
    // derivation reverse-engineered "the user's home" from the session dir
    // and got the custom root — so the read boundary followed the flag. The
    // engine must anchor on the PROCESS home instead.
    const procHome = mkdtempSync(join(tmpdir(), 'wayang-perm-engine-proc-'));
    const realHome = process.env.HOME;
    process.env.HOME = procHome;
    try {
      writeFileSync(join(procHome, 'z.cfg'), 'PROC-HOME-CONTENT');
      const ctx = createMockCtx({
        sessionDir: join(home, '.wayang', 'sessions', 's1'),
        workspaceDir: taskWs,
        config: { providers: {}, controller: {}, worker: {} } as unknown as WayangConfig,
      });
      const signalQueue = new SignalQueue(ctx);
      // NO userHome option: the engine default must be os.homedir().
      const engine = new TaskExecuteEngine(ctx, signalQueue, new SkillRegistry([]));
      const tools = await startTask(engine);

      // Reading a PROCESS-home file: the boundary is the process home, so
      // the verdict is the narrowed read-within-home ask (NOT outside-all,
      // which is what the old session-derived boundary produced).
      const pending = tools.read_file.execute({ path: join(procHome, 'z.cfg') });
      await flush();
      const requests = permissionRequests(signalQueue);
      expect(requests).toHaveLength(1);
      expect(requests[0].matchedRule).toBe('read-within-home');

      engine.resolvePermission(requests[0].requestId, true);
      expect(await pending).toContain('PROC-HOME-CONTENT');
    } finally {
      process.env.HOME = realHome;
      rmSync(procHome, { recursive: true, force: true });
    }
  });

  /**
   * 0.8.4: the approval description has to name the path the gate JUDGED. The
   * describe callback used to re-derive it with `resolve(workspace, path)`,
   * which left `~` / `$HOME` unexpanded — so `read_file ~/.wayang.config.json`
   * reached the controller (and the TUI) as
   * `<workspace>/~/.wayang.config.json`, a path that does not exist and that
   * nobody recognizes as their own config.
   */
  it('14. the approval description resolves ~ / $HOME like the gate, and keeps relative paths', async () => {
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { engine, signalQueue } = makeEngine();
      const tools = await startTask(engine);
      // Distinct targets: an approval remembers its path for the rest of the
      // task (issue #46), so reusing one would skip the next request entirely.
      writeFileSync(join(home, 'tilde.txt'), 'TILDE');
      writeFileSync(join(home, 'homevar.txt'), 'HOMEVAR');
      writeFileSync(join(shared, 'r.txt'), 'REL');

      // `~` — expanded to the process home, NOT resolved against the workspace.
      const tilde = tools.read_file.execute({ path: '~/tilde.txt' });
      await flush();
      const tildeRequest = permissionRequests(signalQueue)[0];
      expect(tildeRequest.description).toBe(
        `read_file: ~/tilde.txt (resolved: ${canonical(join(home, 'tilde.txt'))})`,
      );
      expect(tildeRequest.description).not.toContain(`${taskWs}/~`);
      engine.resolvePermission(tildeRequest.requestId, true);
      expect(await tilde).toContain('TILDE');

      // `$HOME` — same anchor, same expansion.
      const homeVar = tools.read_file.execute({ path: '$HOME/homevar.txt' });
      await flush();
      const homeRequest = permissionRequests(signalQueue)[1];
      expect(homeRequest.description).toBe(
        `read_file: $HOME/homevar.txt (resolved: ${canonical(join(home, 'homevar.txt'))})`,
      );
      engine.resolvePermission(homeRequest.requestId, true);
      expect(await homeVar).toContain('HOMEVAR');

      // A relative path keeps its historical wording: resolved against the
      // task workspace (the tool's cwd).
      const relative = tools.read_file.execute({ path: '../shared/r.txt' });
      await flush();
      const relativeRequest = permissionRequests(signalQueue)[2];
      expect(relativeRequest.description).toBe(
        `read_file: ../shared/r.txt (resolved: ${canonical(join(home, 'shared', 'r.txt'))})`,
      );
      engine.resolvePermission(relativeRequest.requestId, true);
      expect(await relative).toContain('REL');
    } finally {
      process.env.HOME = realHome;
    }
  });

  it('15. a ~user target keeps its spelling and says it cannot be expanded', async () => {
    const { engine, signalQueue } = makeEngine();
    const tools = await startTask(engine);

    const pending = tools.read_file.execute({ path: '~root/.ssh/id_rsa' });
    await flush();
    const [request] = permissionRequests(signalQueue);
    expect(request.matchedRule).toBe('home-other-user');
    // The description keeps the spelling the caller used and says why it could
    // not be resolved; the policy's own `reason` is appended after it.
    expect(request.description).toContain(
      "read_file: ~root/.ssh/id_rsa (unresolved: another user's home cannot be expanded)",
    );
    expect(request.description).not.toContain(`/root/.ssh`);
    engine.resolvePermission(request.requestId, false, 'no');
    expect(await pending).toContain('Permission denied');
  });

  /**
   * 0.8.4: an `allow` verdict is a decision too, and it was the only one
   * missing from the trail — the audit could not tell "the gate allowed this"
   * from "the gate never saw this call".
   */
  it('16. an allowed call writes one decision=allowed record and still runs', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine);

    expect(await tools.read_file.execute({ path: (writeFileSync(join(taskWs, 'a.txt'), 'hello'), 'a.txt') })).toContain('hello');
    expect(permissionRequests(signalQueue)).toHaveLength(0);

    const audits = auditRecords(ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      audit: 'permission',
      decision: 'allowed',
      operation: 'read',
      access: 'read',
      taskId: 't1',
      toolName: 'read_file',
    });
    expect(typeof audits[0].ts).toBe('string');
    // Metadata only: the record names the tool and the task, never content.
    expect(JSON.stringify(audits[0])).not.toContain('hello');
  });

  it('17. an allowed bash call is audited with its judged direction, never the command text', async () => {
    const { engine, signalQueue, ctx } = makeEngine();
    const tools = await startTask(engine);

    const output = await tools.bash.execute({ command: 'echo allowed-sentinel' });
    expect(output).toContain('allowed-sentinel');
    expect(permissionRequests(signalQueue)).toHaveLength(0);

    const audits = auditRecords(ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      decision: 'allowed',
      operation: 'exec',
      access: 'read',
      matchedRule: 'no-path',
      taskId: 't1',
      toolName: 'bash',
    });
    // The command line is content: the allow path does not quote it.
    expect(JSON.stringify(audits[0])).not.toContain('allowed-sentinel');
    expect(audits[0]).not.toHaveProperty('requestedPath');
  });
});
