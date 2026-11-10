/**
 * Task-scoped approval memory through the REAL permission middleware and the
 * REAL access policy (issue #46).
 *
 * What these cases lock down:
 *
 *   - a READ approved once in a task is not asked again in that task, and the
 *     reuse is audited as `granted-by-memory` carrying the original `grantId`;
 *   - the key is `direction + canonical path`, NOT the tool: `cat A` and
 *     `read_file A` share one grant (see the design note in
 *     `docs/design/permission-policy-0.8.1.md`);
 *   - writes always ask, even for a path whose READ is already granted;
 *   - sensitive hits (`~/.ssh/…`, read OR write) always ask, so a task grant
 *     can never turn into "this task may read the credential directory";
 *   - `permission.approvalMemory: 'off'`, a `deny`, and a rejected approval all
 *     write nothing;
 *   - an approval covers the paths it NAMED: a bash call asking about two
 *     paths needs both, and an escalation that is not about one path
 *     (`dangerous-bash`) is never covered by a grant.
 *
 * The home directory is a temp dir so the sensitive list is exercised without
 * touching the real user's home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '@/infra/logger';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { ApprovalMemoryMode, PermissionConfig } from '@/types/config';
import { createMockLogger } from '@/__tests__/helpers';
import { ApprovalMemory } from '@/services/permission/approval-memory';
import {
  wrapWithPermissionMiddleware,
  type PermissionMiddlewareResult,
} from '@/services/tools/permission-middleware';
import {
  FILE_TOOL_NAMES,
  decideToolAccess,
  type WorkerAccessScope,
} from '@/services/tools/permission-rules';

/** Stand-in home: `shared/` holds the ordinary targets, `.ssh/` the sensitive one. */
let home: string;
/** Task workspace — outside home, so ordinary home paths still ask. */
let ws: string;
/** Ordinary read/write target inside home but outside the workspace. */
let target: string;
/** Second ordinary target, used for the multi-path bash case. */
let otherTarget: string;
/** Sensitive target (`<home>/.ssh/id_rsa`). */
let sensitiveTarget: string;
/** The real $HOME, saved while tests point it at the stand-in home. */
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wayang-grant-home-'));
  ws = mkdtempSync(join(tmpdir(), 'wayang-grant-ws-'));
  // `~` expands against the PROCESS home (os.homedir() reads $HOME on POSIX),
  // so point $HOME at the stand-in home the scope also anchors on.
  realHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, 'shared'), { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  target = join(home, 'shared', 'notes.txt');
  otherTarget = join(home, 'shared', 'other.txt');
  sensitiveTarget = join(home, '.ssh', 'id_rsa');
  writeFileSync(target, 'SECRET-CONTENT');
  writeFileSync(otherTarget, 'OTHER-CONTENT');
  writeFileSync(sensitiveTarget, 'PRIVATE-KEY');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

/** Permission audit records written to the logger, in order. */
function auditRecords(logger: Logger): Record<string, unknown>[] {
  return (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((record) => record && record.audit === 'permission');
}

interface Gate {
  middleware: PermissionMiddlewareResult;
  execute: Record<string, ReturnType<typeof vi.fn>>;
  grants: ApprovalMemory;
  logger: Logger;
  enqueued: any[];
}

/**
 * Wire the middleware the way `TaskExecuteEngine.wireWorker` does: the same
 * `decideToolAccess` policy callback, a mocked signal queue, one shared grant
 * store, a task id.
 */
function makeGate(
  opts: { taskId?: string; memory?: ApprovalMemoryMode; permission?: PermissionConfig; grants?: ApprovalMemory } = {},
): Gate {
  const enqueued: any[] = [];
  const queue = {
    enqueue: vi.fn((sig: any) => {
      enqueued.push(sig);
    }),
  };
  const logger = createMockLogger();
  const grants = opts.grants ?? new ApprovalMemory();
  const scope: WorkerAccessScope = { userHome: home, workspace: ws, permission: opts.permission };
  const execute: Record<string, ReturnType<typeof vi.fn>> = {};
  const tools: Record<string, any> = {};
  for (const name of ['bash', ...FILE_TOOL_NAMES]) {
    const fn = vi.fn(async () => `ran:${name}`);
    execute[name] = fn;
    tools[name] = { description: name, parameters: {}, execute: fn };
  }

  const middleware = wrapWithPermissionMiddleware(tools, {
    gatedTools: ['bash', ...FILE_TOOL_NAMES],
    decide: (toolName, args) => decideToolAccess(scope, toolName, args),
    describeCall: (toolName, args) => `${toolName}: ${JSON.stringify(args)}`,
  }, {
    workerId: 'w1',
    taskId: opts.taskId ?? 't1',
    taskTitle: 'Test task',
    signalQueue: queue as unknown as SignalQueue,
    logger,
    ...(opts.memory !== undefined && { approvalMemory: opts.memory }),
    grants,
  });

  return { middleware, execute, grants, logger, enqueued };
}

interface CallResult {
  output: string;
  requests: any[];
  audits: Record<string, unknown>[];
}

/**
 * Run one gated tool call. `answer` is the controller's reply to every
 * permission_request the call emits (omitted when the call must not ask).
 */
function caller(gate: Gate) {
  return async function call(
    toolName: string,
    args: Record<string, unknown>,
    answer?: boolean,
  ): Promise<CallResult> {
    const before = gate.enqueued.length;
    const auditsBefore = auditRecords(gate.logger).length;
    const pending = gate.middleware.wrappedTools[toolName].execute(args);
    await Promise.resolve();
    const requests = gate.enqueued
      .slice(before)
      .filter((sig) => sig.type === 'permission_request')
      .map((sig) => sig.payload);
    expect(requests.length).toBeLessThanOrEqual(1);
    if (requests.length > 0) {
      if (answer === undefined) throw new Error(`unanswered permission_request from ${toolName}`);
      for (const request of requests) {
        expect(gate.middleware.resolvePermission(request.requestId, answer)).toBe('resolved');
      }
    }
    const output = (await pending) as string;
    return { output, requests, audits: auditRecords(gate.logger).slice(auditsBefore) };
  };
}

/**
 * Canonical spelling of a path, mirroring the policy's `normalizePath`
 * semantics WITHOUT importing it (the tests must not borrow the code under
 * test to compute their own expectations).
 *
 * `mkdtempSync(join(tmpdir(), …))` hands back the platform's spelling of the
 * temp dir, which on macOS is the un-resolved `/var/folders/…` — while the
 * policy `realpath`s what it judges and keys/persists `/private/var/folders/…`.
 * Both name the same file; only the spelling differs. Resolve the deepest
 * EXISTING ancestor with `realpathSync` and glue the missing tail back on:
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

describe('approval memory — a read approved once is reused inside the task', () => {
  it('1. the second read of the same path emits no permission_request and audits granted-by-memory', async () => {
    const gate = makeGate();
    const call = caller(gate);

    const first = await call('read_file', { path: target }, true);
    expect(first.requests).toHaveLength(1);
    expect(first.output).toBe('ran:read_file');
    expect(first.audits).toHaveLength(1);
    expect(first.audits[0]).toMatchObject({
      decision: 'approved',
      access: 'read',
      resolvedPath: canonical(target),
    });

    const grant = gate.grants.get('t1', `read:${canonical(target)}`);
    expect(grant).toBeDefined();

    const second = await call('read_file', { path: target });
    expect(second.requests).toHaveLength(0);
    // The tool still ran — memory only removes the prompt, not the call.
    expect(second.output).toBe('ran:read_file');
    expect(gate.execute.read_file).toHaveBeenCalledTimes(2);

    expect(second.audits).toHaveLength(1);
    expect(second.audits[0]).toMatchObject({
      audit: 'permission',
      decision: 'granted-by-memory',
      access: 'read',
      operation: 'read',
      resolvedPath: canonical(target),
      // The original verdict's rule is carried over, not invented.
      matchedRule: 'read-within-home',
      taskId: 't1',
      workerId: 'w1',
      toolName: 'read_file',
      grantId: grant?.grantId,
    });
    // Metadata only: the audit trail never quotes what was protected.
    expect(JSON.stringify(second.audits[0])).not.toContain('SECRET-CONTENT');
  });

  it('2. a differently spelled path resolving to the same file hits the same grant', async () => {
    const gate = makeGate();
    const call = caller(gate);

    await call('read_file', { path: target }, true);
    // `~/shared/notes.txt` expands to the same canonical path.
    const second = await call('read_file', { path: '~/shared/notes.txt' });
    expect(second.requests).toHaveLength(0);
    expect(second.audits[0]).toMatchObject({
      decision: 'granted-by-memory',
      resolvedPath: canonical(target),
    });
  });
});

describe('approval memory — the key is direction + path, not the tool', () => {
  /**
   * DESIGN DECISION, asserted on purpose: `bash cat A` and `read_file A` share
   * ONE grant.
   *
   * The thing being approved is "this worker may read this file inside this
   * task", not "this worker may use this tool". Keying on the tool would mean
   * the same file is approved twice because the worker switched from
   * `read_file` to `cat` (a worker re-reads through bash constantly), which is
   * exactly the friction #46 exists to remove. The path is canonical, so the
   * two entries cannot disagree about WHAT is read.
   *
   * Risk: the grant covers every tool able to read that path, so a bash
   * command whose READ costs more than a plain read (e.g. piping it onwards)
   * rides on an approval given for a `read_file`. That is accepted for reads
   * (the data was already available to the worker), and deliberately NOT
   * extended to writes or sensitive paths, which never reuse a grant.
   */
  it('3a. approving read_file A makes `bash cat A` silent (shared grant)', async () => {
    const gate = makeGate();
    const call = caller(gate);

    await call('read_file', { path: target }, true);
    const viaBash = await call('bash', { command: `cat ${target}` });

    expect(viaBash.requests).toHaveLength(0);
    expect(viaBash.output).toBe('ran:bash');
    expect(viaBash.audits).toHaveLength(1);
    expect(viaBash.audits[0]).toMatchObject({
      decision: 'granted-by-memory',
      toolName: 'bash',
      operation: 'exec',
      access: 'read',
      resolvedPath: canonical(target),
      grantId: gate.grants.get('t1', `read:${canonical(target)}`)?.grantId,
    });
  });

  it('3b. and the other way round: approving `bash cat A` makes read_file A silent', async () => {
    const gate = makeGate();
    const call = caller(gate);

    const viaBash = await call('bash', { command: `cat ${target}` }, true);
    expect(viaBash.requests).toHaveLength(1);

    const viaTool = await call('read_file', { path: target });
    expect(viaTool.requests).toHaveLength(0);
    expect(viaTool.audits[0]).toMatchObject({ decision: 'granted-by-memory', toolName: 'read_file' });
  });
});

