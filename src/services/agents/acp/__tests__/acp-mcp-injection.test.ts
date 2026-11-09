/** Worker-level MCP injection, fail-soft degradation and progress routing. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail, WorkerConfig } from '@/types/index';
import type { IWorkerInstance } from '@/types/worker';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx, createMockLogger } from '@/__tests__/helpers';
import type { AcpLaunchConfig } from '@/services/acp/config';
import type { AcpTransport } from '@/services/acp/transport';
import { AcpWorkerRun } from '../acp-worker-run';
import {
  authAttributingReadiness,
  type AcpReadiness,
  type AcpReadyContext,
  type AcpWorkerEnvView,
} from '../base-acp-worker';
import { buildMcpServerDescriptor, type McpTransport, type StartMcpTransportOptions } from '../mcp-transport';
import { FakeAgentTransport } from './fake-agent-transport';

const skills = new SkillRegistry([]);
const HANDSHAKE = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] as Array<{ id: string; name: string }> };
const TASK: TaskDetail & { workerId: string } = {
  id: 'task-mcp', title: 'MCP', description: 'do the thing', priority: 'normal', status: 'pending',
  createdAt: Date.now(), workerId: 'w-mcp', executionTurnId: 'turn-mcp',
};

class TestAcpWorker extends AcpWorkerRun implements IWorkerInstance {
  readonly transport = new FakeAgentTransport();
  readonly testLogger: any;
  transportOpts: StartMcpTransportOptions | null = null;
  transportCloseCalls = 0;

  constructor(sessionDir: string, config: Partial<WorkerConfig> = {}) {
    const logger: any = createMockLogger();
    super(
      { type: 'codebuddy', description: 'test acp worker', ...config } as WorkerConfig,
      sessionDir, sessionDir,
      createMockCtx({ sessionDir, workspaceDir: sessionDir, logger } as any),
      skills,
    );
    this.testLogger = logger;
  }

  protected createMcpTransport(opts: StartMcpTransportOptions): Promise<McpTransport> {
    this.transportOpts = opts;
    const descriptor = buildMcpServerDescriptor({
      socketPath: '/tmp/fake-acp-mcp.sock', token: 'one-shot-token', workerId: 'w-mcp',
      bridgeEntryPath: '/dist/mcp-bridge-entry.js',
    });
    return Promise.resolve({
      descriptor,
      ready: Promise.resolve(true),
      isReady: () => true,
      close: async () => { this.transportCloseCalls += 1; },
    });
  }
  protected createTransport(_config: AcpLaunchConfig): AcpTransport { return this.transport; }
  protected buildLaunch(view: AcpWorkerEnvView): AcpLaunchConfig {
    return { command: 'node', args: [], env: view.env, cwd: view.cwd, timeouts: view.timeouts };
  }
  protected isReady(ctx: AcpReadyContext): AcpReadiness {
    return authAttributingReadiness(ctx, { provider: this.config.type, command: 'node' });
  }
  get mcpAvailable(): boolean { return this._mcpAvailable; }
}

function respondTo(transport: FakeAgentTransport, index: number, result: unknown): void {
  const request = transport.clientMessages[index] as { id: number | string };
  transport.agentMessage({ jsonrpc: '2.0', id: request.id, result });
}

function respondErrorTo(transport: FakeAgentTransport, index: number, code: number, message: string): void {
  const request = transport.clientMessages[index] as { id: number | string };
  transport.agentMessage({ jsonrpc: '2.0', id: request.id, error: { code, message } });
}

/** Start the run WITHOUT awaiting it; `ready` resolves once session/new is out. */
function startRun(worker: TestAcpWorker, onProgress?: (msg: string) => void): { runPromise: Promise<any>; ready: Promise<void> } {
  const runPromise = worker.run(TASK, {}, onProgress);
  const ready = (async () => {
    await worker.transport.waitForClientOutput(1);
    respondTo(worker.transport, 0, HANDSHAKE);
    await worker.transport.waitForClientOutput(2);
  })();
  return { runPromise, ready };
}

/** messageId null → the chunk carries NO messageId field (bare chunk, knot shape). */
function sendText(worker: TestAcpWorker, text: string, messageId: string | null = 'm1'): void {
  worker.transport.agentMessage({
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: 's-1',
      update: { sessionUpdate: 'agent_message_chunk', ...(messageId !== null && { messageId }), content: { type: 'text', text } },
    },
  });
}

