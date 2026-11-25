/**
 * serverMain / runWayangServer forward the host-injected deployment
 * contracts (monorepo-design 4.2 改造二) into the Supervisor verbatim.
 *
 * The Supervisor is mocked: this suite pins the PASS-THROUGH only (the
 * Supervisor-level behavior has its own suite — storage-paths-injection).
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { StoragePaths, WayangConfig, WorkspacePolicy } from '@wayang-ai/protocol';

const supervisorOptions: unknown[] = [];

vi.mock('@/services/supervisor', () => ({
  Supervisor: class MockSupervisor {
    ctx = { sessionId: 's-fwd', sessionDir: '/tmp/s-fwd', workspaceDir: '/tmp/ws' };
    constructor(options: unknown) {
      supervisorOptions.push(options);
    }
    restore = vi.fn(async () => {});
    start = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});
    getConversationIndex = vi.fn(() => ({ turns: [] }));
    getTurn = vi.fn();
    signalQueue = { subscribe: () => () => {}, getSnapshot: () => [] };
    engine = { subscribe: () => () => {}, getSnapshot: () => [] };
    controllerAgent = { subscribe: () => () => {}, getSnapshot: () => undefined };
  },
}));

import { serverMain } from '../main';

const config: WayangConfig = {
  providers: { default: { endpoint: 'http://localhost:1', apiKey: 'k', modelName: 'm' } },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 1 },
};

describe('serverMain storage/workspace forwarding (design 4.2)', () => {
  it('passes the injected storagePaths and workspacePolicy through to the Supervisor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wayang-fwd-'));
    const storagePaths: StoragePaths = { dataDir: root, logDir: join(root, 'logs'), cacheDir: join(root, 'cache') };
    const workspacePolicy: WorkspacePolicy = {
      controllerWorkspace: join(root, 'controller-ws'),
      defaultWorkerWorkspace: join(root, 'tasks'),
    };

    // A rejected SHUTDOWN is enough: runWayangServer boots the (mocked)
    // supervisor and then serves — we stop the process after the boot.
    await serverMain({
      config,
      dataDir: root,
      workspaceDir: join(root, 'launch-ws'),
      storagePaths,
      workspacePolicy,
      session: 'new',
      injectPreviousTasks: false,
      logLevel: 'silent',
    }).then(async (runPromise) => {
      // The server keeps the event loop alive; give the microtask queue a
      // turn so construction lands, then let the suite proceed without
      // awaiting the never-settling serve promise.
      await new Promise((resolve) => setImmediate(resolve));
      void runPromise;
    }).catch(() => undefined);

    expect(supervisorOptions).toHaveLength(1);
    const forwarded = supervisorOptions[0] as { storagePaths?: StoragePaths; workspacePolicy?: WorkspacePolicy; dataDir?: string };
    expect(forwarded.storagePaths).toBe(storagePaths);
    expect(forwarded.workspacePolicy).toBe(workspacePolicy);
    expect(forwarded.dataDir).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });
});