describe('approval memory — writes are never remembered', () => {
  it('4a. writing A asks every single time', async () => {
    const gate = makeGate();
    const call = caller(gate);

    const first = await call('write_file', { path: target, content: 'x' }, true);
    const second = await call('write_file', { path: target, content: 'y' }, true);

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(gate.grants.size()).toBe(0);
    expect(second.audits.map((a) => a.decision)).toEqual(['approved']);
  });

  it('4b. a READ grant never covers a write of the same path', async () => {
    const gate = makeGate();
    const call = caller(gate);

    await call('read_file', { path: target }, true);
    expect(gate.grants.has('t1', `read:${canonical(target)}`)).toBe(true);

    const write = await call('write_file', { path: target, content: 'x' }, true);
    expect(write.requests).toHaveLength(1);
    expect(write.audits[0]).toMatchObject({ decision: 'approved', access: 'write' });
    // Still exactly one grant (the read) — the write approval added nothing.
    expect(gate.grants.size()).toBe(1);
  });
});

describe('approval memory — sensitive paths always ask', () => {
  it('5a. a sensitive READ approved twice is two separate requests', async () => {
    const gate = makeGate();
    const call = caller(gate);

    const first = await call('read_file', { path: sensitiveTarget }, true);
    const second = await call('read_file', { path: sensitiveTarget }, true);

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0].sensitive).toBe(true);
    expect(second.requests[0].matchedEntry).toBe('.ssh');
    expect(gate.grants.size()).toBe(0);
    // Nothing was reused: the second call was a fresh approval.
    expect(second.audits.map((a) => a.decision)).toEqual(['approved']);
  });

  it('5b. a sensitive WRITE approved under sensitiveMode=ask is not remembered either', async () => {
    const gate = makeGate();
    const call = caller(gate);
    const command = `tee ${join(home, '.ssh', 'authorized_keys')}`;

    const first = await call('bash', { command }, true);
    const second = await call('bash', { command }, true);

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]).toMatchObject({ sensitive: true, matchedEntry: '.ssh', access: 'write' });
    expect(gate.grants.size()).toBe(0);
  });
});

