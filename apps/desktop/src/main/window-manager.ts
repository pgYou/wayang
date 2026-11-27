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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Window icon source (§2.10): the repo's single mark asset — same png that
 * electron-builder converts into the bundle `.icns`. Resolved from the source
 * tree only (from `<package>/src|out/main`, four segments up reach the repo
 * root where `assets/logo` lives); the packaged mac app takes its window icon
 * from the bundle, so no icon copy is ever scattered into the app.
 */
function resolveWindowIcon(): string | undefined {
  const candidate = join(__dirname, '../../../../assets/logo/wayang-mark-icon-512.png');
  return existsSync(candidate) ? candidate : undefined;
}

export interface WindowManagerDeps {
  security: SecurityGuard;
  /** Full path of the bounds file (`<dataDir>/window-state.json`, §2.5). */
  statePath: string;
  log: UnifiedLogger;
}

export class WindowManager {
  private win: BrowserWindow | null = null;
  private readonly finishLoadListeners = new Set<() => void>();
  private readonly fullScreenListeners = new Set<(fullscreen: boolean) => void>();

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
      // Custom header (§2.1): no native title bar — the renderer draws the
      // 48px header with its own drag region (`-webkit-app-region`).
      // `hidden` KEEPS the system traffic lights: they are system-drawn
      // (macOS 27 gradient, group-hover glyphs, inactive dimming, a11y) and
      // overlay the web content at the top-left — the single-header pattern
      // (no second bar). `trafficLightPosition` insets the dots 16px and
      // lifts them 2px above the strict center (y 16 → center 22): the W
      // logo's ink is upper-heavy, so the dots sit slightly high to look
      // optically aligned with it.
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 16 },
      // Same-source mark asset (§2.10); absent in the packaged app, where the
      // bundle icon applies.
      icon: resolveWindowIcon(),
      // Hardened preferences come from the single definition (§2.9).
      webPreferences: this.deps.security.hardenedWebPreferences(join(__dirname, '../preload/index.js')),
      // Hidden until the renderer painted — no white flash on cold start.
      show: false,
    });
    this.deps.security.install(win);
    win.once('ready-to-show', () => win.show());

    if (process.env.ELECTRON_RENDERER_URL) {
      // 多入口 dev server：主窗口在 /main-window/ 路由下。
      const base = process.env.ELECTRON_RENDERER_URL;
      void win.loadURL(`${base.endsWith('/') ? base : `${base}/`}main-window/`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/main-window/index.html'));
    }

    // Refresh replay path (§2.7): every full load re-sends the cached state.
    win.webContents.on('did-finish-load', () => {
      for (const listener of this.finishLoadListeners) listener();
    });
    // Native fullscreen transitions (§2.1 custom header): macOS hides the
    // traffic lights in fullscreen — the renderer collapses the spacer.
    win.on('enter-full-screen', () => this.notifyFullScreen(true));
    win.on('leave-full-screen', () => this.notifyFullScreen(false));
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

  /**
   * Bring the single window back to the front — the second-instance focus
   * path (§2.10): the lock holder surfaces its window when a duplicate
   * launch is rejected. No-op while no window exists.
   */
  focus(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  /* ------------------- custom-header window controls ------------------- */

  /** Minimize to the dock/taskbar (§2.1 header 最小化). No-op without a window. */
  minimize(): void {
    this.window?.minimize();
  }

  /**
   * Green traffic-light action (§2.1 header): macOS uses the system
   * fullscreen semantics (绿=全屏); the other platforms maximize/unmaximize
   * (their window model). No-op without a window.
   */
  toggleZoom(): void {
    const win = this.window;
    if (!win) return;
    if (process.platform === 'darwin') {
      win.setFullScreen(!win.isFullScreen());
    } else if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }

  /** Close the single window (macOS: hide, the app lives on in the dock). */
  close(): void {
    this.window?.close();
  }

  /** Subscribe to full renderer loads (initial + refresh). Returns unsubscribe. */
  onDidFinishLoad(listener: () => void): () => void {
    this.finishLoadListeners.add(listener);
    return () => this.finishLoadListeners.delete(listener);
  }

  /**
   * Subscribe to native fullscreen transitions (enter/leave). Returns
   * unsubscribe. No events without a live window (the window is the source).
   */
  onFullScreenChange(listener: (fullscreen: boolean) => void): () => void {
    this.fullScreenListeners.add(listener);
    return () => this.fullScreenListeners.delete(listener);
  }

  private notifyFullScreen(fullscreen: boolean): void {
    for (const listener of this.fullScreenListeners) listener(fullscreen);
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
