/**
 * BaseAcpWorker skeleton tests (02 §3 lifecycle), driven by the in-memory
 * fake agent transport (verbatim copy of the protocol layer's fake).
 *
 * Scenarios:
 * - end-to-end full turn: initialize → session/new → session/prompt with a
 *   text chunk, the measured three-part tool_call stream, a permission
 *   request approved through the REAL signal → permissionHandler chain, a
 *   completed tool result and end_turn → WorkerResult + transcript entries +
 *   runtimeState.acp.pid + audit transport:'acp';
 * - stopReason mapping: end_turn → completed (summary = last agent text),
 *   refusal → failed with the agent-error wording, cancelled → failed
 *   'Aborted' — EXCEPT when a permission was refused during the turn
 *   (measured opencode): the refusal source decides the wording (#56) —
 *   'Permission denied by policy: <tool>', 'Permission request timed out:
 *   <tool>', or 'Permission denied by user: <tool>';
 * - cancel: late updates differ per stopPolicy — trustUpdatesAfterCancel
 *   true keeps them in the transcript, false drops + counts;
 * - readiness attribution: an auth keyword on stderr during session/new
 *   short-circuits to auth-required (measured codebuddy shape, 03 §2.2);
 * - preflight cli-missing fail-fast with the install-hint wording;
 * - messaging: acceptMessage queues for the NEXT turn boundary, and rejects
 *   once the run's input has closed;
 * - getLiveStatus flags across the run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail, WorkerConfig } from '@/types/index';
import type { WorkerAccessScope } from '@/services/tools/permission-rules';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';
import { AcpWorkerRun } from '@/services/agents/acp/acp-worker-run';
import {
  authAttributingReadiness,
  type AcpProtocolOverrides,
  type AcpReadiness,
  type AcpReadyContext,
  type AcpStopPolicy,
  type AcpWorkerEnvView,
} from '@/services/agents/acp/base-acp-worker';
import type { AcpLaunchConfig } from '@/services/acp/config';
import type { AcpTransport } from '@/services/acp/transport';
import type { IWorkerInstance } from '@/types/worker';
import { ApprovalMemory } from '@/services/permission/approval-memory';
import { FakeAgentTransport } from './fake-agent-transport';

const skills = new SkillRegistry([]);

/** Recording stand-in for the engine's SignalQueue. */
class RecordingSignalQueue {
  readonly signals: Array<Record<string, any>> = [];
  enqueue(sig: Record<string, any>): void {
    this.signals.push(sig);
  }
}

/** Test skeleton instance: fake transport injected, stop policy configurable. */
class TestAcpWorker extends AcpWorkerRun implements IWorkerInstance {
  readonly transport = new FakeAgentTransport();
  private readonly policy: AcpStopPolicy;
  private readonly launchCommand: string;

  constructor(
    opts: { trustUpdatesAfterCancel?: boolean; command?: string } = {},
    config?: Partial<WorkerConfig> & { protocol?: AcpProtocolOverrides },
    sessionDir?: string,
    workspaceDir?: string,
  ) {
    super(
      { type: 'codebuddy-acp', description: 'test acp worker', ...config } as WorkerConfig,
      sessionDir ?? '/tmp/acp-test-session',
      workspaceDir ?? '/tmp/acp-test-ws',
      createMockCtx({ sessionDir: sessionDir ?? '/tmp/acp-test-session', workspaceDir: workspaceDir ?? '/tmp/acp-test-ws' } as any),
      skills,
    );
    this.policy = {
      cancelGraceMs: 8_000,
      sigtermWaitMs: 2_000,
      trustUpdatesAfterCancel: opts.trustUpdatesAfterCancel ?? true,
    };
    this.launchCommand = opts.command ?? 'node'; // 'node' always exists → preflight passes
  }

  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    return {
      command: view.command ?? this.launchCommand,
      args: view.args ?? [],
      env: view.env,
      cwd: view.cwd,
      timeouts: view.timeouts,
    };
  }

  protected createTransport(_config: AcpLaunchConfig): AcpTransport {
    return this.transport;
  }

  protected stopPolicy(): AcpStopPolicy {
    return this.policy;
  }

  protected isReady(ctx: AcpReadyContext): AcpReadiness {
    return authAttributingReadiness(ctx, { provider: this.config.type, command: this._launchCommand });
  }

  get discardedAfterCancel(): number {
    return this._discardedAfterCancel;
  }

  /** Permission audit records seen by the (mock) session logger. */
  auditRecords(): any[] {
    const logger = this.ctx.logger as unknown as { info: { mock: { calls: any[] } } };
    return logger.info.mock.calls.filter((call) => call[0]?.audit === 'permission').map((call) => call[0]);
  }

  /** #56: resolve the failure wording for a synthetic, source-tagged ledger. */
  resolveDenial(events: Array<{ source: 'policy' | 'timeout' | 'controller'; toolName: string }>): string | null {
    this._turnDenials = events;
    return this.denialFailureError();
  }
}

