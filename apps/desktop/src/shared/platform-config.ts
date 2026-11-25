/**
 * Platform config & constants module (desktop-app-design §2.6, 决策十).
 *
 * Single source of every path and platform constant the app consumes:
 * - `getPaths()` returns the typed path set (the §2.5 directory baseline);
 * - `getPlatformConfig()` returns platform constants (id, service name, GUI
 *   PATH prefixes);
 * - `getStoragePaths()` / `getWorkspacePolicy()` produce the values desktop
 *   injects into core's `StoragePaths` / `WorkspacePolicy` contract
 *   (monorepo-design 4.2 改造二) — same source, so storage switching and the
 *   envelope config store never drift apart.
 *
 * This module is the ONLY place in the whole app allowed to call
 * `app.getPath` (§5 调用方纪律); every consumer goes through it, and the
 * Electron path API is never exposed. Each path class has an override entry
 * — the `WAYANG_DESKTOP_*` env group is the first one (§2.4: dev/debug
 * overrides; a future settings page and Windows/Linux branches plug into the
 * same mechanism without touching call sites).
 *
 * `getPaths()` / `getPlatformConfig()` accept an injectable source so tests
 * pass fake paths and exercise resolution and override priority without
 * Electron (§2.6 调用方纪律).
 */

import { app } from 'electron';
import { join } from 'node:path';
import type { StoragePaths, WorkspacePolicy } from '@wayang-ai/protocol';

/**
 * The raw Electron surface this module reads. Injectable for tests; the
 * default implementation is the app's single `app.getPath` call site.
 */
export interface PathSource {
  userData: string;
  logs: string;
  home: string;
  appName: string;
}

/** Typed path set — the §2.5 directory baseline, one value set per host. */
export interface PlatformPaths {
  /** Electron userData (`Application Support/<app>`): sessions/ live under it. */
  userData: string;
  /** Electron logs dir (`~/Library/Logs/<app>`): main.log, session logs. */
  logs: string;
  /** Caches dir (`~/Library/Caches/<app>`): runtime temp, MCP sockets. */
  caches: string;
  /** Wayang data dir — userData by the §2.5 baseline (storagePaths.dataDir). */
  dataDir: string;
  /** Envelope config file (决策九, §2.11): `<userData>/config.json`. */
  configPath: string;
  /**
   * Legacy CLI config `~/.wayang.config.json` — read-only import source for
   * the transitional one-time import only (决策九); never written, never
   * consulted at runtime once the envelope exists.
   */
  cliConfigPath: string;
  /** controllerWorkspace (§2.5): `~` — process cwd semantics and dispatch baseline. */
  controllerWorkspace: string;
  /** defaultWorkerWorkspace (§2.5): `~/.agents/wayang-workspace` (mkdir at startup). */
  defaultWorkerWorkspace: string;
}

/** Platform constants (§2.6): ids, service names, GUI PATH prefixes. */
export interface PlatformConfig {
  platform: NodeJS.Platform;
  arch: string;
  isMacOS: boolean;
  appName: string;
  /** UtilityProcess service name (shows up in diagnostics / Activity Monitor). */
  serviceName: string;
  /** PATH prefixes a GUI-launched process misses (fixGuiPath consumers). */
  guiPathPrefixes: string[];
}

/**
 * First override group (§2.4): `WAYANG_DESKTOP_*` env vars. Same mechanism
 * for every path class — future settings-page overrides and platform
 * branches extend this table, never the call sites.
 */
const ENV_OVERRIDES = {
  userData: 'WAYANG_DESKTOP_USER_DATA',
  logs: 'WAYANG_DESKTOP_LOGS',
  caches: 'WAYANG_DESKTOP_CACHES',
  workspace: 'WAYANG_DESKTOP_WORKSPACE',
} as const;

/** The one and only `app.getPath` call site in the whole app. */
function electronPathSource(): PathSource {
  return {
    userData: app.getPath('userData'),
    logs: app.getPath('logs'),
    home: app.getPath('home'),
    appName: app.getName(),
  };
}

/** Resolve the typed path set from a source plus env overrides. */
export function getPaths(source?: PathSource): PlatformPaths {
  const src = source ?? electronPathSource();
  const override = (envValue: string | undefined, base: string): string =>
    envValue !== undefined && envValue !== '' ? envValue : base;

  const userData = override(process.env[ENV_OVERRIDES.userData], src.userData);
  const logs = override(process.env[ENV_OVERRIDES.logs], src.logs);
  // Electron exposes no 'caches' path name; the macOS convention is
  // ~/Library/Caches/<app>, derived here from the home dir so the module
  // stays the single source (platform branches live in-module per §2.6).
  const caches = override(
    process.env[ENV_OVERRIDES.caches],
    join(src.home, 'Library', 'Caches', src.appName),
  );
  const home = src.home;
  const defaultWorkerWorkspace = override(
    process.env[ENV_OVERRIDES.workspace],
    join(home, '.agents', 'wayang-workspace'),
  );

  return {
    userData,
    logs,
    caches,
    dataDir: userData,
    configPath: join(userData, 'config.json'),
    cliConfigPath: join(home, '.wayang.config.json'),
    controllerWorkspace: home,
    defaultWorkerWorkspace,
  };
}

/** Resolve the platform constants. Injectable source for tests. */
export function getPlatformConfig(source?: PathSource): PlatformConfig {
  const src = source ?? electronPathSource();
  return {
    platform: process.platform,
    arch: process.arch,
    isMacOS: process.platform === 'darwin',
    appName: src.appName,
    serviceName: 'wayang-server',
    // GUI launches (Finder/dock) carry a minimal PATH; prepend the usual
    // brew/local bin locations. Future platform branches live here.
    guiPathPrefixes: ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(src.home, '.local/bin')],
  };
}

/** The storage values desktop injects into core (monorepo-design 4.2). */
export function getStoragePaths(paths: PlatformPaths): StoragePaths {
  return { dataDir: paths.dataDir, logDir: paths.logs, cacheDir: paths.caches };
}

/** The workspace anchors desktop injects into core (monorepo-design 4.2). */
export function getWorkspacePolicy(paths: PlatformPaths): WorkspacePolicy {
  return {
    controllerWorkspace: paths.controllerWorkspace,
    defaultWorkerWorkspace: paths.defaultWorkerWorkspace,
  };
}
