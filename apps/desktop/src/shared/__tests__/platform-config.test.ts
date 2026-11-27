import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// The module under test imports `app` from 'electron' — the only place in the
// app allowed to touch it. The mock stands in for the real app so tests can
// inject fake paths (§2.6 调用方纪律: 假路径 + override 优先级可独立单测).
vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return '/fake/App Support/wayang';
      if (name === 'logs') return '/fake/Logs/wayang';
      if (name === 'home') return '/fake/home';
      throw new Error(`unexpected getPath(${name})`);
    },
    getName: (): string => 'wayang-fake',
  },
}));

import { getPaths, getPlatformConfig, getStoragePaths, getWorkspacePolicy, type PathSource } from '../platform-config';

const source: PathSource = {
  userData: '/base/App Support/wayang',
  logs: '/base/Logs/wayang',
  home: '/base/home',
  appName: 'wayang',
};

const OVERRIDABLE = [
  ['WAYANG_DESKTOP_USER_DATA', 'userData'],
  ['WAYANG_DESKTOP_LOGS', 'logs'],
  ['WAYANG_DESKTOP_CACHES', 'caches'],
  ['WAYANG_DESKTOP_WORKSPACE', 'defaultWorkerWorkspace'],
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [envKey] of OVERRIDABLE) {
    saved[envKey] = process.env[envKey];
    delete process.env[envKey];
  }
});

afterEach(() => {
  for (const [envKey] of OVERRIDABLE) {
    const value = saved[envKey];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  vi.restoreAllMocks();
});

describe('getPaths', () => {
  it('maps the §2.5 baseline from an injected source (fake paths, no Electron state)', () => {
    const paths = getPaths(source);
    expect(paths.userData).toBe('/base/App Support/wayang');
    expect(paths.logs).toBe('/base/Logs/wayang');
    // Electron has no 'caches' path name: derived from home by convention.
    expect(paths.caches).toBe(join('/base/home', 'Library', 'Caches', 'wayang'));
    expect(paths.dataDir).toBe(paths.userData);
    expect(paths.configPath).toBe(join('/base/App Support/wayang', 'config.json'));
    expect(paths.cliConfigPath).toBe(join('/base/home', '.wayang.config.json'));
    expect(paths.controllerWorkspace).toBe('/base/home');
    expect(paths.defaultWorkerWorkspace).toBe(join('/base/home', '.agents', 'wayang-workspace'));
  });

  it('reads the default source from the Electron app (the single app.getPath site)', () => {
    const paths = getPaths();
    expect(paths.userData).toBe('/fake/App Support/wayang');
    expect(paths.logs).toBe('/fake/Logs/wayang');
    expect(paths.caches).toBe(join('/fake/home', 'Library', 'Caches', 'wayang-fake'));
    expect(paths.configPath).toBe(join('/fake/App Support/wayang', 'config.json'));
    expect(paths.controllerWorkspace).toBe('/fake/home');
  });

  it('lets each WAYANG_DESKTOP_* env override win over the Electron source', () => {
    process.env.WAYANG_DESKTOP_USER_DATA = '/ov/userData';
    process.env.WAYANG_DESKTOP_LOGS = '/ov/logs';
    process.env.WAYANG_DESKTOP_CACHES = '/ov/caches';
    process.env.WAYANG_DESKTOP_WORKSPACE = '/ov/workspace';
    const paths = getPaths(source);
    expect(paths.userData).toBe('/ov/userData');
    expect(paths.logs).toBe('/ov/logs');
    expect(paths.caches).toBe('/ov/caches');
    expect(paths.defaultWorkerWorkspace).toBe('/ov/workspace');
    // dataDir/configPath follow the overridden userData; the home-anchored
    // values stay on the source (the override mechanism is per path class).
    expect(paths.dataDir).toBe('/ov/userData');
    expect(paths.configPath).toBe(join('/ov/userData', 'config.json'));
    expect(paths.controllerWorkspace).toBe('/base/home');
  });

  it('treats an empty override value as unset', () => {
    process.env.WAYANG_DESKTOP_USER_DATA = '';
    const paths = getPaths(source);
    expect(paths.userData).toBe('/base/App Support/wayang');
  });
});

describe('getPlatformConfig', () => {
  it('returns platform constants with the injected home anchoring the PATH prefixes', () => {
    const config = getPlatformConfig(source);
    expect(config.platform).toBe(process.platform);
    expect(config.arch).toBe(process.arch);
    expect(config.isMacOS).toBe(process.platform === 'darwin');
    expect(config.appName).toBe('wayang');
    expect(config.serviceName).toBe('wayang-server');
    expect(config.guiPathPrefixes).toEqual([
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      join('/base/home', '.local/bin'),
    ]);
  });
});

describe('core injection values (StoragePaths / WorkspacePolicy)', () => {
  it('produces the storage contract from the module paths (single source)', () => {
    const paths = getPaths(source);
    expect(getStoragePaths(paths)).toEqual({
      dataDir: '/base/App Support/wayang',
      logDir: '/base/Logs/wayang',
      cacheDir: join('/base/home', 'Library', 'Caches', 'wayang'),
    });
  });

  it('workspace priority: env override > envelope pref (PathSource) > default (决策十 ladder)', () => {
    // §4.3 工作项②: the settings page persists defaultWorkerWorkspace in the
    // envelope; it enters the SAME override mechanism one rung below the env
    // dev override — env wins when both are set, call sites unchanged.
    const withPref = getPaths({ ...source, defaultWorkerWorkspace: '/picked/ws' });
    expect(withPref.defaultWorkerWorkspace).toBe('/picked/ws');
    process.env.WAYANG_DESKTOP_WORKSPACE = '/env/ws';
    expect(getPaths({ ...source, defaultWorkerWorkspace: '/picked/ws' }).defaultWorkerWorkspace).toBe('/env/ws');
    // Absent pref and env → the §2.5 default.
    delete process.env.WAYANG_DESKTOP_WORKSPACE;
    expect(getPaths(source).defaultWorkerWorkspace).toBe(join('/base/home', '.agents', 'wayang-workspace'));
  });

  it('produces the workspace contract from the module paths (single source)', () => {
    const paths = getPaths(source);
    expect(getWorkspacePolicy(paths)).toEqual({
      controllerWorkspace: '/base/home',
      defaultWorkerWorkspace: join('/base/home', '.agents', 'wayang-workspace'),
      // add_task 无声明时的硬缺省与 general workspace 同源（desktop 无启动目录概念）。
      undeclaredTaskWorkspace: join('/base/home', '.agents', 'wayang-workspace'),
    });
  });
});
