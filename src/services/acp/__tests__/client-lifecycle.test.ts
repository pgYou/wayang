import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, buildAcpCapabilities, selectAllowOption, selectRejectOption } from '@/services/acp/client';
import type { AcpHandshake } from '@/services/acp/types';
import { FakeAgentTransport, expectAcpError, makeClientOptions } from './fake-agent-transport';

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

const HANDSHAKE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    delegateToolsSupport: true,
    multitaskSupport: false,
  },
  authMethods: [
    { id: 'iOA', name: 'Login with iOA' },
    { id: 'external', name: 'Login with Google/Github', description: null },
    { broken: true },
    null,
  ],
  agentInfo: { name: 'codebuddy', version: '2.167.0' },
};

describe('AcpClient.initialize', () => {
  it('sends the frozen initialize request shape and parses the handshake', async () => {
    const initialized = client.initialize();
    expect(transport.clientMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: false },
        },
        clientInfo: { name: 'wayang-test', version: '0.9.0-test' },
      },
    });
    transport.agentMessage(response(1, HANDSHAKE_RESULT));
    const handshake = await initialized;
    expect(handshake.protocolVersion).toBe(1);
    expect(handshake.agentCapabilities.loadSession).toBe(true);
    // Vendor fields are preserved verbatim on `raw`.
    expect((handshake.agentCapabilities.raw as Record<string, unknown>).delegateToolsSupport).toBe(true);
    // Invalid authMethods entries are dropped.
    expect(handshake.authMethods).toEqual([
      { id: 'iOA', name: 'Login with iOA' },
      { id: 'external', name: 'Login with Google/Github', description: null },
    ]);
    expect(handshake.agentInfo).toEqual({ name: 'codebuddy', version: '2.167.0' });
    expect(transport.closeCalls).toHaveLength(0);
  });

  it('passes a provided clientCapabilities through (normalized)', async () => {
    const custom = new AcpClient(
      transport,
      makeClientOptions({
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false, auth: { terminal: false } },
      }),
    );
    const initialized = custom.initialize();
    transport.agentMessage(response(1, HANDSHAKE_RESULT));
    await initialized;
    expect(transport.clientMessages[0].params.clientCapabilities.fs.readTextFile).toBe(true);
  });

  it('times out to handshake-timeout and closes the transport (no orphans)', async () => {
    const initialized = client.initialize();
    // Attach the handler before advancing time so the rejection is never unhandled.
    const assertion = expectAcpError(initialized, 'handshake-timeout');
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await assertion;
    expect(err.message).toContain('15000ms');
    expect(err.userMessage).toContain('握手超时');
    expect(err.userMessage).toContain('15s 无 initialize 响应');
    expect(transport.closeCalls).toEqual([{ sigtermWaitMs: 2_000, reason: 'shutdown' }]);
    // After the transport is closed, further requests fail fast instead of hanging.
    await expectAcpError(client.sessionNew({ cwd: '/w', mcpServers: [] }), 'transport-closed');
  });

  it('counts a late initialize response as an unknown id without reviving pending', async () => {
    const initialized = client.initialize();
    const assertion = expectAcpError(initialized, 'handshake-timeout');
    // Fire the timer synchronously and answer in the same tick — after the
    // request is detached (timeout) but before initialize's catch path
    // unsubscribes from the transport, exactly like an agent racing the timeout.
    vi.advanceTimersByTime(15_000);
    transport.agentMessage(response(1, HANDSHAKE_RESULT));
    await assertion;
    // The late response is dropped as unknown, and the request is not revived.
    expect(client.stats.unknownResponseIds).toBe(1);
    expect(transport.closeCalls).toEqual([{ sigtermWaitMs: 2_000, reason: 'shutdown' }]);
    expect(transport.isClosed).toBe(true);
  });

  it('rejects a protocol version other than 1 as protocol-mismatch and closes', async () => {
    const initialized = client.initialize();
    transport.agentMessage(response(1, { ...HANDSHAKE_RESULT, protocolVersion: 2 }));
    const err = await expectAcpError(initialized, 'protocol-mismatch');
    expect(err.message).toContain('2');
    expect(err.userMessage).toContain('版本 2');
    expect(transport.closeCalls[0].reason).toBe('shutdown');
  });

  it('classifies an initialize error response as agent-error and closes', async () => {
    const initialized = client.initialize();
    transport.agentMessage({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'nope' } });
    await expectAcpError(initialized, 'agent-error');
    expect(transport.closeCalls).toHaveLength(1);
  });
});

describe('AcpClient.authenticate', () => {
  it('sends the request with methodId and resolves on any result', async () => {
    const auth = client.authenticate('iOA');
    expect(transport.clientMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'authenticate',
      params: { methodId: 'iOA' },
    });
    transport.agentMessage(response(1, {}));
    await expect(auth).resolves.toBeUndefined();
  });
});

