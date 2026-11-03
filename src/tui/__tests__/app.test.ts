import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { render } from 'ink';

// The Ctrl+C state machine under test lives in AppContent; stub the full
// controller page so the harness only exercises key handling.
vi.mock('@/tui/pages/controller-page', () => ({
  ControllerPage: () => null,
}));

import { App } from '@/tui/app';
import type { RemoteSupervisor } from '@/client/remote-supervisor';

/** Ctrl+C as terminals send it (the raw control code Ink parses). */
const CTRL_C = '\x03';

/**
 * Minimal RemoteSupervisor stand-in: just the surface AppContent touches —
 * a busy-flagged Subscribable controllerAgent with abort(), and shutdown().
 */
function makeSupervisor(busy: boolean) {
  const listeners = new Map<string, Set<() => void>>();
  const abort = vi.fn();
  const shutdown = vi.fn(async () => {});
  const controllerAgent = {
    getSnapshot: (path: string) => (path === 'dynamicState.busy' ? busy : undefined),
    subscribe: (path: string, cb: () => void) => {
      let set = listeners.get(path);
      if (!set) {
        set = new Set();
        listeners.set(path, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    abort,
  };
  const supervisor = {
    ctx: { workspaceDir: '/tmp/wayang-test' },
    controllerAgent,
    shutdown,
  } as unknown as RemoteSupervisor;
  return { supervisor, abort, shutdown };
}

/**
 * Render App with a fake TTY stdin/stdout (modeled on the input-area test
 * harness) and drive it with raw key sequences. Mirrors production render.ts
 * by passing exitOnCtrlC: false — Ctrl+C ownership stays with AppContent.
 */
function renderApp(options: { busy?: boolean } = {}) {
  const { supervisor, abort, shutdown } = makeSupervisor(options.busy ?? false);
  let rawFrame = '';
  const stdout = {
    columns: 80,
    rows: 200,
    // Capture EVERY write, including empty ones: with ControllerPage stubbed
    // out, the frame is empty exactly when the notice is gone — filtering
    // blank writes would keep the notice-bearing frame around forever.
    write: (s: string) => { rawFrame = s; return true; },
    on() { return stdout; },
    off() { return stdout; },
    removeListener() { return stdout; },
  };
  const readableListeners: Array<() => void> = [];
  const pending: string[] = [];
  const stdin = {
    isTTY: true,
    setEncoding() { /* noop */ },
    setRawMode() { /* noop */ },
    ref() { /* noop */ },
    unref() { /* noop */ },
    read: () => pending.shift() ?? null,
    on(evt: string, fn: () => void) { return stdin.addListener(evt, fn); },
    addListener(evt: string, fn: () => void) {
      if (evt === 'readable') readableListeners.push(fn);
      return stdin;
    },
    removeListener(evt: string, fn: () => void) {
      if (evt === 'readable') {
        const i = readableListeners.indexOf(fn);
        if (i >= 0) readableListeners.splice(i, 1);
      }
      return stdin;
    },
  };
  const app = render(
    h(App, { supervisor }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  let exited = false;
  void app.waitUntilExit().then(() => { exited = true; });
  return {
    abort,
    shutdown,
    exited: () => exited,
    frame: () => stripAnsi(rawFrame),
    send(data: string) {
      pending.push(data);
      for (const fn of [...readableListeners]) fn();
    },
    unmount: () => app.unmount(),
  };
}

/** Strip ANSI escape sequences (colors, inverse, cursor moves). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Let React flush effects and commits between keystrokes. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Real-timer wait; a sleep(1050) guarantees ≥1050ms wall time has passed. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('App Ctrl+C handling', () => {
  // Every test starts with an initial flush: ink's stdin subscription lands
  // in a React effect, so a send() before the first flush would sit unread
  // in the queue until the NEXT 'readable' event.

  it('aborts the controller turn on Ctrl+C while busy, without shutting down', async () => {
    const r = renderApp({ busy: true });
    try {
      await flush();
      r.send(CTRL_C);
      await flush();
      expect(r.abort).toHaveBeenCalledTimes(1);
      expect(r.shutdown).not.toHaveBeenCalled();
      expect(r.exited()).toBe(false);
    } finally {
      r.unmount();
    }
  });

  it('shows a notice on a single idle Ctrl+C and does not exit', async () => {
    const r = renderApp();
    try {
      await flush();
      r.send(CTRL_C);
      await flush();
      expect(r.frame()).toContain('Press Ctrl+C again to quit');
      expect(r.shutdown).not.toHaveBeenCalled();
      expect(r.exited()).toBe(false);
    } finally {
      r.unmount();
    }
  });

  it('shuts down and exits on a second idle Ctrl+C within 1s', async () => {
    const r = renderApp();
    try {
      await flush();
      r.send(CTRL_C);
      await flush();
      r.send(CTRL_C);
      await flush();
      await flush();
      expect(r.shutdown).toHaveBeenCalledTimes(1);
      expect(r.exited()).toBe(true);
    } finally {
      r.unmount();
    }
  });

  it('does not exit when the two idle Ctrl+C presses are more than 1s apart', async () => {
    const r = renderApp();
    try {
      await flush();
      r.send(CTRL_C);
      await flush();
      await sleep(1050); // window (1000ms) has definitely expired
      r.send(CTRL_C);
      await flush();
      expect(r.shutdown).not.toHaveBeenCalled();
      expect(r.exited()).toBe(false);
      // The late press re-arms: a fresh notice, not an exit.
      expect(r.frame()).toContain('Press Ctrl+C again to quit');
    } finally {
      r.unmount();
    }
  });

  it('hides the notice after the 1s window expires', async () => {
    const r = renderApp();
    try {
      await flush();
      r.send(CTRL_C);
      await flush();
      expect(r.frame()).toContain('Press Ctrl+C again to quit');
      await sleep(1050);
      await flush();
      expect(r.frame()).not.toContain('Press Ctrl+C again to quit');
    } finally {
      r.unmount();
    }
  });

  it('hides the notice on any other key, but that key does not reset the double-press window', async () => {
    const r = renderApp();
    try {
      await flush();
      r.send(CTRL_C);
      await flush();
      expect(r.frame()).toContain('Press Ctrl+C again to quit');
      r.send('x');
      await flush();
      expect(r.frame()).not.toContain('Press Ctrl+C again to quit');
      // Still within 1s of the FIRST Ctrl+C — the intervening 'x' only
      // dismissed the notice; only Ctrl+C writes the timestamp.
      r.send(CTRL_C);
      await flush();
      await flush();
      expect(r.shutdown).toHaveBeenCalledTimes(1);
      expect(r.exited()).toBe(true);
    } finally {
      r.unmount();
    }
  });
});
