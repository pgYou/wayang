/**
 * StoragePaths / WorkspacePolicy 双轨注入 (monorepo-design 4.2 改造二).
 *
 * Contract under test:
 * - the host-injected values win VERBATIM on SystemContext (Supervisor
 *   forwards them; serverMain/runWayangServer pass them through);
 * - the CLI defaults (nothing injected) reproduce the 0.9.9 paths item by
 *   item: log/cache = the session dir, defaultWorkerWorkspace = <dataDir>/workspace,
 *   controllerWorkspace = the launch workspace;
 * - ORTHOGONALITY: injecting a custom StoragePaths does not move the worker
 *   default workspace (acceptance of 4.2);
 * - DIVERGENCE: controllerWorkspace != defaultWorkerWorkspace lands on the
 *   right anchor at every consumer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Supervisor, resolveSessionStoragePaths, resolveSessionWorkspacePolicy } from '@/services/supervisor';
import { resolveGeneralWorkspace } from '@/infra/general-workspace';
import { mcpSocketPathFor } from '@/services/agents/acp/mcp-transport';
import type { StoragePaths, WayangConfig, WorkspacePolicy } from '@wayang-ai/protocol';

const providerConfig = {
  endpoint: 'http://localhost:1234/v1',
  apiKey: 'test-key',
  modelName: 'test-model',
};

const defaultConfig: WayangConfig = {
  providers: { default: providerConfig },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 3 },
};

const created: Supervisor[] = [];

function makeSupervisor(opts: {
  dataDir: string;
  workspaceDir: string;
  storagePaths?: StoragePaths;
  workspacePolicy?: WorkspacePolicy;
}): Supervisor {
  const sup = new Supervisor({
    config: defaultConfig,
    logLevel: 'silent',
    ...opts,
  });
  created.push(sup);
  return sup;
}

let dataDir: string;
let workspaceDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wayang-storage-inject-'));
  workspaceDir = mkdtempSync(join(tmpdir(), 'wayang-storage-ws-'));
});

afterEach(async () => {
  for (const sup of created.splice(0)) await sup.shutdown().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe('pure default resolution helpers', () => {
  it('resolveSessionStoragePaths: no injection assigns the session dir as log/cache dir (0.9.9 layout)', () => {
    const paths = resolveSessionStoragePaths('/data', '/data/sessions/s-1');
    expect(paths).toEqual({ dataDir: '/data', logDir: '/data/sessions/s-1', cacheDir: '/data/sessions/s-1' });
  });

  it('resolveSessionStoragePaths: an injected StoragePaths wins verbatim', () => {
    const injected: StoragePaths = { dataDir: '/data', logDir: '/var/log/wayang', cacheDir: '/var/cache/wayang' };
    expect(resolveSessionStoragePaths('/data', '/data/sessions/s-1', injected)).toBe(injected);
  });

  it('resolveSessionWorkspacePolicy: no injection maps controllerWorkspace to the launch workspace and defaultWorkerWorkspace to <dataDir>/workspace', () => {
    expect(resolveSessionWorkspacePolicy('/data', '/launch/ws')).toEqual({
      controllerWorkspace: '/launch/ws',
      defaultWorkerWorkspace: '/data/workspace',
    });
  });

  it('resolveSessionWorkspacePolicy: an injected WorkspacePolicy wins verbatim', () => {
    const injected: WorkspacePolicy = { controllerWorkspace: '/desk/controller', defaultWorkerWorkspace: '/desk/tasks' };
    expect(resolveSessionWorkspacePolicy('/data', '/launch/ws', injected)).toBe(injected);
  });
});

describe('Supervisor injection chain', () => {
  it('forwards host-injected StoragePaths and WorkspacePolicy to SystemContext verbatim', () => {
    const storagePaths: StoragePaths = { dataDir, logDir: join(dataDir, 'logs'), cacheDir: join(dataDir, 'cache') };
    const workspacePolicy: WorkspacePolicy = {
      controllerWorkspace: workspaceDir,
      defaultWorkerWorkspace: join(dataDir, 'elsewhere-tasks'),
    };
    const sup = makeSupervisor({ dataDir, workspaceDir, storagePaths, workspacePolicy });

    expect(sup.ctx.storagePaths).toBe(storagePaths);
    expect(sup.ctx.workspacePolicy).toBe(workspacePolicy);
    // ctx.workspaceDir is the documented alias of controllerWorkspace.
    expect(sup.ctx.workspaceDir).toBe(workspaceDir);
    // The log sink writes into the INJECTED logDir, not the session dir.
    expect(sup.ctx.logFilePath).toBe(join(dataDir, 'logs', 'wayang.log'));
  });

  it('applies the 0.9.9 CLI defaults when nothing is injected (item-by-item parity)', () => {
    const sup = makeSupervisor({ dataDir, workspaceDir });
    const sessionDir = sup.ctx.sessionDir;

    // <dataDir>/workspace as the worker default workspace…
    expect(sup.ctx.workspacePolicy.defaultWorkerWorkspace).toBe(join(dataDir, 'workspace'));
    // …the launch workspace as the controller workspace…
    expect(sup.ctx.workspacePolicy.controllerWorkspace).toBe(workspaceDir);
    // …log/cache as session-dir subdirectories of dataDir (unchanged layout).
    expect(sup.ctx.storagePaths).toEqual({ dataDir, logDir: sessionDir, cacheDir: sessionDir });
    expect(sup.ctx.logFilePath).toBe(join(sessionDir, 'wayang.log'));
    // …and MCP sockets under <sessionDir>/.mcp, exactly like 0.9.9.
    expect(mcpSocketPathFor(sup.ctx.storagePaths.cacheDir, 'w1', 'abc')).toBe(
      join(sessionDir, '.mcp', 'acp-mcp-w1-abc.sock'),
    );
  });

  it('orthogonality: a custom StoragePaths leaves the worker default workspace untouched', () => {
    // Acceptance of design 4.2: injecting custom storage must NOT move where
    // tasks with no codebase of their own run.
    const storagePaths: StoragePaths = { dataDir, logDir: join(dataDir, 'logs'), cacheDir: join(dataDir, 'cache') };
    const sup = makeSupervisor({ dataDir, workspaceDir, storagePaths });

    const generalWorkspace = resolveGeneralWorkspace(sup.ctx);
    expect(generalWorkspace).toBe(join(dataDir, 'workspace'));
    expect(generalWorkspace).not.toContain('logs');
    expect(generalWorkspace).not.toContain('cache');
    // The general workspace is NOT created by resolving it (purity).
  });

  it('divergence: controllerWorkspace != defaultWorkerWorkspace lands on distinct anchors', () => {
    const controllerWs = mkdtempSync(join(tmpdir(), 'wayang-controller-ws-'));
    const workerDefault = join(dataDir, 'drafts');
    const sup = makeSupervisor({
      dataDir,
      workspaceDir,
      workspacePolicy: { controllerWorkspace: controllerWs, defaultWorkerWorkspace: workerDefault },
    });

    expect(sup.ctx.workspaceDir).toBe(controllerWs);
    expect(resolveGeneralWorkspace(sup.ctx)).toBe(workerDefault);
    // The controller workspace never leaks into the worker default (and vice
    // versa): the two anchors are independent injection slots.
    expect(resolveGeneralWorkspace(sup.ctx)).not.toBe(controllerWs);
    expect(sup.ctx.workspaceDir).not.toBe(workerDefault);
    rmSync(controllerWs, { recursive: true, force: true });
  });
});
