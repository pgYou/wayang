/**
 * Turn attribution + loop guard integration tests (#56).
 *
 * Self-contained copies of the worker-layer fake helpers (the protocol-layer
 * fake transport is imported verbatim) keep this file and acp-worker.test.ts
 * each below the 800-line test-file guideline.
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

class RecordingSignalQueue {
  readonly signals: Array<Record<string, any>> = [];
  enqueue(sig: Record<string, any>): void { this.signals.push(sig); }
}

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
      { type: 'codebuddy', description: 'test acp worker', ...config } as WorkerConfig,
      sessionDir ?? '/tmp/acp-test-session',
      workspaceDir ?? '/tmp/acp-test-ws',
      createMockCtx({ sessionDir: sessionDir ?? '/tmp/acp-test-session', workspaceDir: workspaceDir ?? '/tmp/acp-test-ws' } as any),
      skills,
    );
    this.policy = { cancelGraceMs: 8_000, sigtermWaitMs: 2_000, trustUpdatesAfterCancel: opts.trustUpdatesAfterCancel ?? true };
    this.launchCommand = opts.command ?? 'node';
  }

  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    return { command: view.command ?? this.launchCommand, args: view.args ?? [], env: view.env, cwd: view.cwd, timeouts: view.timeouts };
  }
  protected createTransport(_config: AcpLaunchConfig): AcpTransport { return this.transport; }
  protected stopPolicy(): AcpStopPolicy { return this.policy; }
  /** Live client while run() is in flight (null after the finally closes it). */
  get liveClient() { return this._client; }
  /** Current turn's refusal ledger, before takeTurnDenials() clears it. */
  get turnDenials() { return this._turnDenials; }
  protected isReady(ctx: AcpReadyContext): AcpReadiness {
    return authAttributingReadiness(ctx, { provider: this.config.type, command: this._launchCommand });
  }
}

const HANDSHAKE_RESULT = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] as Array<{ id: string; name: string }> };
const TASK: TaskDetail & { workerId: string } = {
  id: 'task-turn', title: 'Turn loop', description: 'Run echo probe-ok', priority: 'normal', status: 'pending',
  createdAt: Date.now(), workerId: 'w-turn', executionTurnId: 'turn-1',
};
const SCOPE: WorkerAccessScope = { userHome: '/home/test-user', workspace: '/tmp/acp-test-ws' };
const DENY_SCOPE: WorkerAccessScope = { ...SCOPE, permission: { sensitiveMode: 'deny' } };

function respondTo(transport: FakeAgentTransport, index: number, result: unknown): void {
  const request = transport.clientMessages[index] as { id: number | string };
  transport.agentMessage({ jsonrpc: '2.0', id: request.id, result });
}

/** Locate the Nth session/prompt by METHOD NAME (round count), not a fixed line index. */
async function nthPromptIndex(transport: FakeAgentTransport, n: number): Promise<number> {
  for (;;) {
    const indices = transport.clientMessages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.method === 'session/prompt')
      .map(({ i }) => i);
    if (indices.length > n) return indices[n];
    await transport.waitForClientOutput(transport.clientOutput.length + 1);
  }
}

async function respondToPrompt(transport: FakeAgentTransport, n: number, result: unknown): Promise<void> {
  respondTo(transport, await nthPromptIndex(transport, n), result);
}

/** Text of the Nth session/prompt's first content block. */
async function promptTextAt(transport: FakeAgentTransport, n: number): Promise<string> {
  const idx = await nthPromptIndex(transport, n);
  return (transport.clientMessages[idx] as any).params.prompt[0].text as string;
}

async function waitForPermissionAnswer(transport: FakeAgentTransport, id: number): Promise<void> {
  for (;;) {
    if (transport.clientMessages.some((m) => m.id === id)) return;
    await transport.waitForClientOutput(transport.clientOutput.length + 1);
  }
}