// --- JSON-RPC message helpers (the fake agent speaks ndjson) ---

/** Answer the client's Nth outgoing line (clientMessages is already parsed). */
function respondTo(transport: FakeAgentTransport, clientLineIndex: number, result: unknown): void {
  const request = transport.clientMessages[clientLineIndex] as { id: number | string };
  transport.agentMessage({ jsonrpc: '2.0', id: request.id, result });
}

const HANDSHAKE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  authMethods: [] as Array<{ id: string; name: string }>,
};

const TASK: TaskDetail & { workerId: string } = {
  id: 'task-e2e',
  title: 'Probe',
  description: 'Run echo probe-ok',
  priority: 'normal',
  status: 'pending',
  createdAt: Date.now(),
  workerId: 'w-e2e',
  executionTurnId: 'turn-e2e',
};

const SCOPE: WorkerAccessScope = { userHome: '/home/test-user', workspace: '/tmp/acp-test-ws' };

/** Drive the worker through initialize + session/new + session/prompt. */
async function openFakeSession(worker: TestAcpWorker, handshake = HANDSHAKE_RESULT): Promise<void> {
  const transport = worker.transport;
  await transport.waitForClientOutput(1); // initialize
  respondTo(transport, 0, handshake);
  await transport.waitForClientOutput(2); // session/new
  respondTo(transport, 1, { sessionId: 's-1' });
  await transport.waitForClientOutput(3); // session/prompt
}

function sendUpdate(worker: TestAcpWorker, update: Record<string, unknown>): void {
  worker.transport.agentMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update } });
}

function sendPermissionRequest(worker: TestAcpWorker, id: number, toolCall: Record<string, unknown>, options: unknown[]): void {
  worker.transport.agentMessage({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: { sessionId: 's-1', toolCall, options },
  });
}

