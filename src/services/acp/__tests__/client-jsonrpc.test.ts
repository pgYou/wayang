import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '@/services/acp/client';
import { FakeAgentTransport, expectAcpError, makeClientOptions, settlementTracker } from './fake-agent-transport';

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
const errorResponse = (id: number, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const notification = (method: string, params: unknown) => ({ jsonrpc: '2.0', method, params });
const sessionUpdate = (update: Record<string, unknown>) =>
  notification('session/update', { sessionId: 's1', update });

describe('AcpClient JSON-RPC request correlation', () => {
  it('assigns auto-increment ids starting at 1', async () => {
    const initialized = client.initialize();
    transport.agentMessage(response(1, { protocolVersion: 1 }));
    await initialized;
    const auth = client.authenticate('iOA');
    transport.agentMessage(response(2, {}));
    await auth;
    expect(transport.clientMessages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('notifications from the agent never consume ids or create pending entries', async () => {
    const initialized = client.initialize();
    transport.agentMessage(response(1, { protocolVersion: 1 }));
    await initialized;
    transport.agentMessage(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }));
    const auth = client.authenticate('iOA');
    expect(transport.clientMessages[1].id).toBe(2);
    transport.agentMessage(response(2, {}));
    await auth;
  });

  it('resolves concurrent requests independently when responses arrive out of order', async () => {
    const newSession = client.sessionNew({ cwd: '/w', mcpServers: [] });
    const auth = client.authenticate('iOA');
    // session/new has id 1, authenticate id 2 — answer 2 first.
    transport.agentMessage(response(2, {}));
    transport.agentMessage(response(1, { sessionId: 's-1', modes: {} }));
    await expect(newSession).resolves.toEqual({ sessionId: 's-1' });
    await expect(auth).resolves.toBeUndefined();
  });

  it('drops and records responses with an unknown id', async () => {
    const auth = client.authenticate('iOA'); // id 1
    transport.agentMessage(response(999, {}));
    expect(client.stats.unknownResponseIds).toBe(1);
    // The legit response still resolves its own request.
    transport.agentMessage(response(1, {}));
    await expect(auth).resolves.toBeUndefined();
    expect(client.stats.unknownResponseIds).toBe(1);
  });

  it('drops string-id responses and counts them as unknown ids', async () => {
    const auth = client.authenticate('iOA');
    transport.agentMessage(response(1, {}));
    transport.agentMessage({ jsonrpc: '2.0', id: 'not-ours', result: {} });
    expect(client.stats.unknownResponseIds).toBe(1);
    await auth;
  });

  it('maps a JSON-RPC error response for a request to agent-error with rpc detail', async () => {
    const auth = client.authenticate('iOA');
    transport.agentMessage(errorResponse(1, -32603, 'boom'));
    const err = await expectAcpError(auth, 'agent-error');
    expect(err.detail?.rpc).toEqual({ code: -32603, message: 'boom' });
  });

  it('rejects new requests immediately after the transport closed', async () => {
    transport.simulateExit({ code: 1, signal: null, reason: 'crash', cancelled: false });
    await expectAcpError(client.authenticate('iOA'), 'transport-closed');
  });
});

describe('AcpClient line classification', () => {
  it('skips empty lines without counting them as non-JSON', () => {
    transport.agentLine('   ');
    transport.agentLine('');
    expect(client.stats.emptyLines).toBe(2);
    expect(client.stats.nonJsonLines).toBe(0);
  });

  it('counts non-JSON lines and trips protocol-mismatch at the configured limit', async () => {
    const prompt = client.sessionPrompt('s1', [{ type: 'text', text: 'go' }]);
    for (let i = 0; i < 50; i += 1) transport.agentLine('not json at all');
    await expectAcpError(prompt, 'protocol-mismatch');
    expect(client.stats.nonJsonLines).toBe(50);
  });

  it('resets the non-JSON streak on a valid JSON-RPC line', async () => {
    const prompt = client.sessionPrompt('s1', [{ type: 'text', text: 'go' }]);
    for (let i = 0; i < 49; i += 1) transport.agentLine('garbage');
    transport.agentMessage(sessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2 }));
    for (let i = 0; i < 49; i += 1) transport.agentLine('garbage');
    const tracker = settlementTracker(prompt);
    expect(await tracker.settled()).toBe(false);
  });

  it('counts malformed message shapes (no method, no id) as non-JSON', () => {
    transport.agentMessage({ hello: 'world' });
    transport.agentMessage([1, 2, 3]);
    expect(client.stats.nonJsonLines).toBe(2);
  });
});