/** A tool_call (first snapshot — the mapper ignores it, the run still seals). */
function sendToolCall(worker: TestAcpWorker, toolCallId: string): void {
  worker.transport.agentMessage({
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: 's-1',
      update: { sessionUpdate: 'tool_call', toolCallId, title: 'Bash', kind: 'other', status: 'in_progress', rawInput: {} },
    },
  });
}

/**
 * Open a session on the DEGRADED path (session/new with mcpServers fails with
 * -32602 and the single [] retry succeeds). Client messages are then:
 * 0 initialize, 1 session/new(mcp), 2 session/new([]), 3 session/prompt.
 */
async function openDegradedSession(
  worker: TestAcpWorker,
  onProgress?: (msg: string) => void,
): Promise<{ runPromise: Promise<any>; promptIndex: number }> {
  const { runPromise, ready } = startRun(worker, onProgress);
  await ready;
  respondErrorTo(worker.transport, 1, -32602, 'mcpServers not supported');
  await worker.transport.waitForClientOutput(3);
  respondTo(worker.transport, 2, { sessionId: 's-1' });
  await worker.transport.waitForClientOutput(4);
  return { runPromise, promptIndex: 3 };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('AcpWorkerRun: MCP injection', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'acp-mcp-inject-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('injects one ACP v1 stdio descriptor (env as {name,value}[])', async () => {
    const worker = new TestAcpWorker(tempDir);
    const { runPromise, ready } = startRun(worker);
    await ready;
    const servers = worker.transport.clientMessages[1].params.mcpServers;
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('wayang');
    expect(servers[0].command).toBe(process.execPath);
    expect(servers[0].args).toHaveLength(1);
    expect(servers[0].args[0]).toContain('mcp-bridge-entry');
    expect(Array.isArray(servers[0].env)).toBe(true);
    expect(servers[0].env.map((e: { name: string }) => e.name)).toEqual([
      'WAYANG_MCP_SOCK', 'WAYANG_MCP_TOKEN', 'WAYANG_MCP_WORKER_ID',
    ]);
    for (const entry of servers[0].env) expect(typeof entry.value).toBe('string');

    respondTo(worker.transport, 1, { sessionId: 's-1' });
    await worker.transport.waitForClientOutput(3);
    respondTo(worker.transport, 2, { stopReason: 'end_turn' });
    await expect(runPromise).resolves.toMatchObject({ status: 'completed' });
    expect(worker.transportOpts).not.toBeNull();
    expect(worker.transportCloseCalls).toBe(1);
  });

  it('fail-soft: -32602 retries ONCE with [], degrades and reports the closed message at turn end', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir);
    const { runPromise, ready } = startRun(worker, onProgress);
    await ready;
    respondErrorTo(worker.transport, 1, -32602, 'mcpServers not supported');
    await worker.transport.waitForClientOutput(3);
    expect(worker.transport.clientMessages[2].params.mcpServers).toEqual([]);
    expect(worker.mcpAvailable).toBe(false);
    expect(worker.transportCloseCalls).toBeGreaterThanOrEqual(1);
    const warnings = worker.testLogger.warn.mock.calls.filter((call: any[]) => String(call[1] ?? '').includes('degraded'));
    expect(warnings).toHaveLength(1);

    respondTo(worker.transport, 2, { sessionId: 's-1' });
    await worker.transport.waitForClientOutput(4);
    // Chunks of one message are joined; nothing is emitted per chunk.
    sendText(worker, 'degraded ');
    sendText(worker, 'progress text');
    await sleep(300);
    expect(onProgress).not.toHaveBeenCalled();
    respondTo(worker.transport, 3, { stopReason: 'end_turn' });
    await runPromise;
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('degraded progress text');
  });

  it('auth-required during session/new is NOT retried', async () => {
    const worker = new TestAcpWorker(tempDir);
    const { runPromise, ready } = startRun(worker);
    await ready;
    worker.transport.emitStderrLine('Error: please login first (401 unauthorized)');
    const result = await runPromise;
    expect(result.status).toBe('failed');
    const sessionNews = worker.transport.clientMessages.filter((m: any) => m.method === 'session/new');
    expect(sessionNews).toHaveLength(1);
  });

  it('mcp.enabled=false injects nothing', async () => {
    const worker = new TestAcpWorker(tempDir, { mcp: { enabled: false } } as Partial<WorkerConfig>);
    const { runPromise, ready } = startRun(worker);
    await ready;
    expect(worker.transport.clientMessages[1].params.mcpServers).toEqual([]);
    expect(worker.mcpAvailable).toBe(false);
    respondTo(worker.transport, 1, { sessionId: 's-1' });
    await worker.transport.waitForClientOutput(3);
    respondTo(worker.transport, 2, { stopReason: 'end_turn' });
    await runPromise;
  });

  it('falls back to the latest complete reply after the idle window (no summary)', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 100 } } as Partial<WorkerConfig>);
    const { runPromise, ready } = startRun(worker, onProgress);
    await ready;
    respondTo(worker.transport, 1, { sessionId: 's-1' });
    await worker.transport.waitForClientOutput(3);

    sendText(worker, 'the latest complete reply');
    // A tool_call seals the reply without resetting the idle clock.
    worker.transport.agentMessage({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 's-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Bash', kind: 'other', status: 'in_progress', rawInput: {} } },
    });
    await sleep(280);
    expect(onProgress).toHaveBeenCalledWith('the latest complete reply');
    respondTo(worker.transport, 2, { stopReason: 'end_turn' });
    await runPromise;
  });

  it('MCP available: update_progress is primary, session/update text is ignored', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir);
    const { runPromise, ready } = startRun(worker, onProgress);
    await ready;
    respondTo(worker.transport, 1, { sessionId: 's-1' });
    await worker.transport.waitForClientOutput(3);

    const progressResult = await worker.transportOpts!.invoker.invoke('update_progress', { message: 'real update_progress' });
    expect(progressResult.text).toBe('Progress reported: real update_progress');
    expect(onProgress).toHaveBeenCalledWith('real update_progress');
    sendText(worker, 'plain assistant text must not become progress');
    await sleep(600);
    expect(onProgress).toHaveBeenCalledTimes(1);

    const unavailable = await worker.transportOpts!.invoker.invoke('ask_controller', { question: 'blocked?', context: 'tried x' });
    expect(unavailable.text).toContain('[UNAVAILABLE]');
    worker.setInquirySupport(async () => '[Controller] go ahead');
    const answer = await worker.transportOpts!.invoker.invoke('ask_controller', { question: 'blocked?', context: 'tried x' });
    expect(answer.text).toBe('[Controller] go ahead');
    const inquiry = worker.getConversation().filter((e: any) => e.subtype === 'inquiry');
    expect(inquiry).toHaveLength(1);

    respondTo(worker.transport, 2, { stopReason: 'end_turn' });
    await runPromise;
  });
});

