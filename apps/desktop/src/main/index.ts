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
  createWindow();
  const sendStatus = (phase: string, detail?: string): void => {
    mainWindow?.webContents.send('wayang:status', { phase, detail });
  };
  connectServer({
    getWindow: () => mainWindow,
    options: resolveSessionOptions(),
    onStatus: sendStatus,
  }).then((conn) => {
    connection = conn;
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (stopping || !connection) return;
  stopping = true;
  event.preventDefault();
  void connection.stop().finally(() => {
    connection = null;
    app.quit();
  });
});
