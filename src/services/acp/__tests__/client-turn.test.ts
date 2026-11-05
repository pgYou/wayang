import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '@/services/acp/client';
import { AcpError } from '@/services/acp/errors';
import type { AcpPermissionOutcome } from '@/services/acp/types';
import { FakeAgentTransport, createDeferred, expectAcpError, makeClientOptions, type Deferred } from './fake-agent-transport';

let transport: FakeAgentTransport;
let client: AcpClient;

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeAgentTransport();
  client = new AcpClient(transport, makeClientOptions());
});

afterEach(() => {
  vi.useRealTimers();
});

const response = (id: number, result: unknown) => ({ jsonrpc: '2.0', id, result });
const blocks = [{ type: 'text' as const, text: 'go' }];

const permissionRequest = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', rawInput: { command: 'echo hi' } },
    options: [
      { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
      { optionId: 'allow', name: 'Once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  },
});

describe('AcpClient.sessionPrompt', () => {
  it('sends the frozen params and resolves AcpTurnResult with raw passthrough', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    expect(transport.clientMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's1', prompt: blocks },
    });
    transport.agentMessage(response(1, { stopReason: 'end_turn', userMessageId: 'um-1' }));
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn', raw: { stopReason: 'end_turn', userMessageId: 'um-1' } });
  });

  it('enforces per-session serialization with protocol-mismatch', async () => {
    const first = client.sessionPrompt('s1', blocks);
    await expectAcpError(client.sessionPrompt('s1', blocks), 'protocol-mismatch');
    // A different session may run concurrently.
    const other = client.sessionPrompt('s2', blocks);
    transport.agentMessage(response(1, { stopReason: 'end_turn' }));
    transport.agentMessage(response(2, { stopReason: 'end_turn' }));
    await expect(first).resolves.toMatchObject({ stopReason: 'end_turn' });
    await expect(other).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('frees the session slot once the turn settles', async () => {
    const first = client.sessionPrompt('s1', blocks);
    transport.agentMessage(response(1, { stopReason: 'end_turn' }));
    await first;
    const second = client.sessionPrompt('s1', blocks);
    transport.agentMessage(response(2, { stopReason: 'end_turn' }));
    await expect(second).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('maps a JSON-RPC error response to agent-error with rpc detail', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.agentMessage({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'model overloaded' } });
    const err = await expectAcpError(prompt, 'agent-error');
    expect(err.detail?.rpc).toEqual({ code: -32603, message: 'model overloaded' });
  });

  it('maps a -32800 error response to cancelled', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.agentMessage({ jsonrpc: '2.0', id: 1, error: { code: -32800, message: 'cancelled' } });
    await expectAcpError(prompt, 'cancelled');
  });

  it('rejects a result without a valid stopReason as protocol-mismatch', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.agentMessage(response(1, { userMessageId: 'um-1' }));
    await expectAcpError(prompt, 'protocol-mismatch');
  });

  it('promptMs=0 means unlimited: no cancel is sent however long we wait', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(transport.clientMessages).toHaveLength(1);
    transport.agentMessage(response(1, { stopReason: 'end_turn' }));
    await expect(prompt).resolves.toMatchObject({ stopReason: 'end_turn' });
  });
});

describe('AcpClient cancel path (§6)', () => {
  it('promptMs expiry sends session/cancel and resolves when the agent answers cancelled', async () => {
    const promptClient = new AcpClient(
      transport,
      makeClientOptions({ timeouts: { ...makeClientOptions().timeouts, promptMs: 5_000, cancelGraceMs: 3_000 } }),
    );
    const prompt = promptClient.sessionPrompt('s1', blocks);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.clientMessages[1]).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's1' },
    });
    transport.agentMessage(response(1, { stopReason: 'cancelled' }));
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
  });

  it('promptMs expiry without settle rejects cancelled after the grace window', async () => {
    const promptClient = new AcpClient(
      transport,
      makeClientOptions({ timeouts: { ...makeClientOptions().timeouts, promptMs: 5_000, cancelGraceMs: 3_000 } }),
    );
    const prompt = promptClient.sessionPrompt('s1', blocks);
    const assertion = expectAcpError(prompt, 'cancelled');
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await assertion;
    expect(err.message).toContain('grace');
  });

  it('sessionCancel answers all pending permissions immediately and drops late handler outcomes', async () => {
    const gates: Array<Deferred<AcpPermissionOutcome>> = [];
    client.onPermissionRequest(() => {
      const gate = createDeferred<AcpPermissionOutcome>();
      gates.push(gate);
      return gate.promise;
    });
    transport.agentMessage(permissionRequest(41));
    transport.agentMessage(permissionRequest(42));

    client.sessionCancel('s1');
    const responses = transport.clientMessages.filter((m) => m.id === 41 || m.id === 42);
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 41, result: { outcome: { outcome: 'cancelled' } } },
      { jsonrpc: '2.0', id: 42, result: { outcome: { outcome: 'cancelled' } } },
    ]);

    gates[0].resolve({ outcome: 'selected', optionId: 'allow' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.stats.latePermissionOutcomes).toBe(1);
    // Still exactly one response per peer request id.
    expect(transport.clientMessages.filter((m) => m.id === 41)).toHaveLength(1);
  });

  it('late updates after cancel are still dispatched to onUpdate (client never drops)', () => {
    const received: any[] = [];
    client.onUpdate((update) => received.push(update));
    client.sessionCancel('s1');
    transport.agentMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 3, size: 10 } },
    });
    expect(received).toHaveLength(1);
  });

  it('permissionMs is a fail-closed net for handlers that never settle', async () => {
    client.onPermissionRequest(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    transport.agentMessage(permissionRequest(51));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(transport.clientMessages).toEqual([
      { jsonrpc: '2.0', id: 51, result: { outcome: { outcome: 'cancelled' } } },
    ]);
  });
});

