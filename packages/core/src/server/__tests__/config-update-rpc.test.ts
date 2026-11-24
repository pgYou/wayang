// RPC-level integration of the eight config hot-update methods
// (monorepo-design 4.1 运行时热更) against a REAL Supervisor wired to two
// fake OpenAI providers. Covers the semantics the wire contract promises:
// impact lists, strict duplicate rejection, removal reference lists (as
// structured RpcRequestError payloads), validator-checked patches, and the
// declared/effective split — the controller picks changes up at the NEXT
// turn while an in-flight turn keeps its snapshot, and workers pick them up
// at the NEXT spawn while a running worker keeps its snapshot.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runWayangServer } from '../wayang-server';
import { RpcClient, RpcRequestError } from '@wayang-ai/protocol/rpc/rpc-client';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { METHOD, NOTIFY, RPC_ERROR } from '@wayang-ai/protocol/rpc/protocol';
import { startFakeProvider, isControllerRequest, isWorkerRequest, type FakeProvider, type ScriptEntry } from '@/__tests__/fake-openai-provider';
import type { WayangConfig } from '@wayang-ai/protocol';

let providerA: FakeProvider;
let providerB: FakeProvider;
let root: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  providerA = await startFakeProvider();
  providerB = await startFakeProvider();
  root = mkdtempSync(join(tmpdir(), 'wayang-hotupdate-test-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterAll(async () => {
  exitSpy.mockRestore();
  await providerA.close();
  await providerB.close();
  rmSync(root, { recursive: true, force: true });
});

// --- Helpers ---

/** A one-shot gate the provider's scripted response waits behind. */
function deferred<T>(value: T): { promise: Promise<T>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<T>((resolve) => {
    release = () => resolve(value);
  });
  return { promise, release };
}

/** Config with named models on provider `main` (providerA's endpoint). */
function configOnA(): WayangConfig {
  return {
    providers: {
      main: { type: 'openai-compatible', baseURL: providerA.baseURL, apiKey: 'test-key' },
    },
    models: {
      fast: { provider: 'main', name: 'old-model', contextWindowTokens: 128_000 },
    },
    controller: { model: 'fast' },
    worker: { model: 'fast', maxConcurrency: 1 },
  };
}

interface Booted {
  client: RpcClient;
  /** Conversation snapshot listener: last-seen serialized conversation. */
  conversation: () => string;
  dispose: () => Promise<void>;
}

/** Boot one in-process server over PassThrough streams with the given config. */
async function bootServer(config: WayangConfig): Promise<Booted> {
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const client = new RpcClient(createStreamTransport(serverOut, serverIn));

  let lastConversation: unknown[] = [];
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
  await client.request(METHOD.SUBSCRIBE, { target: 'controllerAgent', path: 'conversation' });
  client.on(NOTIFY.STATE_EVENT, (params) => {
    if (params.target === 'controllerAgent' && params.path === 'conversation') {
      lastConversation = params.data as unknown[];
    }
  });

  return {
    client,
    conversation: () => JSON.stringify(lastConversation),
    dispose: async () => {
      await client.request(METHOD.SHUTDOWN).catch(() => { /* best effort */ });
      await new Promise((r) => setTimeout(r, 100));
      client.close();
    },
  };
}

/** Await a rejection and return it as the structured RPC error. */
async function rpcReject(fn: () => Promise<unknown>): Promise<RpcRequestError> {
  try {
    await fn();
  } catch (err) {
    return err as RpcRequestError;
  }
  throw new Error('expected the request to reject');
}

