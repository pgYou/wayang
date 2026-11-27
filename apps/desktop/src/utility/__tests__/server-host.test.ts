import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildStoragePaths, buildWorkspacePolicy } from '../server-options';
import { parseHostFlags, type HostFlags } from '../flags';

/**
 * Injection-value tests for the storage switch (§4.1 工作项⑥, §2.5): the
 * utility entry must turn the fork argv into the EXPLICIT StoragePaths /
 * WorkspacePolicy contract (values produced by the platform config module in
 * the main process) — the legacy dataDir/workspaceDir pair only mirrors the
 * contract members.
 */

const hostFlags = (overrides: Partial<HostFlags> = {}): HostFlags =>
  parseHostFlags([
    '--config', '/app/config.json',
    '--data-dir', '/app/userData',
    '--workspace-dir', '/home/u',
    '--session', 'new',
    ...('--log-dir' in overrides || 'logDir' in overrides ? ['--log-dir', overrides.logDir ?? '/app/logs'] : []),
    ...('--cache-dir' in overrides || 'cacheDir' in overrides ? ['--cache-dir', overrides.cacheDir ?? '/app/caches'] : []),
    ...('defaultWorkerWorkspace' in overrides && overrides.defaultWorkerWorkspace !== undefined
      ? ['--default-worker-workspace', overrides.defaultWorkerWorkspace]
      : []),
  ]);

describe('buildStoragePaths (explicit injection)', () => {
  it('injects the contract verbatim when the host passes log/cache dirs', () => {
    const flags = hostFlags({ logDir: '/app/logs', cacheDir: '/app/caches' });
    expect(buildStoragePaths(flags)).toEqual({
      dataDir: '/app/userData',
      logDir: '/app/logs',
      cacheDir: '/app/caches',
    });
  });

  it('stays undefined for a standalone run without the injection flags (CLI-default layout)', () => {
    expect(buildStoragePaths(hostFlags())).toBeUndefined();
  });
});

describe('buildWorkspacePolicy (explicit injection)', () => {
  it('maps controllerWorkspace from the legacy mirror and the worker workspace verbatim', () => {
    const flags = hostFlags({ defaultWorkerWorkspace: '/home/u/.agents/wayang-workspace' });
    expect(buildWorkspacePolicy(flags)).toEqual({
      controllerWorkspace: '/home/u',
      defaultWorkerWorkspace: '/home/u/.agents/wayang-workspace',
      // add_task 无声明时的硬缺省与 worker workspace 同源。
      undeclaredTaskWorkspace: '/home/u/.agents/wayang-workspace',
    });
  });

  it('falls back to the CLI default <dataDir>/workspace when the host omitted it', () => {
    expect(buildWorkspacePolicy(hostFlags())).toEqual({
      controllerWorkspace: '/home/u',
      defaultWorkerWorkspace: join('/app/userData', 'workspace'),
      undeclaredTaskWorkspace: join('/app/userData', 'workspace'),
    });
  });
});