describe('AcpClient.close and transport failures', () => {
  it('close(shutdown) settles a pending prompt with transport-closed and permissions with cancelled', async () => {
    const gate = createDeferred<AcpPermissionOutcome>();
    client.onPermissionRequest(() => gate.promise);
    transport.agentMessage(permissionRequest(61));

    const prompt = client.sessionPrompt('s1', blocks);
    const closing = client.close('shutdown');
    const err = await expectAcpError(prompt, 'transport-closed');
    expect(err.detail).toBeUndefined();
    expect(transport.clientMessages.find((m) => m.id === 61)).toEqual({
      jsonrpc: '2.0',
      id: 61,
      result: { outcome: { outcome: 'cancelled' } },
    });
    await expect(closing).resolves.toEqual({ code: 0, signal: null, reason: 'shutdown', cancelled: false });
    expect(transport.closeCalls).toEqual([{ sigtermWaitMs: 2_000, reason: 'shutdown' }]);
    gate.resolve({ outcome: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.stats.latePermissionOutcomes).toBe(1);
  });

  it('close(cancel) settles a pending prompt with cancelled', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    const closing = client.close('cancel');
    await expectAcpError(prompt, 'cancelled');
    await expect(closing).resolves.toMatchObject({ reason: 'cancel', cancelled: true });
  });

  it('close is idempotent: a second call returns the recorded info', async () => {
    const first = await client.close('shutdown');
    const second = await client.close('cancel');
    expect(second).toEqual(first);
  });

  it('a crashed process settles a pending prompt with transport-closed + exit detail', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.emitStderrLine('fatal: oom');
    transport.simulateExit({ code: 137, signal: 'SIGKILL', reason: 'crash', cancelled: false });
    const err = await expectAcpError(prompt, 'transport-closed');
    expect(err.detail?.exit).toEqual({ code: 137, signal: 'SIGKILL', reason: 'crash', cancelled: false });
    expect(err.detail?.stderrTail).toEqual(['fatal: oom']);
    expect(err.userMessage).toContain('code=137');
  });

  it('a cancel-path exit settles a pending prompt with cancelled', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.simulateExit({ code: 0, signal: 'SIGTERM', reason: 'cancel', cancelled: true });
    await expectAcpError(prompt, 'cancelled');
  });

  it('a code-0 exit with an in-flight turn settles the prompt as protocol-mismatch (unclean exit)', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.simulateExit({ code: 0, signal: null, reason: 'crash', cancelled: false });
    const err = await expectAcpError(prompt, 'protocol-mismatch');
    expect(err.message).toContain('code 0');
    expect(err.detail?.reason).toBe('agent 退出但回合未结束');
    expect(err.userMessage).toContain('agent 退出但回合未结束');
  });

  it('a code-0 exit with no in-flight turn raises no error (only the standard fail-fast)', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.agentMessage(response(1, { stopReason: 'end_turn' }));
    await expect(prompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    transport.simulateExit({ code: 0, signal: null, reason: 'crash', cancelled: false });
    // Nothing was in flight: the client closes without classifying anything as
    // protocol-mismatch — the next request fails fast with the usual code.
    await expectAcpError(client.sessionNew({ cwd: '/w', mcpServers: [] }), 'transport-closed');
  });

  it('a fatal protocol error (e.g. framing) takes precedence over the later close settlement', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.emitStreamError(new AcpError('protocol-mismatch', 'ndjson framing error: line exceeds 65536 bytes'));
    await expectAcpError(prompt, 'protocol-mismatch');
    // Subsequent requests fail fast with the fatal error.
    await expectAcpError(client.sessionNew({ cwd: '/w', mcpServers: [] }), 'protocol-mismatch');
    // Closing still works and reports the process exit.
    await expect(client.close('shutdown')).resolves.toMatchObject({ reason: 'shutdown' });
  });

  it('a non-Acp stream error converges pending prompts as transport-closed and closes with reason crash', async () => {
    const prompt = client.sessionPrompt('s1', blocks);
    transport.emitStreamError(new Error('EPIPE'));
    const err = await expectAcpError(prompt, 'transport-closed');
    expect(err.message).toContain('EPIPE');
    expect(client.stats.streamErrors).toBe(1);
    expect(transport.closeCalls).toEqual([{ sigtermWaitMs: 2_000, reason: 'crash' }]);
  });

  it('a non-Acp stream error converges a hanging prompt even when promptMs=0 (no orphaned timer handles)', async () => {
    // promptMs defaults to 0: the agent never answers and no cancel timer is
    // armed — the stream error is the only thing that can settle the turn.
    const prompt = client.sessionPrompt('s1', blocks);
    const assertion = expectAcpError(prompt, 'transport-closed');
    transport.emitStreamError(new Error('read ECONNRESET'));
    const err = await assertion; // settles on the error itself, not on any timer
    expect(err.message).toContain('ECONNRESET');
    expect(client.stats.streamErrors).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('promptMs cancel flow also cancels pending permissions mid-turn', async () => {
    const promptClient = new AcpClient(
      transport,
      makeClientOptions({ timeouts: { ...makeClientOptions().timeouts, promptMs: 5_000, cancelGraceMs: 3_000 } }),
    );
    promptClient.onPermissionRequest(
      () =>
        new Promise(() => {
          /* pending */
        }),
    );
    const prompt = promptClient.sessionPrompt('s1', blocks);
    transport.agentMessage(permissionRequest(71));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.clientMessages.find((m) => m.id === 71)).toEqual({
      jsonrpc: '2.0',
      id: 71,
      result: { outcome: { outcome: 'cancelled' } },
    });
    const assertion = expectAcpError(prompt, 'cancelled');
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });
});
