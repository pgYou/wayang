/**
 * Bridge side of the ACP MCP injection. The TypeScript entry is bundled with
 * esbuild into a temp .mjs and driven as a real child process over stdio —
 * the same shape the ACP agent sees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { build } from 'esbuild';
import { MAX_PROGRESS_CHARS, MCP_PROTOCOL_VERSION } from '../mcp-schemas';

class BridgeProcess {
  private stdout = '';
  private stderr = '';
  private waiters: Array<() => void> = [];
  private exitPromise: Promise<number | null>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.stdout += chunk;
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    this.exitPromise = new Promise((done) => child.on('close', (code) => done(code)));
  }

  write(raw: string): void { this.child.stdin.write(raw); }
  end(): void { this.child.stdin.end(); }

  frames(): any[] {
    return this.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  }

  async waitForFrames(count: number, timeoutMs = 4_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frames = this.stdout.split('\n').filter((line) => line.trim());
      if (frames.length >= count) return this.frames();
      if (Date.now() > deadline) throw new Error(`expected ${count} frames, got ${frames.length}; stderr: ${this.stderr}`);
      await Promise.race([
        new Promise<void>((done) => this.waiters.push(done)),
        new Promise<void>((done) => setTimeout(done, 20)),
      ]);
    }
  }

  get stderrText(): string { return this.stderr; }
  exit(): Promise<number | null> { return this.exitPromise; }
  kill(): void { this.child.kill('SIGKILL'); }
}

describe('ACP MCP bridge entry (stdio NDJSON)', () => {
  let tempDir: string;
  let entry: string;
  let children: BridgeProcess[] = [];
  let servers: Server[] = [];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-mcp-bridge-'));
    entry = join(tempDir, 'bridge.mjs');
    await build({
      entryPoints: [resolve('src/services/agents/acp/mcp-bridge-entry.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
    });
    children = [];
    servers = [];
  });

  afterEach(async () => {
    for (const child of children) child.kill();
    for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  const spawnBridge = (env: Record<string, string> = {}): BridgeProcess => {
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        WAYANG_MCP_SOCK: '',
        WAYANG_MCP_TOKEN: '',
        WAYANG_MCP_WORKER_ID: '',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const bridge = new BridgeProcess(child);
    children.push(bridge);
    return bridge;
  };

  it('answers initialize and tools/list standalone; stdout carries protocol frames only', async () => {
    const bridge = spawnBridge();
    bridge.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } })}\n`);
    bridge.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    bridge.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const frames = await bridge.waitForFrames(2);
    expect(frames).toHaveLength(2);
    expect(typeof frames[0].result.protocolVersion).toBe('string');
    expect(frames[0].result.capabilities.tools).toEqual({});
    expect(frames[1].result.tools.map((t: { name: string }) => t.name)).toEqual(['update_progress', 'ask_controller']);
    expect(Object.keys(frames[1].result.tools[0].inputSchema.properties)).toEqual(['message']);
    expect(frames[1].result.tools[0].inputSchema.properties.message.maxLength).toBe(MAX_PROGRESS_CHARS);
    for (const line of bridge.frames()) expect(JSON.stringify(line)).not.toContain('[wayang-mcp-bridge]');
    bridge.end();
    await expect(bridge.exit()).resolves.toBe(0);
  });

  it('handles coalesced and split NDJSON frames and unknown methods', async () => {
    const bridge = spawnBridge();
    const init = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize' });
    const unknown = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
    bridge.write(`${init}\n${unknown}\n`);
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' });
    bridge.write(ping.slice(0, 12));
    bridge.write(`${ping.slice(12)}\n`);
    const frames = await bridge.waitForFrames(3);
    expect(frames.map((f) => f.id)).toEqual([7, 8, 9]);
    expect(frames[1].error.code).toBe(-32601);
    expect(frames[2].result).toEqual({});
    bridge.end();
  });

  it('a standalone tools/call returns isError instead of hanging', async () => {
    const bridge = spawnBridge();
    bridge.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_progress', arguments: { message: 'hi' } } })}\n`);
    const frames = await bridge.waitForFrames(1);
    expect(frames[0].result.isError).toBe(true);
    expect(frames[0].result.content[0].text).toContain('[UNAVAILABLE]');
    bridge.end();
    await expect(bridge.exit()).resolves.toBe(0);
  });

  it('sends hello FIRST and relays requests/responses by JSON-RPC id', async () => {
    const socketPath = join(tempDir, 'host.sock');
    const hellos: any[] = [];
    const forwarded: any[] = [];
    const server = createServer((socket: Socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (hellos.length === 0) {
            hellos.push(frame);
            continue;
          }
          forwarded.push(frame);
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: `host:${frame.id}` }] } })}\n`);
        }
      });
    });
    await new Promise<void>((done) => server.listen(socketPath, done));
    servers.push(server);

    const bridge = spawnBridge({
      WAYANG_MCP_SOCK: socketPath,
      WAYANG_MCP_TOKEN: 'secret-token',
      WAYANG_MCP_WORKER_ID: 'aw-1',
    });
    // Sent BEFORE the socket connects: the bridge buffers it until hello.
    bridge.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'ask_controller', arguments: { question: 'q?' } } })}\n`);
    const frames = await bridge.waitForFrames(1);
    expect(hellos).toHaveLength(1);
    expect(hellos[0].method).toBe('hello');
    expect(hellos[0].params.token).toBe('secret-token');
    expect(hellos[0].params.workerId).toBe('aw-1');
    expect(hellos[0].params.pid).toBeGreaterThan(0);
    expect(forwarded.map((f) => f.id)).toEqual([42]);
    expect(frames[0].id).toBe(42);
    expect(frames[0].result.content[0].text).toBe('host:42');
    bridge.end();
    await expect(bridge.exit()).resolves.toBe(0);
  });

  it('exits cleanly on stdin EOF and on host EOF', async () => {
    const standalone = spawnBridge();
    standalone.end();
    await expect(standalone.exit()).resolves.toBe(0);

    const socketPath = join(tempDir, 'eof.sock');
    const server = createServer((socket: Socket) => {
      socket.on('data', () => socket.end());
    });
    await new Promise<void>((done) => server.listen(socketPath, done));
    servers.push(server);
    const connected = spawnBridge({ WAYANG_MCP_SOCK: socketPath, WAYANG_MCP_TOKEN: 't', WAYANG_MCP_WORKER_ID: 'w' });
    connected.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
    await expect(connected.exit()).resolves.toBe(0);
    expect(existsSync(socketPath)).toBe(true); // host server still owns the file
  });
});