describe('approval memory — nothing is remembered without an approval', () => {
  it('6. a deny verdict produces no grant and keeps refusing', async () => {
    const gate = makeGate({ permission: { sensitiveMode: 'deny' } });
    const call = caller(gate);

    const denied = await call('read_file', { path: sensitiveTarget });
    expect(denied.requests).toHaveLength(0);
    expect(denied.output).toContain('[ERROR]');
    expect(denied.audits[0]).toMatchObject({ decision: 'hard-denied', access: 'read' });

    const again = await call('read_file', { path: sensitiveTarget });
    expect(again.requests).toHaveLength(0);
    expect(again.output).toContain('[ERROR]');
    expect(gate.grants.size()).toBe(0);
  });

  it('7. a rejected approval is not remembered — the next read asks again', async () => {
    const gate = makeGate();
    const call = caller(gate);

    const rejected = await call('read_file', { path: target }, false);
    expect(rejected.requests).toHaveLength(1);
    expect(rejected.output).toContain('Permission denied');
    expect(rejected.audits[0]).toMatchObject({ decision: 'denied' });
    expect(gate.grants.size()).toBe(0);

    const retried = await call('read_file', { path: target }, true);
    expect(retried.requests).toHaveLength(1);
    expect(gate.grants.size()).toBe(1);
  });
});