/**
 * Degraded progress is the turn's JOINED text, never the last fragment (#64):
 * segments come from the turn writer's own aggregation (closed by a new
 * messageId, a tool call or the turn end), the trigger is the idle window or
 * the turn-end catch-up, and the watermark keeps a real update_progress from
 * being repeated. knot's measured shape — messageId renewed MID-message, which
 * carved one reply into per-chunk fragments like 「串试试。」 — is the
 * regression case throughout.
 */
describe('AcpWorkerRun: degraded progress reports the turn text', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'acp-progress-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('streamed chunks of one message are announced once, joined, at turn end', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 5_000 } } as Partial<WorkerConfig>);
    const { runPromise, promptIndex } = await openDegradedSession(worker, onProgress);

    sendText(worker, '你');
    sendText(worker, '好');
    sendText(worker, '。');
    await sleep(300);
    expect(onProgress).not.toHaveBeenCalled();

    respondTo(worker.transport, promptIndex, { stopReason: 'end_turn' });
    await runPromise;
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('你好。');
  });

  it('knot shape: messageId renewed per chunk — the turn-end report is the joined reply, not the last fragment', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 5_000 } } as Partial<WorkerConfig>);
    const { runPromise, promptIndex } = await openDegradedSession(worker, onProgress);

    sendText(worker, '我会先查询 TAPD', 'k-1');
    sendText(worker, '，同时检索 iWiki', 'k-2'); // a new id closes k-1
    sendText(worker, '。两条线并行推进。', 'k-3'); // and closes k-2
    await sleep(300);
    expect(onProgress).not.toHaveBeenCalled();

    respondTo(worker.transport, promptIndex, { stopReason: 'end_turn' });
    await runPromise;
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('我会先查询 TAPD，同时检索 iWiki。两条线并行推进。');
  });

  it('knot shape: the idle window reports the sealed fragments joined, then only text produced after that', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 120 } } as Partial<WorkerConfig>);
    const { runPromise, promptIndex } = await openDegradedSession(worker, onProgress);

    // The incident (#64): 「串试试。」 was reported alone because it was the
    // LATEST sealed fragment when the window fired; k-3 keeps streaming.
    sendText(worker, '空字符', 'k-1');
    sendText(worker, '串试试。', 'k-2'); // closes k-1
    sendText(worker, '接下来', 'k-3');   // closes k-2, still open
    await sleep(300);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('空字符串试试。');

    // A later window reports only the fragments produced since — the joined
    // text already reported never comes back.
    sendText(worker, '收尾', 'k-4');      // closes k-3
    sendText(worker, 'workspace。', 'k-5'); // closes k-4
    await sleep(400);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith('接下来收尾');
    expect(onProgress.mock.calls[1][0]).not.toContain('串试试');

    respondTo(worker.transport, promptIndex, { stopReason: 'end_turn' });
    await runPromise;
    // The turn-end catch-up closes k-5's open text and reports it.
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith('workspace。');
  });

  it('a half message (bare chunks, no close) is never a window candidate, but the turn end reports it', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 120 } } as Partial<WorkerConfig>);
    const { runPromise, promptIndex } = await openDegradedSession(worker, onProgress);

    sendText(worker, 'still typing', 'm1'); // one messageId, nothing closes it
    await sleep(400);
    expect(onProgress).not.toHaveBeenCalled();

    respondTo(worker.transport, promptIndex, { stopReason: 'end_turn' });
    await runPromise;
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('still typing');
  });

  it('no messageId at all: bare chunks accumulate and are reported joined at turn end', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 5_000 } } as Partial<WorkerConfig>);
    const { runPromise, promptIndex } = await openDegradedSession(worker, onProgress);

    sendText(worker, '计划：先查 TAPD', null);
    sendText(worker, '，再读 iWiki', null);
    sendToolCall(worker, 'tc-mid'); // a tool call closes the open segment
    sendText(worker, '。两边并行推进', null);
    await sleep(300);
    expect(onProgress).not.toHaveBeenCalled();

    respondTo(worker.transport, promptIndex, { stopReason: 'end_turn' });
    await runPromise;
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('计划：先查 TAPD，再读 iWiki。两边并行推进');
  });

  it('punctuation-only fragments (knot shape) are never progress', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 120 } } as Partial<WorkerConfig>);
    const { runPromise, promptIndex } = await openDegradedSession(worker, onProgress);

    sendText(worker, '。', 'k-1');
    sendText(worker, ' ……', 'k-2'); // closes k-1, punctuation only
    sendText(worker, '.', 'k-3');    // closes k-2, punctuation only
    await sleep(300);
    expect(onProgress).not.toHaveBeenCalled();

    respondTo(worker.transport, promptIndex, { stopReason: 'end_turn' });
    await runPromise;
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('nothing is announced after abort', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 100 } } as Partial<WorkerConfig>);
    const { runPromise, promptIndex } = await openDegradedSession(worker, onProgress);

    sendText(worker, 'partial sentence', 'm1');
    sendText(worker, '', 'm2');
    worker.abort();
    await worker.transport.waitForClientOutput(5);
    await sleep(300);
    expect(onProgress).not.toHaveBeenCalled();

    respondTo(worker.transport, promptIndex, { stopReason: 'cancelled' });
    await expect(runPromise).resolves.toMatchObject({ status: 'failed' });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('a real update_progress advances the watermark: covered text is not re-announced', async () => {
    const onProgress = vi.fn();
    const worker = new TestAcpWorker(tempDir, { mcp: { fallbackMs: 120 } } as Partial<WorkerConfig>);
    const { runPromise, ready } = startRun(worker, onProgress);
    await ready;
    respondTo(worker.transport, 1, { sessionId: 's-1' });
    await worker.transport.waitForClientOutput(3);

    // A message closes, then the agent itself reports progress (MCP channel).
    sendText(worker, 'covered by update_progress');
    sendToolCall(worker, 'tc-1');
    await sleep(20);
    await worker.transportOpts!.invoker.invoke('update_progress', { message: 'real update_progress' });
    expect(onProgress).toHaveBeenCalledWith('real update_progress');

    // Window expires: that message is stale (already reported) → silence.
    await sleep(300);
    expect(onProgress).toHaveBeenCalledTimes(1);

    // A message produced after the report is announced.
    sendText(worker, 'fresh reply', 'm2');
    sendToolCall(worker, 'tc-2');
    await sleep(250);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith('fresh reply');

    respondTo(worker.transport, 2, { stopReason: 'end_turn' });
    await runPromise;
  });
});
