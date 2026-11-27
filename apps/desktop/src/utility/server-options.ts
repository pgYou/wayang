/**
 * Pure argv → core-contract mapping for the utility entry (§2.5 storage
 * switch). Kept side-effect-free and Electron-free so the injection values
 * are unit-testable; server-host.ts applies them to serverMain.
 */

import { join } from 'node:path';
import type { StoragePaths, WorkspacePolicy } from '@wayang-ai/protocol';
import type { HostFlags } from './flags';

/**
 * Explicit storage injection (§2.5, values produced by the platform config
 * module in the main process). The desktop host always passes both; a
 * standalone manual run may omit them and get the CLI-default layout
 * (log/cache = session dir) resolved inside the Supervisor.
 */
export function buildStoragePaths(flags: HostFlags): StoragePaths | undefined {
  if (flags.logDir === undefined || flags.cacheDir === undefined) return undefined;
  return { dataDir: flags.dataDir, logDir: flags.logDir, cacheDir: flags.cacheDir };
}

/**
 * Explicit workspace injection (§2.5): controllerWorkspace mirrors the legacy
 * `--workspace-dir` value (single semantic source), defaultWorkerWorkspace
 * falls back to the CLI default `<dataDir>/workspace` for standalone runs.
 */
export function buildWorkspacePolicy(flags: HostFlags): WorkspacePolicy {
  return {
    controllerWorkspace: flags.workspaceDir,
    defaultWorkerWorkspace: flags.defaultWorkerWorkspace ?? join(flags.dataDir, 'workspace'),
    // add_task 无声明时的硬缺省：与 defaultWorkerWorkspace 同源
    // （main 侧 platform-config 注入 `~/.agents/wayang-workspace` 或信封 pref）。
    undeclaredTaskWorkspace: flags.defaultWorkerWorkspace ?? join(flags.dataDir, 'workspace'),
  };
}
