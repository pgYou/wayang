/**
 * Wayang desktop — main process shell.
 *
 * Responsibilities (and nothing else):
 *   - GUI PATH fix, before any child process is spawned (agents spawned by the
 *     server resolve binaries through PATH; a Finder-launched app has none).
 *   - Window + preload wiring; renderer talks to the server only via IPC.
 *   - Session defaults (config/data dir shared with the CLI; workspace dir
 *     dedicated to the desktop app unless WAYANG_DESKTOP_WORKSPACE overrides).
 *   - Server lifecycle: connect on ready, graceful stop on quit.
 */

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { connectServer, type DesktopConnection } from './connection';
import { initMainLogger, mainLogger, type MainLogger } from './logger';

/** Prepend the paths a GUI-launched process misses (brew, local bin). */
function fixGuiPath(): void {
  const extras = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
  ];
  const parts = process.env.PATH?.split(':') ?? [];
  process.env.PATH = [...new Set([...extras, ...parts])].join(':');
}

interface SessionOptions {
  configPath: string;
  dataDir: string;
  workspaceDir: string;
  session: string;
  logLevel: string;
}

function resolveSessionOptions(): SessionOptions {
  const home = homedir();
  const configPath = join(home, '.wayang.config.json');
  if (!existsSync(configPath)) {
    // Surfaced to the renderer as a crashed/blocked status; the server itself
    // would fail config loading — fail early with an actionable message.
    console.error(`[wayang-desktop] config not found: ${configPath}`);
  }
  const workspaceDir = process.env.WAYANG_DESKTOP_WORKSPACE ?? join(home, 'wayang-desktop');
  mkdirSync(workspaceDir, { recursive: true });
  return {
    configPath,
    dataDir: join(home, '.wayang'),
    workspaceDir,
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
    configFound: existsSync(options.configPath),
  });

  createWindow();
  const sendStatus = (phase: string, detail?: string): void => {
    if (phase === 'crashed') log.error('connection crashed', { detail: detail?.slice(0, 2000) });
    else log.info(`connection ${phase}`);
    mainWindow?.webContents.send('wayang:status', { phase, detail });
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