async function openFakeSession(worker: TestAcpWorker): Promise<void> {
  const transport = worker.transport;
  await transport.waitForClientOutput(1);
  respondTo(transport, 0, HANDSHAKE_RESULT);
  await transport.waitForClientOutput(2);
  respondTo(transport, 1, { sessionId: 's-1' });
  await transport.waitForClientOutput(3);
}

function sendUpdate(worker: TestAcpWorker, update: Record<string, unknown>): void {
  worker.transport.agentMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update } });
}

function sendPermissionRequest(worker: TestAcpWorker, id: number, toolCall: Record<string, unknown>, options: unknown[]): void {
  worker.transport.agentMessage({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 's-1', toolCall, options } });
}

/** Measured sensitive execute stream. name/command/toolCallId vary denial keys. */
function sendSensitivePermissionRequest(
  worker: TestAcpWorker, requestId: number, toolCallId = 'tc-d1',
  command = 'cat /home/test-user/.ssh/id_rsa', name?: string,
): void {
  const nameField = name ? { name } : {};
  sendUpdate(worker, { sessionUpdate: 'tool_call', toolCallId, title: 'Bash', ...nameField, kind: 'other', status: 'in_progress', rawInput: {} });
  sendUpdate(worker, { sessionUpdate: 'tool_call_update', toolCallId, rawInput: { command } });
  sendUpdate(worker, { sessionUpdate: 'tool_call', toolCallId, title: 'cat sensitive', ...nameField, kind: 'execute', status: 'pending', rawInput: { command } });
  sendPermissionRequest(worker, requestId, { toolCallId, rawInput: { command } }, [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
  ]);
}

function signalContext(overrides: Record<string, unknown> = {}): any {
  return {
    signalQueue: new RecordingSignalQueue() as any,
    workerId: 'w-turn', taskId: TASK.id, taskTitle: TASK.title,
    ...overrides,
  };
}

