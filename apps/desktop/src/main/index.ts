/**
 * Wayang desktop — main process shell.
 *
 * Responsibilities (and nothing else):
 *   - GUI PATH fix, before any child process is spawned (agents spawned by the
 *     server resolve binaries through PATH; a Finder-launched app has none).
 *   - Window + preload wiring; renderer talks to the server only via IPC.
 *   - Session defaults, all sourced from the platform config module
 *     (§2.5/§2.6: data under userData, workspaces per the baseline; the
 *     WAYANG_DESKTOP_* env group is the dev override entry).
 *   - Server lifecycle: connect on ready, graceful stop on quit.
 */

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { connectServer, type DesktopConnection } from './connection';
import { initMainLogger, mainLogger, type MainLogger } from './logger';
import { getPaths, getPlatformConfig, getStoragePaths, getWorkspacePolicy } from '../shared/platform-config';

/** Prepend the paths a GUI-launched process misses (brew, local bin). */
function fixGuiPath(): void {
  const parts = process.env.PATH?.split(':') ?? [];
  process.env.PATH = [...new Set([...getPlatformConfig().guiPathPrefixes, ...parts])].join(':');
}

interface SessionOptions {
  configPath: string;
  legacyConfigPath: string;
  dataDir: string;
  logDir: string;
  cacheDir: string;
  workspaceDir: string;
  defaultWorkerWorkspace: string;
  session: string;
  logLevel: string;
}

function resolveSessionOptions(): SessionOptions {
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

let mainWindow: BrowserWindow | null = null;
let connection: DesktopConnection | null = null;
let stopping = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Wayang',
    backgroundColor: '#f7f9fc',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  fixGuiPath();
  const log = initMainLogger(process.env.WAYANG_DESKTOP_LOG_LEVEL ?? 'info');

  // A GUI shell must not die silently: surface anything that escapes a
  // handler into the log instead of an invisible default crash.
  process.on('uncaughtException', (err) => log.error('uncaughtException', { error: err.stack ?? String(err) }));
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', { error: String(reason) }));

  const options = resolveSessionOptions();
  log.info('app ready', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    ...options,
  });

  createWindow();
  const sendStatus = (phase: string, detail?: string, sessionId?: string): void => {
    if (phase === 'crashed') log.error('connection crashed', { detail: detail?.slice(0, 2000) });
    else log.info(`connection ${phase}`, sessionId !== undefined ? { sessionId } : undefined);
    mainWindow?.webContents.send('wayang:status', { phase, detail, sessionId });
  };
  connectServer({
    getWindow: () => mainWindow,
    options,
    onStatus: sendStatus,
    log,
  }).then((conn) => {
    connection = conn;
  }).catch((err: unknown) => {
    // waitForReady rejection (timeout / early exit): the renderer must leave
    // the "connecting" state and the failure must outlive the process.
    const message = err instanceof Error ? err.message : String(err);
    log.error('connect failed', { error: message });
    sendStatus('crashed', message);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (stopping || !connection) return;
  stopping = true;
  event.preventDefault();
  const log: MainLogger = mainLogger();
  log.info('quitting: stopping server');
  void connection.stop()
    .then(() => log.info('server stopped'))
    .catch((err: unknown) => log.error('server stop failed', { error: String(err) }))
    .finally(() => {
      connection = null;
      // Sink appends are synchronous, but close() guarantees the file is
      // quiescent before the process goes away.
      void log.close().finally(() => app.quit());
    });
});
