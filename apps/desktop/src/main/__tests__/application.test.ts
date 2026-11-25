import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Application wiring tests (§2.9 + §2.10 second-instance): the assembly root
 * registers the `second-instance` handler that focuses the single window
 * (no-op before the window exists), and the before-quit Disposable queue
 * stops the server, closes the log, then quits.
 */

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'wayang-app-'));
  return {
    app: {
      whenReady: () => Promise.resolve(),
      on: (name: string, handler: (event: unknown, ...args: unknown[]) => void) => {
        electronState.handlers.set(name, handler);
      },
      quit: vi.fn(),
      getVersion: () => '1.0.0-alpha.1',
      getPath: (name: string) => join(root, name),
      getName: () => 'wayang-desktop-test',
    },
  };
});

vi.mock('../logger', () => ({
  initMainLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock('../unified-logger', () => ({
  UnifiedLogger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    crash = vi.fn();
    close = vi.fn(() => Promise.resolve());
  },
}));

const windowsState = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock('../window-manager', () => ({
  WindowManager: class {
    create = vi.fn();
    focus = vi.fn();
    onDidFinishLoad = vi.fn(() => () => undefined);
    window = null;
    constructor() {
      windowsState.instances.push(this);
    }
  },
}));

vi.mock('../security-guard', () => ({
  SecurityGuard: class {
    hardenedWebPreferences = vi.fn(() => ({}));
    install = vi.fn();
    clearTrust = vi.fn();
    isTrustedSender = vi.fn(() => true);
  },
}));

const sessionState = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock('../session-service', () => ({
  SessionService: class {
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    resendSnapshot = vi.fn();
    constructor() {
      sessionState.instances.push(this);
    }
  },
}));

vi.mock('../config-store', () => ({
  ConfigStore: class {
    load = vi.fn(async () => null);
  },
}));

import { Application } from '../application';

/** Let the whenReady → start() promise chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('Application (§2.9 assembly + §2.10 second-instance)', () => {
  beforeEach(() => {
    vi.resetModules();
    electronState.handlers.clear();
    windowsState.instances.length = 0;
    sessionState.instances.length = 0;
  });

  it('registers the second-instance handler at run()', () => {
    new Application().run();
    expect(electronState.handlers.has('second-instance')).toBe(true);
  });

  it('a second-instance event focuses the single window after boot', async () => {
    new Application().run();
    await flush();
    expect(windowsState.instances).toHaveLength(1);
    const windows = windowsState.instances[0] as { focus: ReturnType<typeof vi.fn> };

    electronState.handlers.get('second-instance')!({});
    expect(windows.focus).toHaveBeenCalledTimes(1);
  });

  it('a second-instance event before the window exists is a no-op', async () => {
    new Application().run();
    // No flush: the handler fires before start() created the window.
    expect(() => electronState.handlers.get('second-instance')!({})).not.toThrow();
    await flush();
    const windows = windowsState.instances[0] as { focus: ReturnType<typeof vi.fn> };
    expect(windows.focus).not.toHaveBeenCalled();
  });

  it('boot assembles the components and starts the session (onboard mode)', async () => {
    new Application().run();
    await flush();
    expect(windowsState.instances).toHaveLength(1);
    expect(sessionState.instances).toHaveLength(1);
    const session = sessionState.instances[0] as { start: ReturnType<typeof vi.fn> };
    // Envelope load returns null → onboard mode → server not started yet.
    expect(session.start).toHaveBeenCalledWith(null);
  });

  it('before-quit runs the Disposable queue: stop server → close log → quit', async () => {
    new Application().run();
    await flush();
    const session = sessionState.instances[0] as { stop: ReturnType<typeof vi.fn> };
    const preventDefault = vi.fn();

    electronState.handlers.get('before-quit')!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await flush();
    expect(session.stop).toHaveBeenCalledTimes(1);
  });
});
