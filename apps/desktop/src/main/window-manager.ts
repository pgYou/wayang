/**
 * WindowManager (desktop-app-design §2.9, 4.2 域二工作项②).
 *
 * The SINGLE window manager (no second BrowserWindow — 单窗口多会话, §1):
 * window creation with hardened preferences (via SecurityGuard), bounds
 * persistence under `<dataDir>/window-state.json` (§2.5), `ready-to-show`
 * anti-flash (防白屏), and the `did-finish-load` hook the refresh replay
 * path listens to (§2.7).
 */

import { BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SecurityGuard } from './security-guard';
import type { UnifiedLogger } from './unified-logger';

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const DEFAULT_STATE: WindowState = { width: 1180, height: 800 };
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

export interface WindowManagerDeps {
  security: SecurityGuard;
  /** Full path of the bounds file (`<dataDir>/window-state.json`, §2.5). */
  statePath: string;
  log: UnifiedLogger;
}

export class WindowManager {
  private win: BrowserWindow | null = null;
  private readonly finishLoadListeners = new Set<() => void>();

  constructor(private readonly deps: WindowManagerDeps) {}

  /** Create (or return the existing) single window. */
  create(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const state = this.loadState();
    const win = new BrowserWindow({
      width: state.width,
      height: state.height,
      ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'Wayang',
      backgroundColor: '#f7f9fc',
      // Hardened preferences come from the single definition (§2.9).
      webPreferences: this.deps.security.hardenedWebPreferences(join(__dirname, '../preload/index.js')),
      // Hidden until the renderer painted — no white flash on cold start.
      show: false,
    });
    this.deps.security.install(win);
    win.once('ready-to-show', () => win.show());

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    // Refresh replay path (§2.7): every full load re-sends the cached state.
    win.webContents.on('did-finish-load', () => {
      for (const listener of this.finishLoadListeners) listener();
    });
    win.on('close', () => this.saveState(win));
    win.on('closed', () => {
      this.win = null;
      this.deps.security.clearTrust();
    });
    this.win = win;
    return win;
  }

  /** The live single window, or null. */
  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** Subscribe to full renderer loads (initial + refresh). Returns unsubscribe. */
  onDidFinishLoad(listener: () => void): () => void {
    this.finishLoadListeners.add(listener);
    return () => this.finishLoadListeners.delete(listener);
  }

  private loadState(): WindowState {
    try {
      const raw = JSON.parse(readFileSync(this.deps.statePath, 'utf-8')) as Partial<WindowState>;
      if (
        typeof raw.width !== 'number' || typeof raw.height !== 'number' ||
        raw.width < MIN_WIDTH || raw.height < MIN_HEIGHT ||
        raw.width > 16384 || raw.height > 16384
      ) {
        return { ...DEFAULT_STATE };
      }
      return {
        width: raw.width,
        height: raw.height,
        ...(typeof raw.x === 'number' && typeof raw.y === 'number' ? { x: raw.x, y: raw.y } : {}),
      };
    } catch {
      // Missing or corrupt state file — defaults.
      return { ...DEFAULT_STATE };
    }
  }

  private saveState(win: BrowserWindow): void {
    try {
      const bounds = win.getNormalBounds();
      const state: WindowState = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
      mkdirSync(dirname(this.deps.statePath), { recursive: true });
      writeFileSync(this.deps.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    } catch (err) {
      this.deps.log.warn('window state persistence failed', { error: String(err) });
    }
  }
}