describe('AcpClient.sessionNew', () => {
  const cwd = '/data/workspace/task-1';

  it('sends cwd and mcpServers, keeps only sessionId, ignores vendor fields', async () => {
    const newSession = client.sessionNew({ cwd, mcpServers: [] });
    expect(transport.clientMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd, mcpServers: [] },
    });
    transport.agentMessage(
      response(1, { sessionId: '01a1-abc', modes: { currentModeId: 'default' }, models: { a: 1 }, multitaskOn: false }),
    );
    await expect(newSession).resolves.toEqual({ sessionId: '01a1-abc' });
  });

  it('times out to auth-required when the handshake declared auth methods', async () => {
    const initialized = client.initialize();
    transport.agentMessage(response(1, HANDSHAKE_RESULT));
    await initialized;
    const newSession = client.sessionNew({ cwd, mcpServers: [] });
    const assertion = expectAcpError(newSession, 'auth-required');
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await assertion;
    expect(err.detail?.stderrTail).toEqual([]);
    expect(transport.closeCalls).toHaveLength(0); // session/new timeout does not auto-close
  });

  it('times out to agent-error when no auth methods were declared', async () => {
    const initialized = client.initialize();
    transport.agentMessage(response(1, { ...HANDSHAKE_RESULT, authMethods: [] }));
    await initialized;
    const newSession = client.sessionNew({ cwd, mcpServers: [] });
    const assertion = expectAcpError(newSession, 'agent-error');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('short-circuits to auth-required on a matching stderr line without waiting for the timeout', async () => {
    const initialized = client.initialize();
    transport.agentMessage(response(1, HANDSHAKE_RESULT));
    await initialized;
    const newSession = client.sessionNew({ cwd, mcpServers: [] });
    transport.emitStderrLine('[codebuddy] please login first (401 unauthorized)');
    const err = await expectAcpError(newSession, 'auth-required');
    expect(err.message).toContain('login');
  });

  it('rejects a response without sessionId as protocol-mismatch', async () => {
    const newSession = client.sessionNew({ cwd, mcpServers: [] });
    transport.agentMessage(response(1, { modes: {} }));
    await expectAcpError(newSession, 'protocol-mismatch');
  });

  it('does not short-circuit on stderr while no session/new is pending', async () => {
    const initialized = client.initialize();
    transport.agentMessage(response(1, HANDSHAKE_RESULT));
    await initialized;
    transport.emitStderrLine('warning: token expired');
    const auth = client.authenticate('iOA');
    transport.agentMessage(response(2, {}));
    await expect(auth).resolves.toBeUndefined();
  });
});

describe('capability helpers', () => {
  const handshake = (overrides: Partial<AcpHandshake> = {}): AcpHandshake => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, raw: {} },
    authMethods: [{ id: 'iOA', name: 'Login with iOA' }],
    agentInfo: null,
    ...overrides,
  });

  it('buildAcpCapabilities fills the stable view with 0.9.0 constants', () => {
    const caps = buildAcpCapabilities('codebuddy', handshake());
    expect(caps).toEqual({
      provider: 'codebuddy',
      protocolVersion: 1,
      streaming: true,
      toolCalls: true,
      permissionRequests: true,
      loadSession: true,
      midTurnInject: false,
      inquiry: false,
      authMethods: [{ id: 'iOA', name: 'Login with iOA' }],
    });
  });

  it('buildAcpCapabilities reflects loadSession=false and applies overrides', () => {
    const caps = buildAcpCapabilities(
      'opencode',
      handshake({ agentCapabilities: { loadSession: false, raw: null } }),
      { toolCalls: false },
    );
    expect(caps.loadSession).toBe(false);
    expect(caps.toolCalls).toBe(false);
    expect(caps.permissionRequests).toBe(true);
  });

  it('selectAllowOption prefers allow_once over allow_always', () => {
    const allowAlways = { optionId: 'allow_always', name: 'Always', kind: 'allow_always' as const };
    const allowOnce = { optionId: 'allow', name: 'Once', kind: 'allow_once' as const };
    const rejectOnce = { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const };
    expect(selectAllowOption([allowAlways, allowOnce, rejectOnce])).toBe(allowOnce);
    expect(selectAllowOption([rejectOnce, allowAlways])).toBe(allowAlways);
    expect(selectAllowOption([rejectOnce])).toBeUndefined();
    expect(selectAllowOption([])).toBeUndefined();
  });

  it('selectRejectOption prefers reject_once over reject_always', () => {
    const rejectAlways = { optionId: 'ra', name: 'RA', kind: 'reject_always' as const };
    const rejectOnce = { optionId: 'r', name: 'R', kind: 'reject_once' as const };
    const allowOnce = { optionId: 'a', name: 'A', kind: 'allow_once' as const };
    expect(selectRejectOption([rejectAlways, rejectOnce, allowOnce])).toBe(rejectOnce);
    expect(selectRejectOption([allowOnce, rejectAlways])).toBe(rejectAlways);
    expect(selectRejectOption([allowOnce])).toBeUndefined();
  });
});