describe('BaseAcpWorker: end-to-end turn (frozen §8 case 1 shape)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-worker-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs a full turn with a tool call and an approved permission request', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    const grants = new ApprovalMemory();
    worker.setSignalContext({
      signalQueue: queue as any,
      workerId: 'w-e2e',
      taskId: TASK.id,
      taskTitle: TASK.title,
      workerType: 'codebuddy-acp',
      accessScope: SCOPE,
      grants,
      approvalMemory: 'task',
    });

    const progress: string[] = [];
    const runPromise = worker.run(TASK, {}, (msg) => progress.push(msg));
    await openFakeSession(worker);

    // 1) agent text
    sendUpdate(worker, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Working on it' },
      messageId: 'm-1',
    });
    // 2) the measured three-part tool stream (03 §2.1)
    sendUpdate(worker, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Bash', kind: 'other', status: 'in_progress', rawInput: {} });
    sendUpdate(worker, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', rawInput: { command: 'cat /home/test-user/.ssh/id_rsa' } });
    sendUpdate(worker, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'cat sensitive',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'cat /home/test-user/.ssh/id_rsa', description: 'read a key' },
    });
    // 3) the permission request — measured shape: no kind/title, partial
    //    rawInput (the bridge judges the MERGED snapshot).
    sendPermissionRequest(
      worker,
      500,
      { toolCallId: 'tc-1', rawInput: { command: 'cat /home/test-user/.ssh/id_rsa', description: 'read a key' } },
      [
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
    );
    expect(queue.signals).toHaveLength(1);
    const payload = queue.signals[0].payload;
    expect(payload.toolName).toBe('execute');
    expect(payload.sensitive).toBe(true);
    expect(payload.taskId).toBe(TASK.id);

    // The controller approves through the SAME handler the engine wires.
    expect(worker.permissionHandler.resolvePermission(payload.requestId, true)).toBe(true);
    // The client answers the peer request (line 4).
    await worker.transport.waitForClientOutput(4);
    const answer = worker.transport.clientMessages[3];
    expect(answer).toEqual({
      jsonrpc: '2.0',
      id: 500,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });

    // 4) the tool completes, the turn ends.
    sendUpdate(worker, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: { type: 'text', text: 'SECRET' },
    });
    respondTo(worker.transport, 2, { stopReason: 'end_turn' });

    const result = await runPromise;
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Working on it');

    // Transcript isomorphism: user → assistant text → tool step → task_result.
    const conversation = worker.getConversation();
    const types = conversation.map((entry) => entry.type);
    expect(types).toEqual(['user', 'assistant', 'assistant', 'system']);
    const textEntry = conversation[1];
    const toolEntry = conversation[2];
    if (toolEntry.type !== 'assistant') throw new Error('unreachable');
    expect(textEntry.type === 'assistant' && textEntry.message.content).toBe('Working on it');
    expect(toolEntry.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'tc-1',
        toolName: 'execute',
        arguments: JSON.stringify({ command: 'cat /home/test-user/.ssh/id_rsa', description: 'read a key' }),
        status: 'succeeded',
      }),
    ]);
    expect(toolEntry.toolResults?.[0]?.output.value).toBe('SECRET');
    const resultEntry = conversation[3];
    expect(resultEntry.type === 'system' && resultEntry.subtype).toBe('task_result');

    // runtimeState.acp carries the pid evidence (02 §3).
    const runtime = worker.getState().get<Record<string, any>>('runtimeState');
    expect(runtime.acp).toMatchObject({ pid: 424242, command: 'node', provider: 'codebuddy-acp' });

    // Live status: run over.
    expect(worker.getLiveStatus()).toEqual({ resultReceived: true, streamEnded: true });
    // Progress was debounced but the run finished before the timer — no signals lost.
    expect(progress).toEqual([]);
  });

  it('maps stopReason refusal → failed with the agent-error wording', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext({
      signalQueue: new RecordingSignalQueue() as any,
      workerId: 'w-2',
      taskId: TASK.id,
      taskTitle: TASK.title,
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    await worker.transport.waitForClientOutput(3);
    respondTo(worker.transport, 2, { stopReason: 'refusal' });
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('codebuddy-acp');
    expect(result.error).toContain('refusal');
  });

  it('auth keyword on stderr during session/new short-circuits to auth-required', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext({
      signalQueue: new RecordingSignalQueue() as any,
      workerId: 'w-3',
      taskId: TASK.id,
      taskTitle: TASK.title,
    });
    const runPromise = worker.run(TASK, {});
    const transport = worker.transport;
    await transport.waitForClientOutput(1);
    respondTo(transport, 0, { ...HANDSHAKE_RESULT, authMethods: [{ id: 'iOA', name: 'Login with iOA' }] });
    await transport.waitForClientOutput(2); // session/new out
    // stderr hits the auth pattern → immediate attribution, no timeout wait.
    transport.emitStderrLine('Error: please login first (401 unauthorized)');
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('未登录');
    expect(result.error).toContain('Login with iOA');
  });

  it('missing CLI fails fast with the install-hint wording (cli-missing)', async () => {
    const worker = new TestAcpWorker({ command: 'definitely-not-a-real-cli-xyz' }, {}, tempDir, tempDir);
    worker.setSignalContext({
      signalQueue: new RecordingSignalQueue() as any,
      workerId: 'w-4',
      taskId: TASK.id,
      taskTitle: TASK.title,
    });
    const result = await worker.run(TASK, {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain('definitely-not-a-real-cli-xyz');
    expect(result.error).toContain('npm i -g @tencent-ai/codebuddy-code');
    expect(worker.transport.clientOutput).toHaveLength(0); // never spawned a request
  });
});

