import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runWayangServer } from '../wayang-server';
import { RpcClient } from '@/rpc/rpc-client';
import { createStreamTransport } from '@/rpc/transport';
import { METHOD, NOTIFY } from '@/rpc/protocol';
import { startFakeProvider, isControllerRequest, type FakeProvider } from '@/__tests__/fake-openai-provider';

/**
 * In-process integration: runWayangServer wired to a real Supervisor over
 * PassThrough streams, with the LLM served by the fake OpenAI provider.
 * No child processes involved — spawn-level behavior is covered by e2e.
 */

let provider: FakeProvider;
let homeDir: string;
let workspaceDir: string;
let configPath: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  provider = await startFakeProvider();
  const root = mkdtempSync(join(tmpdir(), 'wayang-server-test-'));
  homeDir = join(root, 'home');
  workspaceDir = join(root, 'workspace');
  configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: { fake: { endpoint: provider.baseURL, apiKey: 'test-key', modelName: 'fake-model' } },
    controller: { provider: 'fake' },
    worker: { provider: 'fake', maxConcurrency: 1 },
  }));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterAll(async () => {
  exitSpy.mockRestore();
  await provider.close();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(configPath, { force: true });
});

interface Booted {
  client: RpcClient;
  dispose: () => Promise<void>;
}

async function bootServer(): Promise<Booted> {
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const clientTransport = createStreamTransport(serverOut, serverIn);

  const client = new RpcClient(clientTransport);
  const readyPromise = new Promise<string>((resolve) => {
    client.on(NOTIFY.READY, (params) => resolve(String(params.sessionId)));
  });

  void runWayangServer(
    {
      configPath,
      homeDir,
      workspaceDir,
      session: { mode: 'new' },
      logLevel: 'silent',
    },
    { stdin: serverIn, stdout: serverOut },
  );

  const sessionId = await waitForValue(readyPromise, 'server ready');
  expect(sessionId).toBeTruthy();

  return {
    client,
    dispose: async () => {
      await client.request(METHOD.SHUTDOWN).catch(() => { /* best effort */ });
      await wait(100);
    },
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForValue<T>(promise: Promise<T>, what: string, timeoutMs = 8000): Promise<T> {
  return await Promise.race([
    promise,
    wait(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for: ${what}`);
    }),
  ]);
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await wait(50);
  }
}

describe('WayangServer over RPC', () => {
  it('boots, serves commands, streams subscription events, and shuts down', async () => {
    provider.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const { client, dispose } = await bootServer();

    try {
      // --- get_status ---
      const status = await client.request<{ sessionId: string; busy: boolean; pending: number }>(METHOD.GET_STATUS);
      expect(status.sessionId).toBeTruthy();
      expect(status.pending).toBe(0);

      // --- list_tasks / get_snapshot ---
      expect(await client.request(METHOD.LIST_TASKS)).toEqual([]);
      const snap = await client.request<{ data: unknown[] }>(METHOD.GET_SNAPSHOT, { target: 'engine', path: 'tasks.pending' });
      expect(snap.data).toEqual([]);

      // --- subscribe: initial snapshot then live events ---
      const signalsSeen: unknown[] = [];
      const conversationSeen: unknown[] = [];
      await client.request(METHOD.SUBSCRIBE, { target: 'signalQueue', path: 'signals' });
      await client.request(METHOD.SUBSCRIBE, { target: 'controllerAgent', path: 'conversation' });
      client.on(NOTIFY.STATE_EVENT, (params) => {
        if (params.target === 'signalQueue') signalsSeen.push(params.data);
        if (params.target === 'controllerAgent') conversationSeen.push(params.data);
      });

      // --- submit_input drives the controller (fake LLM replies 'ok.') ---
      await client.request(METHOD.SUBMIT_INPUT, { text: 'hello server' });

      await waitFor(() => {
        const conversation = conversationSeen.at(-1) as unknown[] | undefined;
        return Array.isArray(conversation)
          && conversation.some((e) => JSON.stringify(e).includes('ok.'));
      }, 'controller reply lands in conversation');

      const signals = signalsSeen.at(-1) as Array<{ type: string; payload?: { text?: string } }>;
      expect(signals.some((s) => s.type === 'input' && s.payload?.text === 'hello server')).toBe(true);

      // --- unknown method surfaces a proper error ---
      await expect(client.request('definitely_not_a_method')).rejects.toThrow(/Unknown method/);
    } finally {
      await dispose();
    }

    // --- shutdown asks the process to exit (mocked here) ---
    await waitFor(() => exitSpy.mock.calls.length > 0, 'process.exit called after shutdown');
  }, 15_000);

  it('rejects unknown subscribe targets and missing params', async () => {
    provider.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const { client, dispose } = await bootServer();
    try {
      await expect(client.request(METHOD.SUBSCRIBE, { target: 'nope', path: 'signals' }))
        .rejects.toThrow(/Unknown target/);
      await expect(client.request(METHOD.SUBSCRIBE, { target: 'engine' }))
        .rejects.toThrow(/Missing required string param: path/);
    } finally {
      await dispose();
    }
  }, 15_000);

  it('fails fast when resuming a nonexistent session', async () => {
    const serverIn = new PassThrough();
    const serverOut = new PassThrough();
    await expect(runWayangServer(
      { configPath, homeDir, workspaceDir, session: { mode: 'resume', sessionId: 'does-not-exist' }, logLevel: 'silent' },
      { stdin: serverIn, stdout: serverOut },
    )).rejects.toThrow(/not found/i);
  }, 10_000);
});
