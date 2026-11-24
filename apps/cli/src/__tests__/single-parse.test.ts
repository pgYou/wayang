// Single-parse assertion (monorepo-design 4.1 改造一): the CLI host resolves
// and validates the config ONCE; the server it hands the object to never
// re-parses, re-validates or re-reads it. The spy on the protocol barrel's
// `validateConfig` counts every validation in the process across the whole
// boot — host load plus server boot with a REAL Supervisor (the object's
// identity travelling into the supervisor is pinned by the core-side test
// src/server/__tests__/injected-config.test.ts).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

vi.mock('@wayang-ai/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wayang-ai/protocol')>();
  return { ...actual, validateConfig: vi.fn(actual.validateConfig) };
});

import { validateConfig } from '@wayang-ai/protocol';
import { loadConfig } from '@/config-loader';
import { runWayangServer } from '@wayang-ai/core/server/wayang-server';
import { RpcClient } from '@wayang-ai/protocol/rpc/rpc-client';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';

let root: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wayang-single-parse-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('single-parse flow: host loads once, server consumes the object', () => {
  it('loadConfig → runWayangServer: validation happens exactly once for the whole boot', async () => {
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      // Dead endpoint on purpose: no controller turn is driven here, so the
      // provider is never called — the assertion is about parsing, not LLM.
      providers: { fake: { endpoint: 'http://localhost:9/v1', apiKey: 'test-key', modelName: 'fake-model' } },
      controller: { provider: 'fake' },
      worker: { provider: 'fake', maxConcurrency: 1 },
    }));

    // --- Host side: THE single resolution + validation point. ---
    const config = await loadConfig(configPath, { nonInteractive: true });
    expect(vi.mocked(validateConfig)).toHaveBeenCalledTimes(1);

    // --- Server side: boots from the object, never re-parses. ---
    const serverIn = new PassThrough();
    const serverOut = new PassThrough();
    const client = new RpcClient(createStreamTransport(serverOut, serverIn));
    const readyPromise = new Promise<void>((resolve) => {
      client.on(NOTIFY.READY, () => resolve());
    });

    void runWayangServer(
      {
        config,
        dataDir: join(root, 'home'),
        workspaceDir: join(root, 'workspace'),
        session: { mode: 'new' },
        logLevel: 'silent',
      },
      { stdin: serverIn, stdout: serverOut },
    );

    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('server not ready')), 8_000)),
    ]);

    // The REAL Supervisor booted, the RPC layer is up — and the validation
    // count did not move: the server consumed the object as given. (Pre-4.1
    // the server re-loaded AND re-validated the config file: two parses.)
    expect(vi.mocked(validateConfig)).toHaveBeenCalledTimes(1);

    const status = await client.request<{ sessionId: string; busy: boolean }>(METHOD.GET_STATUS);
    expect(status.sessionId).toBeTruthy();
    expect(status.busy).toBe(false);

    await client.request(METHOD.SHUTDOWN).catch(() => { /* best effort */ });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('process.exit never called after shutdown')), 5_000);
      const poll = setInterval(() => {
        if (exitSpy.mock.calls.length > 0) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 25);
    });
    client.close();
  }, 15_000);
});
