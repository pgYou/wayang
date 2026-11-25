import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WindowManager unit tests (§2.9 wiring, §2.10 additions): the single window
 * is created with the same-source mark icon from the repo assets (source
 * layout) and without one when the asset is absent (packaged app — the
 * bundle icon applies); the second-instance `focus()` path restores +
 * focuses, and no-ops without a window. Bounds persistence defaults on
 * missing/corrupt state files round out the create() surface.
 */

const { captured, FakeWindow } = vi.hoisted(() => {
  const captured = { instances: [] as FakeWindow[] };
  class FakeWindow {
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
    minimized = false;
    restored = 0;
    focused = 0;
    loadFileCalls: string[] = [];
    loadURLCalls: string[] = [];
    bounds = { x: 10, y: 20, width: 1180, height: 800 };
    readonly webContents = { on: vi.fn() };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      captured.instances.push(this);
    }

    once(event: string, listener: (event: unknown, ...args: unknown[]) => void): void {
      this.addListener(event, listener);
    }

    on(event: string, listener: (event: unknown, ...args: unknown[]) => void): void {
      this.addListener(event, listener);
    }

    addListener(event: string, listener: (event: unknown, ...args: unknown[]) => void): void {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
    }

    removeListener(event: string, listener: unknown): void {
      this.listeners.get(event)?.delete(listener as (event: unknown) => void);
    }

    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener({});
    }

    isMinimized(): boolean {
      return this.minimized;
    }

    restore(): void {
      this.restored += 1;
      this.minimized = false;
    }

    focus(): void {
      this.focused += 1;
    }

    isDestroyed(): boolean {
      return false;
    }

    loadFile(path: string): void {
      this.loadFileCalls.push(path);
    }

    loadURL(url: string): void {
      this.loadURLCalls.push(url);
    }

    getNormalBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds;
    }
  }
  return { captured, FakeWindow };
});

const { iconExists } = vi.hoisted(() => ({ iconExists: { value: true } }));

vi.mock('electron', () => ({ BrowserWindow: FakeWindow }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // Only the icon candidate goes through existsSync in the module under
  // test; everything else (state read/write) keeps the real fs.
  return {
    ...actual,
    existsSync: (path: unknown) =>
      typeof path === 'string' && path.includes('assets')
        ? iconExists.value
        : actual.existsSync(path as Parameters<typeof actual.existsSync>[0]),
  };
});

import { WindowManager } from '../window-manager';

type FakeWindowInstance = InstanceType<typeof FakeWindow>;

const security = {
  hardenedWebPreferences: vi.fn(() => ({})),
  install: vi.fn(),
  clearTrust: vi.fn(),
  isTrustedSender: vi.fn(() => true),
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), crash: vi.fn() };

function freshManager(statePath: string): WindowManager {
  return new WindowManager({ security: security as never, statePath, log: log as never });
}

describe('WindowManager (§2.9 + §2.10 icon/focus)', () => {
  let dir: string;

  beforeEach(() => {
    captured.instances.length = 0;
    iconExists.value = true;
    dir = mkdtempSync(join(tmpdir(), 'wayang-wm-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the window with the repo mark icon in the source layout (§2.10 同源资产)', () => {
    const manager = freshManager(join(dir, 'window-state.json'));
    const win = manager.create();
    const options = captured.instances[0].options;
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../');
    expect(options.icon).toBe(join(repoRoot, 'assets/logo/wayang-mark-icon-512.png'));
    expect(win).toBe(captured.instances[0]);
  });

  it('omits the icon when the mark asset is absent (packaged app → bundle icon)', () => {
    iconExists.value = false;
    freshManager(join(dir, 'window-state.json')).create();
    expect(captured.instances[0].options.icon).toBeUndefined();
  });

  it('loads the renderer from the built out/ tree (no dev server URL)', () => {
    delete process.env.ELECTRON_RENDERER_URL;
    freshManager(join(dir, 'window-state.json')).create();
    const win = captured.instances[0];
    expect(win.loadURLCalls).toEqual([]);
    expect(win.loadFileCalls).toHaveLength(1);
    expect(win.loadFileCalls[0]).toMatch(/(?:src|out)[/\\]renderer[/\\]index\.html$/);
  });

  it('focus() restores then focuses a minimized window (§2.10 second-instance)', () => {
    const manager = freshManager(join(dir, 'window-state.json'));
    manager.create();
    const win = captured.instances[0];
    win.minimized = true;
    manager.focus();
    expect(win.restored).toBe(1);
    expect(win.focused).toBe(1);
  });

  it('focus() skips restore when the window is not minimized', () => {
    const manager = freshManager(join(dir, 'window-state.json'));
    manager.create();
    manager.focus();
    const win = captured.instances[0];
    expect(win.restored).toBe(0);
    expect(win.focused).toBe(1);
  });

  it('focus() is a no-op without a live window', () => {
    const manager = freshManager(join(dir, 'window-state.json'));
    expect(() => manager.focus()).not.toThrow();
  });

  it('persists bounds on close and reloads them on the next create()', () => {
    const statePath = join(dir, 'window-state.json');
    const manager = freshManager(statePath);
    const first = manager.create() as unknown as FakeWindowInstance;
    first.bounds = { x: 5, y: 6, width: 900, height: 700 };
    first.emit('close');

    freshManager(statePath).create();
    const options = captured.instances[1].options;
    expect(options.width).toBe(900);
    expect(options.height).toBe(700);
    expect(options.x).toBe(5);
    expect(options.y).toBe(6);
  });

  it('falls back to default bounds when the state file is corrupt', () => {
    const statePath = join(dir, 'window-state.json');
    writeFileSync(statePath, '{not json', 'utf-8');
    freshManager(statePath).create();
    const options = captured.instances[0].options;
    expect(options.width).toBe(1180);
    expect(options.height).toBe(800);
    expect(options.x).toBeUndefined();
  });
});