describe('BaseAcpWorker: cancel and late updates (frozen §6)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-worker-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('trustUpdatesAfterCancel=true keeps late updates in the transcript', async () => {
    const worker = new TestAcpWorker({ trustUpdatesAfterCancel: true }, {}, tempDir, tempDir);
    worker.setSignalContext({
      signalQueue: new RecordingSignalQueue() as any,
      workerId: 'w-c1',
      taskId: TASK.id,
      taskTitle: TASK.title,
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    worker.abort();
    // cancel notification went out (line 4).
    await worker.transport.waitForClientOutput(4);
    expect(worker.transport.clientMessages[3]).toMatchObject({ method: 'session/cancel' });
    // A late text update AFTER the cancel.
    sendUpdate(worker, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'late wrap-up' },
      messageId: 'm-2',
    });
    respondTo(worker.transport, 2, { stopReason: 'cancelled' });

    const result = await runPromise;
    expect(result).toEqual({ status: 'failed', error: 'Aborted' });
    expect(worker.discardedAfterCancel).toBe(0);
    const texts = worker
      .getConversation()
      .filter((entry) => entry.type === 'assistant')
      .map((entry) => (entry as any).message.content);
    expect(texts).toContain('late wrap-up');
  });

  it('trustUpdatesAfterCancel=false drops late updates and counts them', async () => {
    const worker = new TestAcpWorker({ trustUpdatesAfterCancel: false }, {}, tempDir, tempDir);
    worker.setSignalContext({
      signalQueue: new RecordingSignalQueue() as any,
      workerId: 'w-c2',
      taskId: TASK.id,
      taskTitle: TASK.title,
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    worker.abort();
    await worker.transport.waitForClientOutput(4);
    sendUpdate(worker, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'late wrap-up' },
      messageId: 'm-2',
    });
    respondTo(worker.transport, 2, { stopReason: 'cancelled' });

    const result = await runPromise;
    expect(result).toEqual({ status: 'failed', error: 'Aborted' });
    expect(worker.discardedAfterCancel).toBe(1);
    const texts = worker
      .getConversation()
      .filter((entry) => entry.type === 'assistant')
      .map((entry) => (entry as any).message.content);
    expect(texts).not.toContain('late wrap-up');
  });

  it('pending permissions are settled as refusals when the run aborts', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext({
      signalQueue: new RecordingSignalQueue() as any,
      workerId: 'w-c3',
      taskId: TASK.id,
      taskTitle: TASK.title,
      accessScope: SCOPE,
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    sendUpdate(worker, { sessionUpdate: 'tool_call', toolCallId: 'tc-9', title: 'Read', kind: 'read', status: 'in_progress', rawInput: {} });
    sendPermissionRequest(worker, 501, { toolCallId: 'tc-9', rawInput: { file_path: '/etc/passwd' } }, [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ]);
    // Abort while the permission waits. The client's sessionCancel answers
    // the peer request 'cancelled' FIRST (protocol MUST, frozen §6.1); the
    // bridge's wait then settles via cleanup and audits a refusal — never an
    // allow ("no answer yet" is not consent).
    worker.abort();
    await worker.transport.waitForClientOutput(5);
    const answer = worker.transport.clientMessages[4] as { id: number; result: unknown };
    expect(answer).toMatchObject({ id: 501, result: { outcome: { outcome: 'cancelled' } } });
    respondTo(worker.transport, 2, { stopReason: 'cancelled' });
    const result = await runPromise;
    expect(result).toEqual({ status: 'failed', error: 'Aborted' });
    // The cleanup settlement left an audit trail: denied, source 'aborted'.
    const audits = worker.auditRecords();
    expect(audits.some((record) => record.decision === 'denied' && record.source === 'aborted')).toBe(true);
  });
});