describe('approval memory — scope and reuse boundaries', () => {
  it('8. grants are per task: the same store hands nothing to another task', async () => {
    const grants = new ApprovalMemory();
    const t1 = caller(makeGate({ taskId: 't1', grants }));
    const t2 = caller(makeGate({ taskId: 't2', grants }));

    await t1('read_file', { path: target }, true);
    const otherTask = await t2('read_file', { path: target }, true);

    expect(otherTask.requests).toHaveLength(1);
    expect(otherTask.audits[0]).toMatchObject({ decision: 'approved', taskId: 't2' });
  });

  it('9a. a bash command asking about two paths needs BOTH grants', async () => {
    const gate = makeGate();
    const call = caller(gate);
    const command = `cat ${target} ${otherTarget}`;

    // Only A was ever approved…
    await call('read_file', { path: target }, true);
    // …so the command still asks (B was never reviewed).
    const partial = await call('bash', { command }, true);
    expect(partial.requests).toHaveLength(1);

    // That approval covered both candidates: one grant per asking path.
    expect(gate.grants.size()).toBe(2);
    expect(gate.grants.has('t1', `read:${canonical(target)}`)).toBe(true);
    expect(gate.grants.has('t1', `read:${canonical(otherTarget)}`)).toBe(true);

    const reused = await call('bash', { command });
    expect(reused.requests).toHaveLength(0);
    expect(reused.audits[0]).toMatchObject({ decision: 'granted-by-memory', access: 'read' });
  });

  it('9b. an escalation that is not about one path is never covered by a grant', async () => {
    const gate = makeGate();
    const call = caller(gate);

    await call('read_file', { path: target }, true);
    // `sudo cat A` names A, but the verdict comes from the destructive tier, so
    // it carries no asking paths and cannot ride on the read grant.
    const dangerous = await call('bash', { command: `sudo cat ${target}` }, true);
    expect(dangerous.requests).toHaveLength(1);
    expect(dangerous.audits[0]).toMatchObject({ decision: 'approved', matchedRule: 'dangerous-bash' });
  });

  it('10. approvalMemory: off restores one approval per call', async () => {
    const gate = makeGate({ memory: 'off' });
    const call = caller(gate);

    const first = await call('read_file', { path: target }, true);
    const second = await call('read_file', { path: target }, true);

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(second.audits.map((a) => a.decision)).toEqual(['approved']);
    expect(gate.grants.size()).toBe(0);
  });
});