async function wait(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function submit(client: RpcClient, text: string): Promise<void> {
  await client.request(METHOD.SUBMIT_INPUT, { text });
}

async function taskHistory(client: RpcClient): Promise<Array<{ status: string; result?: string }>> {
  return await client.request(METHOD.LIST_TASKS, { status: 'completed' }) as Array<{ status: string; result?: string }>;
}

/** Wait until the completed-task history reaches `count` rows. */
async function waitTasksCompleted(client: RpcClient, count: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while ((await taskHistory(client)).length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} completed task(s)`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Baseline the provider's request log: `reset` swaps the script but the log
 * accumulates across tests in this file, so every assertion slices from a
 * baseline taken at the test's own start.
 */
function baseline(provider: FakeProvider): number {
  return provider.requests.length;
}

/** Requests a provider received since the given baseline. */
function since(provider: FakeProvider, baseline: number): Array<{ model?: unknown } & Record<string, unknown>> {
  return provider.requests.slice(baseline) as Array<{ model?: unknown } & Record<string, unknown>>;
}

/** Generic controller reply entries for the wake runs between task events. */
function controllerOk(count: number): ScriptEntry[] {
  return Array.from({ length: count }, () => ({ match: isControllerRequest, text: 'ok.' }));
}

// --- updateProvider: the controller's turn boundary ---

describe('config hot-update over RPC — updateProvider', () => {
  it('affects the next turn only: an in-flight turn keeps the old baseURL snapshot', async () => {
    // Turn 1's first response is held open behind a gate (the controller
    // called list_tasks; the fake provider resolves its tool args only once
    // released) — the turn is in flight while the update lands.
    const hold = deferred<Record<string, unknown>>({});
    providerA.reset([
      { match: isControllerRequest, toolCalls: [{ name: 'list_tasks', args: () => hold.promise }] },
      { match: isControllerRequest, text: 'turn one done.' },
    ]);
    providerB.reset([{ match: isControllerRequest, text: 'turn two on B.' }]);
    const a0 = baseline(providerA);
    const b0 = baseline(providerB);
    const config = configOnA();
    const { client, conversation, dispose } = await bootServer(config);

    try {
      await submit(client, 'first turn');

      await wait('turn 1 request reached provider A', () => since(providerA, a0).length === 1);
      expect(since(providerA, a0)[0].model).toBe('old-model');

      // The update lands WHILE the first turn is still waiting for its
      // first step response.
      const result = await client.request<{ affected: Array<{ kind: string; via: string; effective: string }> }>(
        METHOD.UPDATE_PROVIDER,
        { name: 'main', patch: { baseURL: providerB.baseURL } },
      );
      // Impact list, reference-graph derived: both bindings resolve through
      // `main` — the controller switches next turn, the worker next spawn.
      expect(result.affected).toEqual([
        { kind: 'controller', via: 'fast', effective: 'next-turn' },
        { kind: 'worker', via: 'fast', effective: 'next-spawn' },
      ]);
      expect(config.providers.main.baseURL).toBe(providerB.baseURL);

      hold.release();
      await wait('turn 1 finished on the OLD provider', () => conversation().includes('turn one done.'));

      // The in-flight turn completed entirely on provider A (step 2 of the
      // SAME streamText call reuses the model instance it captured).
      expect(since(providerA, a0).length).toBe(2);
      expect(since(providerA, a0).every((body) => isControllerRequest(body as never))).toBe(true);
      expect(since(providerB, b0).length).toBe(0);

      // Next turn → new baseURL.
      await submit(client, 'second turn');
      await wait('turn 2 finished on provider B', () => conversation().includes('turn two on B.'));
      expect(since(providerA, a0).length).toBe(2); // frozen after the boundary
      expect(since(providerB, b0).length).toBe(1);
      expect(isControllerRequest(since(providerB, b0)[0] as never)).toBe(true);
    } finally {
      await dispose();
    }
  }, 30_000);
});

// --- add + rebind: the "new chain at next spawn" acceptance flow ---

describe('config hot-update over RPC — add + rebind worker (design 4.1 验收)', () => {
  it('addProvider + addModel + updateWorkerSettings: the NEXT worker spawn uses the new chain, no restart', async () => {
    // Generic 'ok.' entries absorb the controller's wake runs between task
    // events (worker_started / completed signals each trigger one run).
    providerA.reset([
      {
        match: isControllerRequest,
        toolCalls: [{ name: 'add_task', args: { title: 'New chain', description: 'Report done.', priority: 'normal' } }],
      },
      ...controllerOk(5),
    ]);
    providerB.reset([
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'ran on the new chain' } }] },
    ]);
    const a0 = baseline(providerA);
    const b0 = baseline(providerB);
    const config = configOnA();
    const { client, conversation, dispose } = await bootServer(config);

    try {
      // Nothing references the new entries: add* returns empty impact lists.
      expect(await client.request(METHOD.ADD_PROVIDER, {
        name: 'extra', def: { type: 'openai-compatible', baseURL: providerB.baseURL, apiKey: 'new-key' },
      })).toEqual({ affected: [] });
      expect(await client.request(METHOD.ADD_MODEL, {
        name: 'm2', def: { provider: 'extra', name: 'new-model', contextWindowTokens: 64_000 },
      })).toEqual({ affected: [] });

      const settings = await client.request<{ affected: Array<{ kind: string; via: string; effective: string }> }>(
        METHOD.UPDATE_WORKER_SETTINGS, { patch: { model: 'm2' } },
      );
      expect(settings.affected).toEqual([{ kind: 'worker', via: 'm2', effective: 'next-spawn' }]);
      expect(config.worker.model).toBe('m2');

      await submit(client, 'run the new chain task');
      await waitTasksCompleted(client, 1);

      // The controller stayed on provider A (old-model, every request a
      // controller request); the worker's LLM call ran on provider B with
      // the newly declared model name — the whole chain switched with no
      // restart, exactly the design 4.1 acceptance scenario.
      const aRequests = since(providerA, a0);
      const bRequests = since(providerB, b0);
      expect(aRequests.length).toBeGreaterThan(0);
      expect(aRequests.every((body) => isControllerRequest(body as never))).toBe(true);
      expect(bRequests.filter((body) => isWorkerRequest(body as never))).toHaveLength(1);
      expect(bRequests.filter((body) => isWorkerRequest(body as never))[0].model).toBe('new-model');

      const history = await taskHistory(client);
      expect(history[0]?.result).toBe('ran on the new chain');
      await wait('controller replies settled', () => conversation().includes('ok.'));
    } finally {
      await dispose();
    }
  }, 30_000);
});

// --- a running worker keeps its snapshot; the NEXT spawn switches ---

describe('config hot-update over RPC — worker next-spawn boundary', () => {
  it('a running worker finishes on the old provider; the next task spawns on the new one', async () => {
    // Worker 1's first response is held behind a gate — its run is in flight
    // when updateProvider moves provider `main` to provider B.
    const hold = deferred<Record<string, unknown>>({ summary: 'first worker on A' });
    providerA.reset([
      {
        match: isControllerRequest,
        toolCalls: [{ name: 'add_task', args: { title: 'Task one', description: 'Report done.', priority: 'normal' } }],
      },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: () => hold.promise }] },
      {
        match: isControllerRequest,
        toolCalls: [{ name: 'add_task', args: { title: 'Task two', description: 'Report done.', priority: 'normal' } }],
      },
      ...controllerOk(4),
    ]);
    providerB.reset([
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'second worker on B' } }] },
      ...controllerOk(4),
    ]);
    const a0 = baseline(providerA);
    const b0 = baseline(providerB);
    const config = configOnA();
    const { client, dispose } = await bootServer(config);

    try {
      await submit(client, 'run both tasks');
      await wait('worker 1 request reached provider A', () => since(providerA, a0).some((body) => isWorkerRequest(body as never)));

      // Update lands while worker 1 is mid-run.
      await client.request(METHOD.UPDATE_PROVIDER, { name: 'main', patch: { baseURL: providerB.baseURL } });

      hold.release();
      await waitTasksCompleted(client, 2);

      // Worker 1 (in flight at update time) served from A; worker 2 (spawned
      // AFTER the update) served from B.
      const workersOnA = since(providerA, a0).filter((body) => isWorkerRequest(body as never));
      const workersOnB = since(providerB, b0).filter((body) => isWorkerRequest(body as never));
      expect(workersOnA).toHaveLength(1);
      expect(workersOnB).toHaveLength(1);
      // The controller's pre-update turns ran on A; its post-update wake
      // turns (task events of worker 2) run on B.
      expect(since(providerA, a0).some((body) => isControllerRequest(body as never))).toBe(true);
      expect(since(providerB, b0).some((body) => isControllerRequest(body as never))).toBe(true);

      const history = await taskHistory(client);
      expect(history.map((t) => t.result)).toEqual(expect.arrayContaining(['first worker on A', 'second worker on B']));
    } finally {
      await dispose();
    }
  }, 30_000);
});

// --- updateControllerModel: the model NAME switches at the next turn ---

describe('config hot-update over RPC — updateControllerModel', () => {
  it('rebinds the controller to a newly added model; the next turn sends the new model name', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'before switch.' }]);
    providerB.reset([{ match: isControllerRequest, text: 'after switch.' }]);
    const a0 = baseline(providerA);
    const b0 = baseline(providerB);
    const config = configOnA();
    const { client, conversation, dispose } = await bootServer(config);

    try {
      await submit(client, 'turn on old model');
      await wait('turn 1 done', () => conversation().includes('before switch.'));
      expect(since(providerA, a0)[0].model).toBe('old-model');

      await client.request(METHOD.ADD_PROVIDER, {
        name: 'extra', def: { type: 'openai-compatible', baseURL: providerB.baseURL, apiKey: 'new-key' },
      });
      await client.request(METHOD.ADD_MODEL, {
        name: 'm2', def: { provider: 'extra', name: 'new-model', contextWindowTokens: 64_000 },
      });
      const result = await client.request<{ affected: Array<{ kind: string; via: string; effective: string }> }>(
        METHOD.UPDATE_CONTROLLER_MODEL, { model: 'm2' },
      );
      expect(result.affected).toEqual([{ kind: 'controller', via: 'm2', effective: 'next-turn' }]);
      expect(config.controller.model).toBe('m2');

      await submit(client, 'turn on new model');
      await wait('turn 2 done', () => conversation().includes('after switch.'));
      expect(since(providerB, b0)).toHaveLength(1);
      expect(since(providerB, b0)[0].model).toBe('new-model');
      expect(since(providerA, a0)).toHaveLength(1);
    } finally {
      await dispose();
    }
  }, 30_000);
});

// --- rejections: structure over the wire ---

describe('config hot-update over RPC — rejections carry structured payloads', () => {
  it('addProvider strictly refuses a duplicate name (no force)', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const { client, dispose } = await bootServer(configOnA());
    try {
      const err = await rpcReject(() => client.request(METHOD.ADD_PROVIDER, {
        name: 'main', def: { type: 'openai-compatible', baseURL: 'http://x', apiKey: 'k' },
      }));
      expect(err).toBeInstanceOf(RpcRequestError);
      expect(err.error.code).toBe(RPC_ERROR.INVALID_PARAMS);
      expect(err.error.data).toMatchObject({ reason: 'duplicate' });
      expect(err.error.data).toMatchObject({ detail: expect.stringContaining('providers.main') });
    } finally {
      await dispose();
    }
  }, 15_000);

  it('addModel strictly refuses a duplicate key', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const { client, dispose } = await bootServer(configOnA());
    try {
      const err = await rpcReject(() => client.request(METHOD.ADD_MODEL, {
        name: 'fast', def: { provider: 'main', name: 'x', contextWindowTokens: 1 },
      }));
      expect(err.error.data).toMatchObject({ reason: 'duplicate' });
    } finally {
      await dispose();
    }
  }, 15_000);

  it('removeProvider is refused with the reference list (models entries + direct bindings)', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const config = configOnA();
    // A composite binding (worker.model 'main/gpt') and an inline workers row
    // reference `main` directly; models.fast goes through the entry.
    config.worker.model = 'main/gpt';
    config.workers = { codex: { type: 'claude-code', description: 'coding', model: { provider: 'main', name: 'codex-model' } } };
    const { client, dispose } = await bootServer(config);
    try {
      const err = await rpcReject(() => client.request(METHOD.REMOVE_PROVIDER, { name: 'main' }));
      expect(err.error.code).toBe(RPC_ERROR.INVALID_PARAMS);
      expect(err.error.data).toEqual({
        reason: 'referenced',
        blockers: [
          { site: 'models.fast', kind: 'models' },
          { site: 'worker.model', kind: 'binding' },
          { site: 'workers.codex.model', kind: 'binding' },
        ],
        detail: expect.any(String),
      });
      expect(err.message).toContain('no cascade');
      // Refused means unchanged — a follow-up update still sees the provider.
      expect(await client.request(METHOD.UPDATE_PROVIDER, { name: 'main', patch: { apiKey: 'still-here' } }))
        .toMatchObject({ affected: expect.any(Array) });
    } finally {
      await dispose();
    }
  }, 15_000);

  it('removeModel is refused while a binding names the key, then succeeds once unbound', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const { client, dispose } = await bootServer(configOnA());
    try {
      const blocked = await rpcReject(() => client.request(METHOD.REMOVE_MODEL, { name: 'fast' }));
      expect(blocked.error.data).toEqual({
        reason: 'referenced',
        blockers: [
          { site: 'controller.model', kind: 'binding' },
          { site: 'worker.model', kind: 'binding' },
        ],
        detail: expect.any(String),
      });

      // Unbind both references (controller + worker), then the removal goes
      // through — and is real (a second attempt is not-found).
      await client.request(METHOD.UPDATE_CONTROLLER_MODEL, { model: 'main/gpt' });
      await client.request(METHOD.UPDATE_WORKER_SETTINGS, { patch: { model: 'main/gpt' } });
      expect(await client.request(METHOD.REMOVE_MODEL, { name: 'fast' })).toEqual({ affected: [] });
      const gone = await rpcReject(() => client.request(METHOD.REMOVE_MODEL, { name: 'fast' }));
      expect(gone.error.data).toMatchObject({ reason: 'not-found' });
    } finally {
      await dispose();
    }
  }, 15_000);

  it('removeProvider succeeds for an unreferenced provider added at runtime', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const { client, dispose } = await bootServer(configOnA());
    try {
      await client.request(METHOD.ADD_PROVIDER, {
        name: 'lonely', def: { type: 'openai-compatible', baseURL: 'http://lonely', apiKey: 'k' },
      });
      expect(await client.request(METHOD.REMOVE_PROVIDER, { name: 'lonely' })).toEqual({ affected: [] });
      // Really gone: the name can be re-added.
      await client.request(METHOD.ADD_PROVIDER, {
        name: 'lonely', def: { type: 'openai-compatible', baseURL: 'http://lonely2', apiKey: 'k' },
      });
    } finally {
      await dispose();
    }
  }, 15_000);

  it('a patch failing the shared validator rejects with the validator message and no partial write', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const config = configOnA();
    const { client, dispose } = await bootServer(config);
    try {
      const err = await rpcReject(() => client.request(METHOD.UPDATE_MODEL, {
        name: 'fast', patch: { contextWindowTokens: 0 },
      }));
      expect(err.error.data).toMatchObject({ reason: 'invalid' });
      expect(err.error.data).toMatchObject({ detail: expect.stringContaining('models.fast.contextWindowTokens') });
      expect(config.models!.fast.contextWindowTokens).toBe(128_000);

      const ghost = await rpcReject(() => client.request(METHOD.UPDATE_MODEL, {
        name: 'fast', patch: { provider: 'ghost' },
      }));
      expect(ghost.error.data).toMatchObject({ reason: 'invalid' });
      expect(config.models!.fast.provider).toBe('main');
    } finally {
      await dispose();
    }
  }, 15_000);

  it('unknown update targets are not-found; non-whitelisted fields are parser-rejected', async () => {
    providerA.reset([{ match: isControllerRequest, text: 'ok.' }]);
    const { client, dispose } = await bootServer(configOnA());
    try {
      const missing = await rpcReject(() => client.request(METHOD.UPDATE_PROVIDER, { name: 'ghost', patch: { apiKey: 'k' } }));
      expect(missing.error.data).toMatchObject({ reason: 'not-found' });

      // The parser enforces the field whitelist BEFORE any semantics run.
      const whitelisted = await rpcReject(() => client.request(METHOD.UPDATE_MODEL, {
        name: 'fast', patch: { modelName: 'nope' },
      }));
      expect(whitelisted.error.code).toBe(RPC_ERROR.INVALID_PARAMS);
      expect(whitelisted.message).toContain('field whitelist');
      expect(whitelisted.error.data).toBeUndefined();
    } finally {
      await dispose();
    }
  }, 15_000);
});