describe('BaseAcpWorker: permission denial semantics (#25)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-worker-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Sensitive execute + permission request, same measured shape as the e2e case. */
  function sendSensitivePermissionRequest(worker: TestAcpWorker, requestId: number): void {
    sendUpdate(worker, { sessionUpdate: 'tool_call', toolCallId: 'tc-d1', title: 'Bash', kind: 'other', status: 'in_progress', rawInput: {} });
    sendUpdate(worker, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-d1', rawInput: { command: 'cat /home/test-user/.ssh/id_rsa' } });
    sendUpdate(worker, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-d1',
      title: 'cat sensitive',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'cat /home/test-user/.ssh/id_rsa' },
    });
    sendPermissionRequest(worker, requestId, { toolCallId: 'tc-d1', rawInput: { command: 'cat /home/test-user/.ssh/id_rsa' } }, [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
    ]);
  }

  it('a controller denial maps a cancelled turn to failed "Permission denied by user: <tool>"', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext({
      signalQueue: queue as any,
      workerId: 'w-deny1',
      taskId: TASK.id,
      taskTitle: TASK.title,
      workerType: 'codebuddy-acp',
      accessScope: SCOPE,
      grants: new ApprovalMemory(),
      approvalMemory: 'task',
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    sendSensitivePermissionRequest(worker, 502);
    expect(queue.signals).toHaveLength(1);
    const payload = queue.signals[0].payload;

    // The controller DENIES (respond_permission approved=false).
    expect(worker.permissionHandler.resolvePermission(payload.requestId, false, 'too dangerous')).toBe(true);
    await worker.transport.waitForClientOutput(4);
    expect(worker.transport.clientMessages[3]).toMatchObject({
      id: 502,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });

    // opencode ends the turn as 'cancelled' on a rejected permission
    // (measured #25) — the denial, not a user abort, is the cause.
    respondTo(worker.transport, 2, { stopReason: 'cancelled' });
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Permission denied by user: execute');
  });

  it('a denial from an EARLIER turn does not relabel a later real cancel (per-turn ledger)', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext({
      signalQueue: queue as any,
      workerId: 'w-deny2',
      taskId: TASK.id,
      taskTitle: TASK.title,
      workerType: 'codebuddy-acp',
      accessScope: SCOPE,
      grants: new ApprovalMemory(),
      approvalMemory: 'task',
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    // Queue a controller message so turn 1's end_turn opens turn 2.
    worker.acceptMessage('status?');

    // Turn 1: the controller denies, but the agent ends the turn gracefully.
    sendSensitivePermissionRequest(worker, 503);
    const payload = queue.signals[0].payload;
    expect(worker.permissionHandler.resolvePermission(payload.requestId, false)).toBe(true);
    await worker.transport.waitForClientOutput(4);
    respondTo(worker.transport, 2, { stopReason: 'end_turn' });

    // Turn 2 opens (line 5: the second session/prompt), then a REAL cancel
    // arrives mid-turn — the turn-1 denial must not relabel it.
    await worker.transport.waitForClientOutput(5);
    worker.abort();
    respondTo(worker.transport, 4, { stopReason: 'cancelled' });
    const result = await runPromise;
    expect(result).toEqual({ status: 'failed', error: 'Aborted' });
  });

  it('a policy hard-deny maps a cancelled turn to "Permission denied by policy: <tool>" (#56)', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext({
      signalQueue: queue as any,
      workerId: 'w-policy',
      taskId: TASK.id,
      taskTitle: TASK.title,
      workerType: 'codebuddy-acp',
      accessScope: { ...SCOPE, permission: { sensitiveMode: 'deny' } },
      grants: new ApprovalMemory(),
      approvalMemory: 'task',
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    // The sensitive path is refused by the policy itself — no controller prompt.
    sendSensitivePermissionRequest(worker, 504);
    expect(queue.signals).toHaveLength(0);
    await worker.transport.waitForClientOutput(4);
    expect(worker.transport.clientMessages[3]).toMatchObject({ id: 504 });

    respondTo(worker.transport, 2, { stopReason: 'cancelled' });
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Permission denied by policy: execute');
    expect(result.error).not.toBe('Aborted');
  });

  it('an approval timeout maps a cancelled turn to "Permission request timed out: <tool>" (#56)', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext({
      signalQueue: queue as any,
      workerId: 'w-timeout',
      taskId: TASK.id,
      taskTitle: TASK.title,
      workerType: 'codebuddy-acp',
      accessScope: SCOPE,
      grants: new ApprovalMemory(),
      approvalMemory: 'task',
    });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    sendSensitivePermissionRequest(worker, 505);
    expect(queue.signals).toHaveLength(1);
    // Simulate the approval wait expiring: the bridge settles with reason
    // 'timeout' — the exact value its wait timer's makeTimeoutValue() returns
    // (see the real-timer case in permission-bridge.test.ts). Driving it through
    // the same permissionHandler channel keeps the test deterministic: the
    // protocol responder owns a SECOND permissionMs timer that, under the fake
    // transport's synchronous injection, would race the bridge's timeout event.
    const payload = queue.signals[0].payload;
    expect(worker.permissionHandler.resolvePermission(payload.requestId, false, 'timeout')).toBe(true);
    await worker.transport.waitForClientOutput(4);
    expect(worker.transport.clientMessages[3]).toMatchObject({ id: 505 });

    respondTo(worker.transport, 2, { stopReason: 'cancelled' });
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Permission request timed out: execute');
    expect(result.error).not.toBe('Aborted');
  });

  it('denial wording picks the first source by priority policy > timeout > controller (#56)', () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    expect(worker.resolveDenial([])).toBeNull(); // no refusal → real cancel → 'Aborted'
    expect(worker.resolveDenial([{ source: 'controller', toolName: 'read' }])).toBe('Permission denied by user: read');
    expect(worker.resolveDenial([{ source: 'timeout', toolName: 'bash' }])).toBe('Permission request timed out: bash');
    expect(worker.resolveDenial([{ source: 'policy', toolName: 'edit_file' }])).toBe('Permission denied by policy: edit_file');
    expect(
      worker.resolveDenial([
        { source: 'controller', toolName: 'read' },
        { source: 'timeout', toolName: 'bash' },
      ]),
    ).toBe('Permission request timed out: bash');
    expect(
      worker.resolveDenial([
        { source: 'controller', toolName: 'read' },
        { source: 'timeout', toolName: 'bash' },
        { source: 'policy', toolName: 'edit_file' },
      ]),
    ).toBe('Permission denied by policy: edit_file');
  });
});