describe('AcpClient session/update dispatch', () => {
  it('dispatches update payloads to onUpdate handlers', () => {
    const received: any[] = [];
    client.onUpdate((update) => received.push(update));
    transport.agentMessage(
      sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' }, messageId: 'm-1' }),
    );
    expect(received).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' }, messageId: 'm-1' },
    ]);
  });

  it('a throwing onUpdate handler is counted and never breaks the read loop', () => {
    const second: any[] = [];
    client.onUpdate(() => {
      throw new Error('handler blew up');
    });
    client.onUpdate((update) => second.push(update));
    transport.agentMessage(sessionUpdate({ sessionUpdate: 'plan', entries: [] }));
    transport.agentMessage(sessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2 }));
    expect(client.stats.handlerErrors).toBe(2);
    expect(second).toHaveLength(2);
  });

  it('supports unsubscribe from onUpdate', () => {
    const received: any[] = [];
    const unsubscribe = client.onUpdate((update) => received.push(update));
    transport.agentMessage(sessionUpdate({ sessionUpdate: 'plan', entries: [] }));
    unsubscribe();
    transport.agentMessage(sessionUpdate({ sessionUpdate: 'plan', entries: [] }));
    expect(received).toHaveLength(1);
  });

  it('official-but-unmapped variants (session_info_update etc.) are known and never trip the limit', () => {
    const received: any[] = [];
    client.onUpdate((update) => received.push(update));
    for (let i = 0; i < 60; i += 1) {
      transport.agentMessage(sessionUpdate({ sessionUpdate: 'session_info_update', info: i }));
    }
    expect(received).toHaveLength(60);
    expect(client.stats.unknownVariants).toBe(0);
  });

  it('trips protocol-mismatch after 50 consecutive unknown variants', async () => {
    const prompt = client.sessionPrompt('s1', [{ type: 'text', text: 'go' }]);
    for (let i = 0; i < 50; i += 1) {
      transport.agentMessage(sessionUpdate({ sessionUpdate: `vendor_update_${i}` }));
    }
    await expectAcpError(prompt, 'protocol-mismatch');
    expect(client.stats.unknownVariants).toBe(50);
  });

  it('resets the unknown-variant streak on a known variant', async () => {
    const prompt = client.sessionPrompt('s1', [{ type: 'text', text: 'go' }]);
    for (let i = 0; i < 49; i += 1) {
      transport.agentMessage(sessionUpdate({ sessionUpdate: `vendor_update_${i}` }));
    }
    transport.agentMessage(sessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2 }));
    for (let i = 0; i < 49; i += 1) {
      transport.agentMessage(sessionUpdate({ sessionUpdate: `vendor_update_b_${i}` }));
    }
    const tracker = settlementTracker(prompt);
    expect(await tracker.settled()).toBe(false);
  });

  it('a malformed session/update payload counts as a non-JSON line', () => {
    transport.agentMessage(notification('session/update', { sessionId: 's1', update: 'nope' }));
    expect(client.stats.nonJsonLines).toBe(1);
  });
});

describe('AcpClient peer requests and notifications', () => {
  const permissionRequest = (id: number, options: unknown[] = []) => ({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: { sessionId: 's1', toolCall: { toolCallId: 't1', rawInput: { command: 'ls' } }, options },
  });

  it('answers unknown peer methods with -32601', () => {
    transport.agentMessage({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/etc/hosts' } });
    expect(transport.clientMessages).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'method not found: fs/read_text_file' } },
    ]);
    expect(client.stats.unansweredPeerMethods).toBe(1);
  });

  it('routes request_permission to the handler and writes the outcome response', async () => {
    client.onPermissionRequest(async (req) => {
      expect(req.sessionId).toBe('s1');
      expect(req.toolCall.toolCallId).toBe('t1');
      expect(req.options).toEqual([{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]);
      return { outcome: 'selected', optionId: 'allow' };
    });
    transport.agentMessage(
      permissionRequest(9, [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.clientMessages).toEqual([
      { jsonrpc: '2.0', id: 9, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
    ]);
  });

  it('answers -32603 when the permission handler throws', async () => {
    client.onPermissionRequest(async () => {
      throw new Error('policy exploded');
    });
    transport.agentMessage(permissionRequest(11, []));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.clientMessages).toEqual([
      { jsonrpc: '2.0', id: 11, error: { code: -32603, message: 'policy exploded' } },
    ]);
  });

  it('fail-closed: answers outcome cancelled when no handler is registered', async () => {
    transport.agentMessage(permissionRequest(12, []));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.clientMessages).toEqual([
      { jsonrpc: '2.0', id: 12, result: { outcome: { outcome: 'cancelled' } } },
    ]);
  });

  it('fail-closed: normalizes a garbage handler outcome to cancelled', async () => {
    client.onPermissionRequest(async () => 'nonsense' as never);
    transport.agentMessage(permissionRequest(13, []));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.clientMessages).toEqual([
      { jsonrpc: '2.0', id: 13, result: { outcome: { outcome: 'cancelled' } } },
    ]);
  });

  it('answers -32603 for malformed permission params', async () => {
    transport.agentMessage({ jsonrpc: '2.0', id: 14, method: 'session/request_permission', params: { nope: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.clientMessages[0].error.code).toBe(-32603);
  });

  it('receives $/cancel_request without processing it', () => {
    transport.agentMessage(notification('$/cancel_request', { id: 1 }));
    expect(transport.clientMessages).toHaveLength(0);
    expect(client.stats.cancelRequestNotifications).toBe(1);
  });

  it('counts unknown notifications without responding', () => {
    transport.agentMessage(notification('vendor/ping', {}));
    expect(transport.clientMessages).toHaveLength(0);
    expect(client.stats.unknownNotifications).toBe(1);
  });

  it('peer request ids never collide with our request ids', async () => {
    client.onPermissionRequest(async () => ({ outcome: 'cancelled' }));
    const initialized = client.initialize();
    transport.agentMessage(permissionRequest(1, []));
    transport.agentMessage(response(1, { protocolVersion: 1 }));
    await initialized;
    const auth = client.authenticate('iOA');
    expect(transport.clientMessages[2].id).toBe(2); // our ids keep sequencing
    transport.agentMessage(response(2, {}));
    await auth;
    expect(client.stats.peerRequests).toBe(1);
  });
});
