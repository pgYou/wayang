/**
 * Application (desktop-app-design §2.9, 4.2 域二工作项②).
 *
 * The assembly root: composes the WindowManager, SecurityGuard,
 * SessionService (which owns the ServerProcessHost) and UnifiedLogger, and
 * runs the Disposable-style quit queue that unifies
 * `before-quit` / `window-all-closed` (macOS 关窗不退进程) / `activate`
 * (dock reopen) plus the process-level crash records.
 */

import { app, type BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initMainLogger } from './logger';
import { UnifiedLogger } from './unified-logger';
import { WindowManager } from './window-manager';
import { SecurityGuard } from './security-guard';
import { SessionService, type DesktopSessionOptions } from './session-service';
import { getPaths, getPlatformConfig, getStoragePaths, getWorkspacePolicy } from '../shared/platform-config';

/** Prepend the paths a GUI-launched process misses (brew, local bin). */
function fixGuiPath(): void {
  const parts = process.env.PATH?.split(':') ?? [];
  process.env.PATH = [...new Set([...getPlatformConfig().guiPathPrefixes, ...parts])].join(':');
}

function resolveSessionOptions(): DesktopSessionOptions {
  // All paths via the platform config module (决策十) — no hand-joined
  // homedir paths, no direct Electron path calls outside the module.
  const paths = getPaths();
  // Storage/workspace injection values (§2.5 storage switch): produced by
  // the platform config module (single source) and injected into core via
  // the StoragePaths / WorkspacePolicy contract — the serverMain legacy
  // dataDir/workspaceDir pair only mirrors these members.
  const storage = getStoragePaths(paths);
  const workspace = getWorkspacePolicy(paths);
  // defaultWorkerWorkspace is user-visible and must exist before any worker
  // lands in it (§2.5: 启动自动 mkdir).
  mkdirSync(workspace.defaultWorkerWorkspace, { recursive: true });
  return {
    // Envelope store (决策九): the config load source; the CLI config path
    // is only the transitional one-time import source.
    configPath: paths.configPath,
    legacyConfigPath: paths.cliConfigPath,
    dataDir: storage.dataDir,
    logDir: storage.logDir,
    cacheDir: storage.cacheDir,
    workspaceDir: workspace.controllerWorkspace,
    defaultWorkerWorkspace: workspace.defaultWorkerWorkspace,
    session: process.env.WAYANG_DESKTOP_SESSION ?? 'new',
    logLevel: process.env.WAYANG_DESKTOP_LOG_LEVEL ?? 'info',
  };
}

export class Application {
  private logger: UnifiedLogger | null = null;
  private windows: WindowManager | null = null;
  private session: SessionService | null = null;
  /** Idempotent quit flag — before-quit can re-enter once stop() is in flight. */
  private quitting = false;

  /** Wire every process-level concern and start the app lifecycle. */
  run(): void {
    // GUI PATH fix first: agents spawned by the server resolve binaries
    // through PATH; a Finder-launched app has none.
    fixGuiPath();

    this.logger = new UnifiedLogger(initMainLogger(process.env.WAYANG_DESKTOP_LOG_LEVEL ?? 'info'));

    // A GUI shell must not die silently: surface anything that escapes a
    // handler into the log instead of an invisible default crash.
    process.on('uncaughtException', (err) => {
      this.logger?.error('uncaughtException', { error: err.stack ?? String(err) });
    });
    process.on('unhandledRejection', (reason) => {
      this.logger?.error('unhandledRejection', { error: String(reason) });
    });

    // Crash records (§2.9 UnifiedLogger): renderer and child deaths.
    app.on('render-process-gone', (_event, _contents, details) => {
      this.logger?.crash('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
    });
    app.on('child-process-gone', (_event, details) => {
      this.logger?.crash('child-process-gone', {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: 'name' in details ? String(details.name) : undefined,
      });
    });

    app.whenReady().then(() => void this.start());

    // macOS keeps the process alive with no windows (§2.9); dock icon
    // re-opens the single window.
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });
    app.on('activate', () => {
      if (process.platform === 'darwin') this.windows?.create();
    });

    app.on('before-quit', (event) => {
      if (this.quitting) return;
      this.quitting = true;
      event.preventDefault();
      void this.shutdown();
    });
  }

  /** Assemble the components once Electron is ready. */
  private async start(): Promise<void> {
    const log = this.logger as UnifiedLogger;
    const options = resolveSessionOptions();
    log.info('app ready', {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: `${process.platform}/${process.arch}`,
      ...options,
    });

    const security = new SecurityGuard();
    const windows = new WindowManager({
      security,
      statePath: join(options.dataDir, 'window-state.json'),
      log,
    });
    this.windows = windows;

    const session = new SessionService({
      getWindow: (): BrowserWindow | null => windows.window,
      options,
      log,
      isTrustedSender: (sender) => security.isTrustedSender(sender),
    });
    this.session = session;

    // Refresh replay (§2.7): a full renderer load re-sends the cached state.
    windows.onDidFinishLoad(() => session.resendSnapshot());

    windows.create();
    await session.start();
  }

  /** The Disposable exit queue: stop the server, flush the log, then quit. */
  private async shutdown(): Promise<void> {
    const log = this.logger as UnifiedLogger;
    log.info('quitting: stopping server');
    try {
      await this.session?.stop();
      log.info('server stopped');
    } catch (err) {
      log.error('server stop failed', { error: String(err) });
    }
    // Sink appends are synchronous, but close() guarantees the file is
    // quiescent before the process goes away.
    await log.close().catch(() => undefined);
    app.quit();
  }
}