describe('BaseAcpWorker: messaging and live status', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-worker-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('acceptMessage queues for the next turn boundary; idle accepts again after the run', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext({ signalQueue: queue as any, workerId: 'w-m1', taskId: TASK.id, taskTitle: TASK.title });

    expect(worker.getLiveStatus()).toEqual({ resultReceived: false, streamEnded: false });

    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    // Mid-turn: queued (ACP has no mid-turn injection — next boundary).
    expect(worker.acceptMessage('status?')).toBe(true);
    expect(worker.pendingMessages()).toEqual(['status?']);

    // Turn 1 ends with a queued message → a second turn starts for it.
    respondTo(worker.transport, 2, { stopReason: 'end_turn' });
    await worker.transport.waitForClientOutput(4); // turn-2 prompt
    const secondPrompt = worker.transport.clientMessages[3] as { params: { prompt: unknown[] } };
    expect(secondPrompt.params.prompt).toEqual([{ type: 'text', text: '[Controller message] status?' }]);

    // Turn 2 ends with nothing queued → the run completes and closes input.
    respondTo(worker.transport, 3, { stopReason: 'end_turn' });
    const result = await runPromise;
    expect(result.status).toBe('completed');
    expect(worker.getLiveStatus()).toEqual({ resultReceived: true, streamEnded: true });
    // After abort-style closure messages are refused; an IDLE multi-stage
    // worker (run finished normally) keeps accepting — the next stage folds
    // them into its opening prompt (same semantics as the claude-code worker).
    expect(worker.acceptMessage('next stage')).toBe(true);
    expect(worker.pendingMessages()).toEqual(['next stage']);
  });

  it('acceptMessage returns false once the worker was aborted', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext({ signalQueue: new RecordingSignalQueue() as any, workerId: 'w-m2', taskId: TASK.id, taskTitle: TASK.title });
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    worker.abort();
    respondTo(worker.transport, 2, { stopReason: 'cancelled' });
    const result = await runPromise;
    expect(result).toEqual({ status: 'failed', error: 'Aborted' });
    expect(worker.acceptMessage('nope')).toBe(false);
  });
});
