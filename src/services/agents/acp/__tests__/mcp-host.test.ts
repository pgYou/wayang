/** Host side of the ACP MCP bridge: real Unix socket round trips. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { createMockLogger } from '@/__tests__/helpers';
import { generateMcpToken, mcpSocketPathFor, startMcpHost, startStdioMcpTransport, type McpHost } from '../mcp-transport';
import { createWayangMcpToolInvoker } from '../mcp-tools';
import { MAX_PROGRESS_CHARS, MCP_PROTOCOL_VERSION, MCP_TOOLS } from '../mcp-schemas';

class TestClient {
  private buffer = '';
  private readonly waiters = new Map<string | number, (value: any) => void>();

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        const waiter = this.waiters.get(frame.id);
        if (waiter) {
          this.waiters.delete(frame.id);
          waiter(frame);
        }
      }
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  request(id: number, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
    });
  }

  close(): void { this.socket.destroy(); }
}

describe('ACP MCP host (Unix socket)', () => {
  let tempDir: string;
  let socketPath: string;
  let host: McpHost | null = null;
  let token: string;
  let onProgress: any;
  let ask: any;
  let clients: TestClient[];

  const openClient = async (helloToken = token, helloWorkerId = 'w1'): Promise<TestClient> => {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const client = new TestClient(socket);
    client.send({ jsonrpc: '2.0', method: 'hello', params: { token: helloToken, workerId: helloWorkerId, pid: 999999 } });
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-mcp-host-'));
    socketPath = mcpSocketPathFor(tempDir, 'w1', 'unit');
    token = generateMcpToken();
    onProgress = vi.fn();
    ask = vi.fn(async () => '[Controller] do it this way');
    clients = [];
    host = await startMcpHost({
      socketPath,
      token,
      workerId: 'w1',
      invoker: createWayangMcpToolInvoker({
        workerId: 'w1',
        logger: createMockLogger(),
        onProgress,
        ask,
        progressTimeoutMs: 40,
        askTimeoutMs: 40,
      }),
      logger: createMockLogger(),
      handshakeTimeoutMs: 5_000,
    });
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    if (host) await host.close();
    host = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a 0700 directory and a 0600 socket', () => {
    expect(statSync(join(tempDir, '.mcp')).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('answers initialize with a STRING protocolVersion and tools capability', async () => {
    const client = await openClient();
    const response = await client.request(1, 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION });
    expect(typeof response.result.protocolVersion).toBe('string');
    expect(response.result.capabilities.tools).toBeDefined();
    expect(response.result.serverInfo.name).toBe('wayang');
    await expect(host!.ready).resolves.toBe(true);
  });

  it('tools/list returns exactly update_progress and ask_controller with their schemas', async () => {
    const client = await openClient();
    const response = await client.request(2, 'tools/list');
    expect(response.result.tools).toEqual(MCP_TOOLS);
    expect(response.result.tools.map((t: { name: string }) => t.name)).toEqual(['update_progress', 'ask_controller']);
    const progress = response.result.tools[0];
    expect(progress.inputSchema.required).toEqual(['message']);
    expect(Object.keys(progress.inputSchema.properties)).toEqual(['message']);
    expect(progress.inputSchema.properties.message.maxLength).toBe(MAX_PROGRESS_CHARS);
    const inquiry = response.result.tools[1];
    expect(inquiry.inputSchema.required).toEqual(['question']);
    expect(inquiry.inputSchema.properties.question.maxLength).toBe(500);
    expect(inquiry.inputSchema.properties.context.maxLength).toBe(1000);
  });

  it('routes update_progress to onProgress(message) and ask_controller to ask(q,c)', async () => {
    const client = await openClient();
    const progress = await client.request(3, 'tools/call', { name: 'update_progress', arguments: { message: 'half way' } });
    expect(onProgress).toHaveBeenCalledWith('half way');
    expect(progress.result.content[0].text).toBe('Progress reported: half way');
    expect(progress.result.isError).toBeUndefined();

    const answer = await client.request(4, 'tools/call', { name: 'ask_controller', arguments: { question: 'q?', context: 'tried x' } });
    expect(ask).toHaveBeenCalledWith('q?', 'tried x');
    expect(answer.result.content[0].text).toBe('[Controller] do it this way');
  });

  it('caps a 25k message at 20000 characters with an explicit marker', async () => {
    const client = await openClient();
    await client.request(5, 'tools/call', { name: 'update_progress', arguments: { message: 'x'.repeat(25_000) } });
    const reported = onProgress.mock.calls[0][0] as string;
    expect(reported.length).toBeLessThanOrEqual(MAX_PROGRESS_CHARS + 20);
    expect(reported).toContain('…[truncated]');
  });

  it('unknown methods get -32601 and notifications get no reply', async () => {
    const client = await openClient();
    const response = await client.request(6, 'resources/list');
    expect(response.error.code).toBe(-32601);
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const next = await client.request(7, 'ping');
    expect(next.result).toEqual({});
  });

  it('rejects a wrong token and never invokes a tool', async () => {
    const client = await openClient('not-the-token');
    const response = await Promise.race([
      client.request(8, 'tools/call', { name: 'update_progress', arguments: { message: 'nope' } }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 150)),
    ]);
    expect(response).toBe('timeout');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('times out a stalled progress/ask call with isError text', async () => {
    onProgress.mockImplementationOnce(() => new Promise<void>(() => undefined));
    ask.mockImplementationOnce(() => new Promise<string>(() => undefined));
    const client = await openClient();
    const progress = await client.request(9, 'tools/call', { name: 'update_progress', arguments: { message: 'stalled' } });
    expect(progress.result.isError).toBe(true);
    expect(progress.result.content[0].text).toContain('[TIMEOUT]');
    const answer = await client.request(10, 'tools/call', { name: 'ask_controller', arguments: { question: 'stalled?' } });
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toContain('[TIMEOUT]');
  });

  it('startStdioMcpTransport owns spawn/socket/token details behind McpTransport', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'acp-mcp-facade-'));
    const transport = await startStdioMcpTransport({
      sessionDir: otherDir,
      workerId: 'w2',
      invoker: createWayangMcpToolInvoker({ workerId: 'w2', logger: createMockLogger(), onProgress, ask }),
      logger: createMockLogger(),
    });
    expect(transport.descriptor.name).toBe('wayang');
    expect(transport.descriptor.env?.map((e) => e.name)).toEqual([
      'WAYANG_MCP_SOCK', 'WAYANG_MCP_TOKEN', 'WAYANG_MCP_WORKER_ID',
    ]);
    const sockPath = transport.descriptor.env?.find((e) => e.name === 'WAYANG_MCP_SOCK')?.value ?? '';
    expect(existsSync(sockPath)).toBe(true);
    await transport.close();
    expect(existsSync(sockPath)).toBe(false);
    rmSync(otherDir, { recursive: true, force: true });
  });

  it('close settles pending calls with [ABORTED] and removes the socket', async () => {
    ask.mockImplementationOnce(() => new Promise<string>(() => undefined));
    const client = await openClient();
    const inFlight = client.request(11, 'tools/call', { name: 'ask_controller', arguments: { question: 'pending?' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host!.close();
    const response = await inFlight;
    expect(response.result.content[0].text).toContain('[ABORTED]');
    expect(existsSync(socketPath)).toBe(false);
    host = null;
  });
});
