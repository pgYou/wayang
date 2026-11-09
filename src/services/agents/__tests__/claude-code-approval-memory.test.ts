/**
 * Task-scoped approval memory through the claude-code canUseTool gate
 * (issue #58). Mirrors the puppet middleware's #46 contract on the same shared
 * `ApprovalMemory` store and `reusableGrantKeys` rule:
 *
 *   - a READ approved once in a task is not asked again in that task;
 *   - clearTask (task end) drops the grant, so the same key asks again;
 *   - a refused approval writes no grant (no permanent deny);
 *   - approvalMemory: 'off' keeps one approval per call;
 *   - the key claude-code writes is the SAME key the puppet gate reuses.
 *
 * The SDK is mocked so canUseTool can be captured and driven directly; the
 * real `decideToolAccess` policy and the real permission middleware are used
 * on the puppet side for the parity assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkerConfig, TaskDetail } from '@/types/index';
import type { ApprovalMemoryMode } from '@/types/config';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import { SkillRegistry } from '@/services/skills/registry';
import { SignalQueue } from '@/services/signal/signal-queue';
import { ApprovalMemory } from '@/services/permission/approval-memory';
import { wrapWithPermissionMiddleware } from '@/services/tools/permission-middleware';
import { decideToolAccess, type WorkerAccessScope } from '@/services/tools/permission-rules';
import { createMockCtx, createMockLogger } from '@/__tests__/helpers';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ type: 'instance' })),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

const skills = new SkillRegistry([]);
const config: WorkerConfig = { type: 'claude-code', description: 'Test worker' };
const TASK_ID = 't-acm';

const makeTask = (): TaskDetail & { workerId: string } => ({
  id: `t-acm-run-${Math.random().toString(36).slice(2, 8)}`,
  title: 'Test',
  description: 'Do the thing',
  priority: 'normal',
  status: 'pending',
  createdAt: Date.now(),
  workerId: 'cw-acm',
});

function successResult() {
  return { type: 'result' as const, subtype: 'success' as const, result: 'done', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, num_turns: 1, duration_ms: 1, errors: [] as string[] };
}

/** SDK query mock: yields a result then closes, so run() settles. */
function resultStream() {
  return {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      yield successResult() as never;
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

let userHome: string;
let workspace: string;
let target: string;

describe('ClaudeCodeWorker task approval memory (#58)', () => {
  beforeEach(() => {
    userHome = mkdtempSync(join(tmpdir(), 'wayang-cc-am-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'wayang-cc-am-ws-'));
    mkdirSync(join(userHome, 'shared'), { recursive: true });
    target = join(userHome, 'shared', 'notes.txt');
    writeFileSync(target, 'CONTENT');
    mockQuery.mockReset();
  });
  afterEach(() => {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const scope = (): WorkerAccessScope => ({ userHome, workspace });

  /**
   * Wire the worker the way worker-wiring.ts does, with the engine's
   * per-session grant store and approvalMemory mode injected.
   */
  function makeWiredWorker(opts: { grants: ApprovalMemory; approvalMemory?: ApprovalMemoryMode; taskId?: string }) {
    const ctx = createMockCtx({ sessionDir: userHome, workspaceDir: workspace });
    const worker = new ClaudeCodeWorker(config, userHome, workspace, ctx, skills);
    const signalQueue = new SignalQueue(createMockCtx({ sessionDir: userHome, workspaceDir: workspace }));
    worker.setSignalContext({
      signalQueue,
      workerId: 'cw-acm',
      taskId: opts.taskId ?? TASK_ID,
      taskTitle: 'approval memory',
      accessScope: scope(),
      grants: opts.grants,
      ...(opts.approvalMemory !== undefined && { approvalMemory: opts.approvalMemory }),
    });
    return { worker, signalQueue };
  }

  /** Run a no-op query to capture the wired canUseTool, then drive it directly. */
  async function captureCanUseTool(worker: ClaudeCodeWorker) {
    let options: Record<string, any> | null = null;
    mockQuery.mockImplementationOnce((({ options: o }: any) => { options = o; return resultStream(); }) as never);
    const runP = worker.run(makeTask(), {});
    await settle();
    await runP;
    expect(typeof options!.canUseTool).toBe('function');
    return options!.canUseTool as (t: string, i: Record<string, unknown>) => Promise<any>;
  }

  const permissionRequests = (sq: SignalQueue) => sq.query({ type: 'permission_request' });

  /**
   * Fire one canUseTool call, answer any fresh permission_request, and report
   * whether the controller was asked.
   */
  async function driveAsk(
    worker: ClaudeCodeWorker,
    sq: SignalQueue,
    canUseTool: (t: string, i: Record<string, unknown>) => Promise<any>,
    approved: boolean,
  ) {
    const before = permissionRequests(sq).length;
    const pending = canUseTool('Read', { file_path: target });
    await settle();
    const fresh = permissionRequests(sq).slice(before);
    for (const request of fresh) {
      expect(worker.permissionHandler.resolvePermission((request.payload as any).requestId, approved)).toBe('resolved');
    }
    const verdict = await pending;
    return { asked: fresh.length > 0, behavior: verdict.behavior };
  }

  /**
   * The REAL puppet permission middleware on the same shared policy, with a
   * store we can inspect. Used for the cross-transport parity assertion.
   */
  function makePuppetGate(opts: { grants: ApprovalMemory; taskId?: string }) {
    const enqueue = vi.fn();
    const execute = vi.fn(async () => 'ran');
    const middleware = wrapWithPermissionMiddleware(
      { read_file: { description: 'r', parameters: {}, execute } },
      {
        gatedTools: ['read_file'],
        decide: (n, a) => decideToolAccess(scope(), n, a),
        describeCall: () => 'read_file',
      },
      {
        workerId: 'puppet-acm',
        taskId: opts.taskId ?? TASK_ID,
        taskTitle: 'approval memory',
        signalQueue: { enqueue } as any,
        logger: createMockLogger(),
        grants: opts.grants,
      },
    );
    const askCount = () => enqueue.mock.calls.filter((c: any) => c[0].type === 'permission_request').length;
    async function read(): Promise<{ asked: boolean; output: string }> {
      const before = askCount();
      const pending = middleware.wrappedTools.read_file.execute({ path: target });
      await settle();
      const fresh = enqueue.mock.calls.filter((c: any) => c[0].type === 'permission_request').slice(before);
      for (const c of fresh) middleware.resolvePermission((c as any)[0].payload.requestId, true);
      const output = (await pending) as string;
      return { asked: fresh.length > 0, output };
    }
    return { middleware, read };
  }

  it('A: the second read of the same key emits no permission_request and audits granted-by-memory', async () => {
    const grants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants });
    const canUseTool = await captureCanUseTool(worker);

    const first = await driveAsk(worker, signalQueue, canUseTool, true);
    expect(first.asked).toBe(true);
    expect(first.behavior).toBe('allow');
    expect(grants.size()).toBe(1);

    const second = await driveAsk(worker, signalQueue, canUseTool, true);
    expect(second.asked).toBe(false);
    expect(second.behavior).toBe('allow');
    expect(permissionRequests(signalQueue)).toHaveLength(1);

    const decisions = (worker as any).logger.info.mock.calls
      .map((call: any[]) => call[0])
      .filter((record: any) => record && record.audit === 'permission')
      .map((record: any) => record.decision);
    expect(decisions).toContain('granted-by-memory');
  });

  it('B: clearTask drops the grant so the same key asks again', async () => {
    const grants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants });
    const canUseTool = await captureCanUseTool(worker);

    expect((await driveAsk(worker, signalQueue, canUseTool, true)).asked).toBe(true);
    expect((await driveAsk(worker, signalQueue, canUseTool, true)).asked).toBe(false);
    expect(grants.size()).toBe(1);

    // The engine calls approvalGrants.clearTask(taskId) on terminal transitions.
    grants.clearTask(TASK_ID);
    expect(grants.size()).toBe(0);

    const after = await driveAsk(worker, signalQueue, canUseTool, true);
    expect(after.asked).toBe(true);
    expect(after.behavior).toBe('allow');
    expect(permissionRequests(signalQueue)).toHaveLength(2);
  });

  it('a refused approval writes no grant, so the same key asks again (no permanent deny)', async () => {
    const grants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants });
    const canUseTool = await captureCanUseTool(worker);

    const refused = await driveAsk(worker, signalQueue, canUseTool, false);
    expect(refused.asked).toBe(true);
    expect(refused.behavior).toBe('deny');
    expect(grants.size()).toBe(0);

    const retry = await driveAsk(worker, signalQueue, canUseTool, true);
    expect(retry.asked).toBe(true);
    expect(retry.behavior).toBe('allow');
  });

  it("approvalMemory: 'off' keeps one approval per call", async () => {
    const grants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants, approvalMemory: 'off' });
    const canUseTool = await captureCanUseTool(worker);

    expect((await driveAsk(worker, signalQueue, canUseTool, true)).asked).toBe(true);
    expect((await driveAsk(worker, signalQueue, canUseTool, true)).asked).toBe(true);
    expect(grants.size()).toBe(0);
  });

  it('parity with puppet: first asks, second silent, after clearTask asks again — same key, both gates', async () => {
    const puppetGrants = new ApprovalMemory();
    const puppet = makePuppetGate({ grants: puppetGrants });

    const claudeGrants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants: claudeGrants });
    const canUseTool = await captureCanUseTool(worker);

    const puppetSeq = [await puppet.read(), await puppet.read()];
    puppetGrants.clearTask(TASK_ID);
    puppetSeq.push(await puppet.read());

    const claudeSeq = [
      await driveAsk(worker, signalQueue, canUseTool, true),
      await driveAsk(worker, signalQueue, canUseTool, true),
    ];
    claudeGrants.clearTask(TASK_ID);
    claudeSeq.push(await driveAsk(worker, signalQueue, canUseTool, true));

    const puppetAsked = puppetSeq.map((r) => r.asked);
    const claudeAsked = claudeSeq.map((r) => r.asked);
    expect(claudeAsked).toEqual([true, false, true]);
    expect(claudeAsked).toEqual(puppetAsked);
    expect(claudeSeq.every((r) => r.behavior === 'allow')).toBe(true);
    expect(puppetSeq.every((r) => r.output === 'ran')).toBe(true);
  });

  it('the grant claude-code writes is the same key the puppet gate reuses', async () => {
    const grants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants });
    const canUseTool = await captureCanUseTool(worker);

    expect((await driveAsk(worker, signalQueue, canUseTool, true)).asked).toBe(true);
    expect(grants.size()).toBe(1);

    // Same store + same task + same canonical path: the puppet gate must be
    // silent, proving both key on `direction:path` with the shared rule.
    const puppet = makePuppetGate({ grants });
    const silent = await puppet.read();
    expect(silent.asked).toBe(false);
    expect(silent.output).toBe('ran');
    expect(grants.size()).toBe(1);
  });

  /**
   * Mirror of the CLI's reply union: an `allow` without `updatedInput` fails the
   * SDK's own validation and surfaces to the worker as
   * "Tool permission request failed: ZodError: invalid_union"; a `deny` without
   * a message fails the same way. The SDK's TS types mark `updatedInput`
   * optional, so only this shape check (not the compiler) catches a bare allow.
   */
  function assertCliReplyShape(verdict: any) {
    if (verdict.behavior === 'allow') {
      expect(verdict.updatedInput).toBeTypeOf('object');
      expect(verdict.updatedInput).not.toBeNull();
      return;
    }
    expect(verdict.behavior).toBe('deny');
    expect(typeof verdict.message).toBe('string');
    expect(verdict.message.length).toBeGreaterThan(0);
  }

  it('an ask answered with allow carries the original input as updatedInput and does not raise a schema error', async () => {
    const grants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants });
    const canUseTool = await captureCanUseTool(worker);

    const input = { file_path: target, offset: 3 };
    const before = permissionRequests(signalQueue).length;
    // Rejects (rather than resolving to a reply) when the gate hands the SDK an
    // allow it cannot validate — the ZodError invalid_union regression.
    const pending = canUseTool('Read', input);
    await settle();
    const fresh = permissionRequests(signalQueue).slice(before);
    expect(fresh).toHaveLength(1);
    for (const request of fresh) {
      expect(worker.permissionHandler.resolvePermission((request.payload as any).requestId, true)).toBe('resolved');
    }

    const verdict = await pending;
    expect(verdict.behavior).toBe('allow');
    // The untouched input itself — not `{}`, not a repacked copy.
    expect(verdict.updatedInput).toBe(input);
    assertCliReplyShape(verdict);
  });

  it('every other allow path echoes the untouched input, and a refusal keeps its message', async () => {
    const grants = new ApprovalMemory();
    const { worker, signalQueue } = makeWiredWorker({ grants });
    const canUseTool = await captureCanUseTool(worker);

    // Path inside the allowed scope: decided without asking.
    const inside = join(workspace, 'notes.txt');
    writeFileSync(inside, 'x');
    const readInput = { file_path: inside };
    const allowed = await canUseTool('Read', readInput);
    expect(allowed.behavior).toBe('allow');
    expect(allowed.updatedInput).toBe(readInput);
    assertCliReplyShape(allowed);

    // Non-path tool: allowed for parity with the ungated puppet tools.
    const todoInput = { todos: [] };
    const todo = await canUseTool('TodoWrite', todoInput);
    expect(todo.behavior).toBe('allow');
    expect(todo.updatedInput).toBe(todoInput);
    assertCliReplyShape(todo);

    // A refused ask still reaches the worker as a deny WITH a message.
    const before = permissionRequests(signalQueue).length;
    const refusedInput = { file_path: target };
    const pending = canUseTool('Read', refusedInput);
    await settle();
    const fresh = permissionRequests(signalQueue).slice(before);
    expect(fresh).toHaveLength(1);
    for (const request of fresh) {
      expect(worker.permissionHandler.resolvePermission((request.payload as any).requestId, false, 'nope')).toBe('resolved');
    }
    const denial = await pending;
    expect(denial.behavior).toBe('deny');
    expect(denial.message).toBe('nope');
    assertCliReplyShape(denial);
  });
});
