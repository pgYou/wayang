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

function sendText(worker: TestAcpWorker, text: string): void {
  worker.transport.agentMessage({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } } },
  });
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

  it('fail-soft: -32602 retries ONCE with [], degrades and keeps the 500ms debounce', async () => {
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
    sendText(worker, 'degraded progress text');
    await sleep(600);
    expect(onProgress).toHaveBeenCalledWith('degraded progress text');
    respondTo(worker.transport, 3, { stopReason: 'end_turn' });
    await runPromise;
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
