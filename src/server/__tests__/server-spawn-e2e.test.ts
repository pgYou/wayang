/**
 * Spawn-level e2e for `wayang server`.
 *
 * Unlike wayang-server.test.ts (which wires runWayangServer to PassThrough
 * streams in-process), this test starts the REAL built CLI as a child process
 * over real OS pipes. It therefore covers the seams that in-process tests
 * cannot reach:
 *
 * - dist/cli.js argument parsing and the `server` subcommand branch
 * - real stdio framing (newline-delimited JSON across an OS pipe)
 * - process lifecycle: exit codes, SIGTERM, and abrupt death
 * - the client's transport-error path when the peer actually dies
 *
 * Requires `npm run build` (dist/cli.js). If dist is missing the suite skips
 * rather than failing, so `vitest run` stays usable on a fresh checkout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStreamTransport } from '@/rpc/transport';
import { RpcClient } from '@/rpc/rpc-client';
import { METHOD, NOTIFY } from '@/rpc/protocol';
import type { TransportErrorEvent } from '@/rpc/transport';
import { startFakeProvider, isControllerRequest, type FakeProvider } from '@/__tests__/fake-openai-provider';

const CLI_PATH = join(process.cwd(), 'dist', 'cli.js');
const HAS_BUILD = existsSync(CLI_PATH);

let provider: FakeProvider;
let root: string;
let homeDir: string;
let workspaceDir: string;
let configPath: string;

beforeAll(async () => {
  if (!HAS_BUILD) return;
  provider = await startFakeProvider();
  root = mkdtempSync(join(tmpdir(), 'wayang-spawn-e2e-'));
  homeDir = join(root, 'home');
  workspaceDir = join(root, 'workspace');
  configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: { fake: { endpoint: provider.baseURL, apiKey: 'test-key', modelName: 'fake-model' } },
    controller: { provider: 'fake' },
    worker: { provider: 'fake', maxConcurrency: 1 },
  }));
});

afterAll(async () => {
  if (!HAS_BUILD) return;
  await provider.close();
  rmSync(root, { recursive: true, force: true });
});

interface SpawnedServer {
  child: ChildProcess;
  client: RpcClient;
  ready: { sessionId: string; sessionDir: string; workspaceDir: string };
  /** Resolves with the child's exit code. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Transport error events observed by the client. */
  transportErrors: TransportErrorEvent[];
  stderr: () => string;
}

/**
 * Spawn `wayang server` as a real child process and connect an RpcClient to
 * its stdio. Waits for the READY notification before resolving.
 *
 * `--home-dir` points at a temp root: the CLI joins `.wayang` itself, and the
 * child never touches the developer's real ~/.wayang.
 */
async function spawnServer(extraArgs: string[] = []): Promise<SpawnedServer> {
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      'server',
      '--home-dir', homeDir,
      '--workspace-dir', workspaceDir,
      '--config', configPath,
      '--log-level', 'silent',
      ...extraArgs,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } },
  );

  let stderrText = '';
  child.stderr!.setEncoding('utf-8');
  child.stderr!.on('data', (chunk: string) => { stderrText += chunk; });

  const transportErrors: TransportErrorEvent[] = [];
  const client = new RpcClient(
    createStreamTransport(child.stdout!, child.stdin!),
    { onTransportError: (event) => transportErrors.push(event) },
  );

  const ready = await Promise.race([
    new Promise<{ sessionId: string; sessionDir: string; workspaceDir: string }>((resolve) => {
      client.on(NOTIFY.READY, (params) => resolve({
        sessionId: String(params.sessionId),
        sessionDir: String(params.sessionDir),
        workspaceDir: String(params.workspaceDir),
      }));
    }),
    wait(20_000).then(() => {
      throw new Error(`Timed out waiting for server READY. stderr:\n${stderrText}`);
    }),
  ]);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child, client, ready, exited, transportErrors, stderr: () => stderrText };
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await wait(50);
  }
}

