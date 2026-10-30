/**
 * RemoteSupervisor.getContextUsage — on-demand GET_SNAPSHOT fetch.
 *
 * The TUI must not know the server-side state path; this facade method hides
 * it behind a typed call and unwraps `{ data }` (`undefined`/`null` → null).
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { RemoteSupervisor } from '@/client/remote-supervisor';
import { RpcClient, RemoteStateStore } from '@/rpc/rpc-client';
import { RpcServer } from '@/rpc/rpc-server';
import { createStreamTransport } from '@/rpc/transport';
import { METHOD } from '@/rpc/protocol';
import type { ContextUsage } from '@/types/index';

const USAGE: ContextUsage = {
  usedTokens: 1234,
  contextWindowTokens: 200_000,
  ratio: 0.00617,
  source: 'usage',
};

function createPair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return {
    clientTransport: createStreamTransport(bToA, aToB),
    serverTransport: createStreamTransport(aToB, bToA),
  };
}

/** Wire a RemoteSupervisor to an in-process server that answers GET_SNAPSHOT. */
function setup(handler: (params: Record<string, unknown>) => unknown): RemoteSupervisor {
  const pair = createPair();
  const server = new RpcServer(pair.serverTransport);
  server.register(METHOD.GET_SNAPSHOT, handler);

  const client = new RpcClient(pair.clientTransport);
  return new RemoteSupervisor(client, new RemoteStateStore(client), '/ws', { stop: async () => {} });
}

describe('RemoteSupervisor.getContextUsage', () => {
  it('requests controllerAgent.dynamicState.contextUsage via GET_SNAPSHOT and unwraps data', async () => {
    const seen: Record<string, unknown>[] = [];
    const supervisor = setup((params) => {
      seen.push(params);
      return { data: USAGE };
    });

    const usage = await supervisor.getContextUsage();

    expect(seen).toEqual([{ target: 'controllerAgent', path: 'dynamicState.contextUsage' }]);
    expect(usage).toEqual(USAGE);
  });

  it('returns null when the server has no value yet (data === null)', async () => {
    const supervisor = setup(() => ({ data: null }));

    await expect(supervisor.getContextUsage()).resolves.toBeNull();
  });

  it('returns null when data is undefined', async () => {
    const supervisor = setup(() => ({}));

    await expect(supervisor.getContextUsage()).resolves.toBeNull();
  });
});