describe('AcpWorkerRun: turn attribution and loop guard (#56)', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'acp-turn-loop-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  // 1) cancelled but WE sent no cancel and there were no denials → unexpected end.
  it('cancelled with no cancel we sent and no denials → agent_ended_unexpectedly, no "Aborted"', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext(signalContext());
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    await respondToPrompt(worker.transport, 0, { stopReason: 'cancelled' });
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('unexpectedly');
    expect(result.error).not.toContain('Aborted');
  });

  // 2) policy denial → one reissue with a sanitized notice → completed.
  it('policy denial → reissue (SYSTEM NOTICE, [redacted], no full command) → completed', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext(signalContext({ accessScope: DENY_SCOPE, grants: new ApprovalMemory(), approvalMemory: 'task' }));
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    const command = 'cat /home/test-user/.ssh/id_rsa_token';
    sendSensitivePermissionRequest(worker, 700, 'tc-reissue', command);
    await waitForPermissionAnswer(worker.transport, 700);
    await respondToPrompt(worker.transport, 0, { stopReason: 'cancelled' });

    const text = await promptTextAt(worker.transport, 1);
    expect(text).toContain('[SYSTEM NOTICE]');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(command);
    expect(text).not.toContain('SECRETVALUE');

    await respondToPrompt(worker.transport, 1, { stopReason: 'end_turn' });
    const result = await runPromise;
    expect(result.status).toBe('completed');
    const injected = worker.getConversation().filter((e: any) => e.metadata?.injected === 'acp-denial-notice');
    expect(injected).toHaveLength(1);
    expect((injected[0] as any).actor).toEqual({ kind: 'system', id: 'engine' });
  });

  // 3) the SAME key denied twice → terminate with a per-key/budget reason.
  it('a second denial with the same key terminates (per-key budget)', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext(signalContext({ accessScope: DENY_SCOPE, grants: new ApprovalMemory(), approvalMemory: 'task' }));
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    sendSensitivePermissionRequest(worker, 701, 'tc-same-a');
    await waitForPermissionAnswer(worker.transport, 701);
    await respondToPrompt(worker.transport, 0, { stopReason: 'cancelled' });

    await nthPromptIndex(worker.transport, 1);
    // Different toolCallId, SAME command/name → identical denial key.
    sendSensitivePermissionRequest(worker, 702, 'tc-same-b');
    await waitForPermissionAnswer(worker.transport, 702);
    await respondToPrompt(worker.transport, 1, { stopReason: 'cancelled' });

    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/per-key|budget/);
    expect(result.error).toContain('per-key budget exhausted'); // integration wording, not just the pure helper
    expect(worker.transport.clientMessages.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
  });

  // 4) controller denial → reissue with a SYSTEM NOTICE (source 用户); the
  // agent switches command in the notice round and completes.
  it('controller denial → reissue with SYSTEM NOTICE → agent switches command → completed', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext(signalContext({ signalQueue: queue as any, accessScope: SCOPE, grants: new ApprovalMemory(), approvalMemory: 'task' }));
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    sendSensitivePermissionRequest(worker, 703, 'tc-user');
    const payload = queue.signals[0].payload;
    expect(worker.permissionHandler.resolvePermission(payload.requestId, false, 'too dangerous')).toBe('resolved');
    await waitForPermissionAnswer(worker.transport, 703);
    await respondToPrompt(worker.transport, 0, { stopReason: 'cancelled' });

    const text = await promptTextAt(worker.transport, 1);
    expect(text).toContain('[SYSTEM NOTICE]');
    expect(text).toContain('拒绝来源=用户'); // denialSource=controller kept for the notice/audit
    expect(text).toContain('too dangerous');

    // The reissue round: the agent picks a DIFFERENT (compliant) command and
    // finishes normally — no permission request, no new denial.
    sendUpdate(worker, { sessionUpdate: 'tool_call', toolCallId: 'tc-alt', title: 'Bash', kind: 'execute', status: 'completed', rawInput: { command: 'echo safe' } });
    await respondToPrompt(worker.transport, 1, { stopReason: 'end_turn' });
    const result = await runPromise;
    expect(result.status).toBe('completed');
  });

  // 4a) controller deny + end_turn in the SAME turn → completed, not FAILED.
  it('controller denial + end_turn → completed (a denial never overrides a normal end)', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext(signalContext({ signalQueue: queue as any, accessScope: SCOPE, grants: new ApprovalMemory(), approvalMemory: 'task' }));
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    sendSensitivePermissionRequest(worker, 704, 'tc-user-end');
    const payload = queue.signals[0].payload;
    expect(worker.permissionHandler.resolvePermission(payload.requestId, false, 'nope')).toBe('resolved');
    await waitForPermissionAnswer(worker.transport, 704);
    await respondToPrompt(worker.transport, 0, { stopReason: 'end_turn' });

    const result = await runPromise;
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    // The agent ended normally — no reissue round was needed.
    expect(worker.transport.clientMessages.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  });

  // 4b) reissue budget exhaustion: alternating deny/comply rounds burn the
  // MAX_DENIAL_REISSUES budget; the 4th controller denial terminates.
  it('controller denials exhaust the reissue budget → terminate with an explicit reason', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    const queue = new RecordingSignalQueue();
    worker.setSignalContext(signalContext({ signalQueue: queue as any, accessScope: SCOPE, grants: new ApprovalMemory(), approvalMemory: 'task' }));
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    for (let round = 0; round < 7; round++) {
      await nthPromptIndex(worker.transport, round);
      if (round % 2 === 0) {
        // A controller denial; a fresh tool name each round keeps every
        // denial KEY distinct (the sanitized target folds id_rsa_N together),
        // so only the REISSUE budget is at play.
        const reqId = 720 + round;
        sendSensitivePermissionRequest(worker, reqId, `tc-budget-${round}`, 'cat /home/test-user/.ssh/id_rsa', `budget-${round}`);
        const payload = queue.signals[queue.signals.length - 1].payload;
        expect(worker.permissionHandler.resolvePermission(payload.requestId, false, 'denied again')).toBe('resolved');
        await waitForPermissionAnswer(worker.transport, reqId);
        await respondToPrompt(worker.transport, round, { stopReason: 'cancelled' });
      } else {
        // The agent complies: fresh progress text + a queued controller
        // message keep the loop going without touching the denial budgets.
        worker.acceptMessage(`continue-${round}`);
        sendUpdate(worker, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(round + 1) }, messageId: `m-${round}` });
        await respondToPrompt(worker.transport, round, { stopReason: 'end_turn' });
      }
    }

    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Permission denied by user');
    expect(result.error).toContain('denial reissue budget exhausted (3/3)');
    expect(worker.transport.clientMessages.filter((m) => m.method === 'session/prompt')).toHaveLength(7);
  });

  // 4b) permissionMode 'agent': a protocol-level denial is recorded but NOT injected.
  it('permissionMode "agent": one denial → no reissue, no SYSTEM NOTICE, policy termination', async () => {
    const worker = new TestAcpWorker({}, { permissionMode: 'agent' }, tempDir, tempDir);
    worker.setSignalContext(signalContext());
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);

    sendPermissionRequest(worker, 760, { toolCallId: 'tc-agent', name: 'bash', rawInput: { command: 'echo hi' } }, [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
    ]);
    await waitForPermissionAnswer(worker.transport, 760);
    // Snapshot before the turn boundary's takeTurnDenials() clears the ledger.
    const recorded = worker.turnDenials.map((d) => ({ ...d }));

    await respondToPrompt(worker.transport, 0, { stopReason: 'cancelled' });
    const result = await runPromise;

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ source: 'policy', injectable: false });
    const prompts = worker.transport.clientMessages.filter((m) => m.method === 'session/prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts.some((m) => JSON.stringify(m).includes('[SYSTEM NOTICE]'))).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Permission denied by policy');
  });

  // 5) abort → 'Aborted' + close('cancel'); promptMs timeout → timeout wording + close('run-finished').
  it('abort → "Aborted"; promptMs timeout → timeout wording (different)', async () => {
    const abortWorker = new TestAcpWorker({}, {}, tempDir, tempDir);
    abortWorker.setSignalContext(signalContext());
    const abortPromise = abortWorker.run(TASK, {});
    await openFakeSession(abortWorker);
    abortWorker.abort();
    await abortWorker.transport.waitForClientOutput(4);
    const abortClient = abortWorker.liveClient; // still in flight before respondToPrompt
    await respondToPrompt(abortWorker.transport, 0, { stopReason: 'cancelled' });
    const abortResult = await abortPromise;
    expect(abortResult.error).toBe('Aborted');
    expect(abortWorker.transport.closeCalls.map((c) => c.reason)).toContain('cancel');
    expect(abortClient).not.toBeNull();
    expect(abortClient!.cancelSentCount).toBeGreaterThan(0); // incremented from 0
    expect(abortClient!.lastCancelReason).toBe('abort');

    const timeoutWorker = new TestAcpWorker({}, { protocol: { promptMs: 5, cancelGraceMs: 200 } }, tempDir, tempDir);
    timeoutWorker.setSignalContext(signalContext());
    const timeoutPromise = timeoutWorker.run(TASK, {});
    await openFakeSession(timeoutWorker);
    // The tracker's promptMs expiry writes session/cancel tagged 'prompt-timeout'.
    await timeoutWorker.transport.waitForClientOutput(4);
    expect(timeoutWorker.transport.clientMessages[3].method).toBe('session/cancel');
    const timeoutClient = timeoutWorker.liveClient;
    await respondToPrompt(timeoutWorker.transport, 0, { stopReason: 'cancelled' });
    const timeoutResult = await timeoutPromise;
    expect(timeoutResult.error).toContain('timed out'); // our_timeout wording
    expect(timeoutResult.error).not.toContain('Aborted');
    expect(timeoutResult.error).not.toBe(abortResult.error);
    // A timeout is NOT an abort: the client is closed on the normal path.
    expect(timeoutWorker.transport.closeCalls.map((c) => c.reason)).toEqual(['run-finished']);
    expect(timeoutClient).not.toBeNull();
    expect(timeoutClient!.cancelSentCount).toBeGreaterThan(0); // incremented from 0
    // cancelFact is derived from lastCancelReason ⇒ classifyTurnEnd → our_timeout.
    expect(timeoutClient!.lastCancelReason).toBe('prompt-timeout');
  });

  // 6) multiple queued messages delivered in ONE round, no denial quota used.
  it('multiple queued messages are delivered in one round and do not use the denial quota', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext(signalContext());
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    worker.acceptMessage('first');
    worker.acceptMessage('second');
    worker.acceptMessage('third');
    await respondToPrompt(worker.transport, 0, { stopReason: 'end_turn' });

    const text = await promptTextAt(worker.transport, 1);
    expect(text).toBe('[Controller message] first\n---\n[Controller message] second\n---\n[Controller message] third');
    expect(text).not.toContain('[SYSTEM NOTICE]');
    await respondToPrompt(worker.transport, 1, { stopReason: 'end_turn' });
    const result = await runPromise;
    expect(result.status).toBe('completed');
    // The delivery round also left a system-actor transcript marker.
    const injected = worker.getConversation().filter((e: any) => e.metadata?.injected === 'controller-delivery');
    expect(injected).toHaveLength(1);
  });

  // 7a) no turn-count ceiling (v0.9.7 removed the hardcoded 12-turn cap):
  // 13 turns with fresh progress must end naturally, never on a turn limit.
  it('13 turns with fresh progress do not hit any turn-count ceiling', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext(signalContext());
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    // Prompt 0 (the initial task prompt) is already in flight. One queued
    // follow-up per turn keeps the loop going; the follow-up is accepted only
    // after the next prompt exists (turn i-1's decision already consumed the
    // queue), so each turn's verdict sees exactly its own message.
    worker.acceptMessage('go-0');
    sendUpdate(worker, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x', messageId: 'm-0' } });
    await respondToPrompt(worker.transport, 0, { stopReason: 'end_turn' });
    for (let i = 1; i < 13; i++) {
      await nthPromptIndex(worker.transport, i);
      if (i < 12) worker.acceptMessage(`go-${i}`);
      sendUpdate(worker, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(i + 1) }, messageId: `m-${i}` });
      await respondToPrompt(worker.transport, i, { stopReason: 'end_turn' });
    }
    const result = await runPromise;
    // 13 full turns — one past the removed 12-turn cap — and the run still
    // completed naturally instead of being cut off by a turn limit.
    expect(worker.transport.clientMessages.filter((m) => m.method === 'session/prompt')).toHaveLength(13);
    expect(result.status).toBe('completed');
  });

  // 7b) consecutive denial turns (different keys).
  it('two consecutive denial turns terminate even with different keys', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext(signalContext({ accessScope: DENY_SCOPE, grants: new ApprovalMemory(), approvalMemory: 'task' }));
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    for (let i = 0; i < 3; i++) {
      const id = 710 + i;
      await nthPromptIndex(worker.transport, i);
      sendSensitivePermissionRequest(worker, id, `tc-consec-${i}`, 'cat /home/test-user/.ssh/id_rsa', `bash-${i}`);
      await waitForPermissionAnswer(worker.transport, id);
      await respondToPrompt(worker.transport, i, { stopReason: 'cancelled' });
    }
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('consecutive denial turns');
    expect(worker.transport.clientMessages.filter((m) => m.method === 'session/prompt')).toHaveLength(3);
  });

  // 7c) no progress across turns.
  it('no progress across turns terminates with the stagnation reason', async () => {
    const worker = new TestAcpWorker({}, {}, tempDir, tempDir);
    worker.setSignalContext(signalContext());
    const runPromise = worker.run(TASK, {});
    await openFakeSession(worker);
    for (let i = 0; i < 4; i++) {
      worker.acceptMessage(`go-${i}`);
      await respondToPrompt(worker.transport, i, { stopReason: 'end_turn' });
    }
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no progress');
  });
});
