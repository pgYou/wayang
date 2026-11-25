// Injection-only config run (monorepo-design 4.1 改造一验收): a WayangConfig
// constructed PURELY IN MEMORY drives a real Supervisor and the full RPC
// server — no config file anywhere, no WAYANG_* env fallback, and core never
// parses or validates the config itself. The env variables below are
// deliberately pointed at WRONG values: if core consulted any config source
// other than the injected object, the controller's traffic would land on the
// wrong endpoint (or the boot would fail outright).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

// Spy the protocol barrel's validator: the loader (apps/cli) is the ONLY
// place a config is parsed/validated. Any call here means core re-parsed.
vi.mock('@wayang-ai/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wayang-ai/protocol')>();
  return { ...actual, validateConfig: vi.fn(actual.validateConfig) };
});

import { validateConfig } from '@wayang-ai/protocol';
import { runWayangServer } from '../wayang-server';
import { Supervisor } from '@/services/supervisor';
import { RpcClient } from '@wayang-ai/protocol/rpc/rpc-client';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';
import { startFakeProvider, isControllerRequest, type FakeProvider } from '@/__tests__/fake-openai-provider';
import type { WayangConfig } from '@wayang-ai/protocol';

let provider: FakeProvider;
let root: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  provider = await startFakeProvider();
  root = mkdtempSync(join(tmpdir(), 'wayang-injected-config-'));
  // Point the env fallback at values that cannot work: the injected object
  // must win, proving core has no config-source awareness.
  vi.stubEnv('WAYANG_LLM_API_KEY', 'wrong-env-key');
  vi.stubEnv('WAYANG_ENDPOINT', 'http://127.0.0.1:9/wrong');
  vi.stubEnv('WAYANG_MODEL', 'wrong-env-model');
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterAll(async () => {
  exitSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.mocked(validateConfig).mockRestore();
  await provider.close();
  rmSync(root, { recursive: true, force: true });
});

/** A fully in-memory config — the fake provider's endpoint, nothing on disk. */
function inMemoryConfig(): WayangConfig {
  return {
    providers: {
      injected: { type: 'openai-compatible', baseURL: provider.baseURL, apiKey: 'injected-key' },
    },
    models: {
      primary: { provider: 'injected', name: 'injected-model', contextWindowTokens: 128_000 },
    },
    controller: { model: 'primary' },
    worker: { model: 'primary', maxConcurrency: 1 },
  };
}

describe('injection-only config run — core has no config-source awareness', () => {
  it('Supervisor consumes the exact injected object (identity, no copy, no re-read)', async () => {
    const config = inMemoryConfig();
    const supervisor = new Supervisor({
      config,
      dataDir: join(root, 'home'),
      workspaceDir: join(root, 'workspace'),
      logLevel: 'silent',
    });

    // Identity: the context runs on the object the host handed over — core
    // neither clones it nor re-reads anything behind the host's back.
    expect(supervisor.ctx.config).toBe(config);
    // The env fallback is ignored when the declared config is complete.
    expect(supervisor.ctx.controllerModel.baseURL).toBe(provider.baseURL);
    expect(supervisor.ctx.controllerModel.modelName).toBe('injected-model');
    expect(vi.mocked(validateConfig)).not.toHaveBeenCalled();

    await supervisor.restore();
    await supervisor.start();
    await supervisor.shutdown();
    expect(vi.mocked(validateConfig)).not.toHaveBeenCalled();
  }, 15_000);

  it('runWayangServer boots from the object and serves a real controller turn — no file, no env, no validation', async () => {
    provider.reset([{ match: isControllerRequest, text: 'injected ok.' }]);
    const serverIn = new PassThrough();
    const serverOut = new PassThrough();
    const client = new RpcClient(createStreamTransport(serverOut, serverIn));

    const readyPromise = new Promise<void>((resolve) => {
      client.on(NOTIFY.READY, () => resolve());
    });
    const requestCountBefore = provider.requests.length;
    const validateCallsBefore = vi.mocked(validateConfig).mock.calls.length;

    void runWayangServer(
      {
        config: inMemoryConfig(),
        dataDir: join(root, 'home2'),
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

    await client.request(METHOD.SUBMIT_INPUT, { text: 'hello injected config' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('controller turn did not complete')), 10_000);
      const poll = setInterval(async () => {
        if (provider.requests.length > requestCountBefore) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
    });

    // The controller's LLM traffic went to the INJECTED endpoint with the
    // INJECTED model name — the (wrong) env values never participated.
    const seen = provider.requests.slice(requestCountBefore);
    expect(seen).toHaveLength(1);
    expect(isControllerRequest(seen[0])).toBe(true);
    expect(seen[0].model).toBe('injected-model');

    // Booting and running a turn parsed/validated nothing.
    expect(vi.mocked(validateConfig).mock.calls.length).toBe(validateCallsBefore);

    // No config file materialized anywhere under the data root (session
    // state files are expected; a config file is not — the tmp prefix itself
    // contains "config", so match on the base name).
    const filesUnder = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(full) : [entry.name];
      });
    const configLike = filesUnder(root).filter((name) => /config/.test(name));
    expect(configLike).toEqual([]);
    expect(existsSync(join(root, 'config.json'))).toBe(false);

    await client.request(METHOD.SHUTDOWN).catch(() => { /* best effort */ });
    // Let the server's shutdown path run to completion (its process.exit is
    // the spied mock) so no callback fires after the test env is gone.
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
  }, 25_000);
});
