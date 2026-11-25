import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Single-instance gate tests (§2.10/§5, 4.4 域四): the bootstrap's first
 * Electron call is `requestSingleInstanceLock` — the second instance quits
 * before any Application (window, server) boots; the lock holder runs the
 * full bootstrap.
 */

const gate = vi.hoisted(() => ({
  lock: true,
  lockCalls: 0,
  quit: vi.fn(),
  constructed: 0,
  runCalls: 0,
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => {
      gate.lockCalls += 1;
      return gate.lock;
    },
    quit: (...args: unknown[]) => gate.quit(...args),
  },
}));

vi.mock('../application', () => ({
  Application: class {
    constructor() {
      gate.constructed += 1;
    }
    run(): void {
      gate.runCalls += 1;
    }
  },
}));

describe('single-instance gate (index.ts bootstrap, §2.10)', () => {
  beforeEach(() => {
    vi.resetModules();
    gate.lock = true;
    gate.lockCalls = 0;
    gate.quit.mockClear();
    gate.constructed = 0;
    gate.runCalls = 0;
  });

  it('requests the lock as the first Electron call of the process', async () => {
    await import('../index');
    expect(gate.lockCalls).toBe(1);
  });

  it('quits a second instance before any Application boots', async () => {
    gate.lock = false;
    await import('../index');
    expect(gate.quit).toHaveBeenCalledTimes(1);
    expect(gate.constructed).toBe(0);
    expect(gate.runCalls).toBe(0);
  });

  it('runs the Application when the lock is held', async () => {
    await import('../index');
    expect(gate.quit).not.toHaveBeenCalled();
    expect(gate.constructed).toBe(1);
    expect(gate.runCalls).toBe(1);
  });
});