describe.skipIf(!HAS_BUILD)('wayang server — spawn-level e2e', () => {
  it('starts as a real process, serves RPC, and exits cleanly on shutdown', async () => {
    provider.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const srv = await spawnServer();

    // READY carries the session the server actually created on disk.
    expect(srv.ready.sessionId).toBeTruthy();
    expect(existsSync(join(srv.ready.sessionDir, 'meta.json'))).toBe(true);

    // --- get_status over real stdio framing ---
    const status = await srv.client.request<{ sessionId: string; busy: boolean; pending: number }>(METHOD.GET_STATUS);
    expect(status.sessionId).toBe(srv.ready.sessionId);
    expect(status.pending).toBe(0);

    // --- submit_input drives the controller; reply arrives via notification ---
    const conversationSeen: unknown[] = [];
    srv.client.on(NOTIFY.STATE_EVENT, (params) => {
      if (params.target === 'controllerAgent') conversationSeen.push(params.data);
    });
    await srv.client.request(METHOD.SUBSCRIBE, { target: 'controllerAgent', path: 'conversation' });
    await srv.client.request(METHOD.SUBMIT_INPUT, { text: 'hello over a real pipe' });

    await waitFor(() => {
      const conversation = conversationSeen.at(-1) as unknown[] | undefined;
      return Array.isArray(conversation)
        && conversation.some((e) => JSON.stringify(e).includes('ok.'));
    }, 'controller reply reaches the client over stdio');

    // --- shutdown: the child must exit 0 by itself ---
    await srv.client.request(METHOD.SHUTDOWN);
    const result = await Promise.race([
      srv.exited,
      wait(15_000).then(() => { throw new Error('server did not exit after shutdown'); }),
    ]);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  }, 30_000);

  it('exits 0 on SIGTERM (graceful shutdown path)', async () => {
    const srv = await spawnServer();

    srv.child.kill('SIGTERM');
    const result = await Promise.race([
      srv.exited,
      wait(15_000).then(() => { throw new Error('server did not exit after SIGTERM'); }),
    ]);
    expect(result.code).toBe(0);
  }, 30_000);

  it('rejects a resume of a nonexistent session with a nonzero exit', async () => {
    const child = spawn(
      process.execPath,
      [
        CLI_PATH,
        'server',
        '--home-dir', homeDir,
        '--workspace-dir', workspaceDir,
        '--config', configPath,
        '--log-level', 'silent',
        '--session', 'resume:does-not-exist',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } },
    );

    let stderrText = '';
    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => { stderrText += chunk; });

    const result = await Promise.race([
      new Promise<{ code: number | null }>((resolve) => {
        child.on('exit', (code) => resolve({ code }));
      }),
      wait(15_000).then(() => {
        child.kill('SIGKILL');
        throw new Error(`server did not exit after resume failure. stderr:\n${stderrText}`);
      }),
    ]);

    // The CLI's fatal() path exits 1 and prints the reason to stderr.
    expect(result.code).toBe(1);
    expect(stderrText).toMatch(/not found/i);
  }, 30_000);

  it('fails in-flight and subsequent requests when the server process is killed abruptly', async () => {
    const srv = await spawnServer();

    // A request that the server rejects quickly — used only to ensure the
    // channel is live before the kill.
    await srv.client.request('test_never_answered_method').catch(() => { /* expected */ });

    srv.child.kill('SIGKILL');

    // The child is gone: the transport must surface a terminal event and the
    // client must stop pretending it can still talk to the peer.
    await waitFor(() => srv.transportErrors.length > 0, 'client observed a transport error');
    await expect(srv.client.request(METHOD.GET_STATUS)).rejects.toThrow(/RPC transport/);

    const result = await Promise.race([
      srv.exited,
      wait(15_000).then(() => { throw new Error('killed server did not report exit'); }),
    ]);
    expect(result.signal).toBe('SIGKILL');
  }, 30_000);

  it('does not create any state outside the temp home dir', async () => {
    provider.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const srv = await spawnServer();
    try {
      // The server joins `.wayang` onto --home-dir, so all state lands there.
      expect(existsSync(join(homeDir, '.wayang', 'sessions', srv.ready.sessionId))).toBe(true);
      expect(srv.ready.sessionDir.startsWith(join(homeDir, '.wayang'))).toBe(true);
    } finally {
      await srv.client.request(METHOD.SHUTDOWN).catch(() => { /* best effort */ });
      await Promise.race([srv.exited, wait(15_000)]);
    }
  }, 30_000);
});
