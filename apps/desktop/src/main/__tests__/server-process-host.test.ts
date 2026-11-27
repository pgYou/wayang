import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WayangConfig } from '@wayang-ai/protocol';

/**
 * ServerProcessHost state-machine tests (§2.9, 4.2 域二工作项④) — the
 * migrated crash-resume regression baseline (formerly connection.test.ts)
 * plus the domain-two upgrades:
 * - ready is emitted with the session id after waitForReady succeeds;
 * - an unexpected exit of a READY server → degraded (renderer sees
 *   `reconnecting`) → backoff → restart fork with `--session resume:<id>` →
 *   snapshot replay → ready; the attempt counter resets on success;
 * - consecutive failures up to maxAttempts land on `fatal` with the stderr
 *   tail, no further forks;
 * - a crash before the first ready (or an id-less ready) goes straight to
 *   fatal — no resume fork;
 * - a quit racing an in-flight restart is swallowed by the stopping flag;
 * - the switch path gracefully stops the current server, boots
 *   `resume:<target>`, replays, and never counts against the backoff.
 *
 * The fake electron module forges a UtilityProcess whose message port is
 * wired to a REAL RpcServer loopback (same protocol stack as production);
 * SUBSCRIBE / GET_SNAPSHOT / SHUTDOWN are served from fixtures, and the test
 * drives readiness and exits explicitly.
 */

const electronState = vi.hoisted(() => ({
  forkImpl: null as null | ((modulePath: string, argv: string[], options: unknown) => unknown),
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (modulePath: string, argv: string[], options: unknown) => electronState.forkImpl!(modulePath, argv, options),
  },
}));

import { ServerProcessHost, type BackoffPolicy, type HostSessionOptions } from '../server-process-host';
import { SLICE } from '../../shared/ipc-contract';
import { makeEnvelope } from '../../shared/config-envelope';
import { LoopbackServer } from './helpers/loopback-server';
import type { MainLogger } from '../logger';

// The canonical shape (models + model references) — the only form the desktop passes to the host.
const validConfig: WayangConfig = {
  providers: {
    default: { baseURL: 'http://localhost:1234/v1', apiKey: 'test-key' },
  },
  models: {
    default: { provider: 'default', name: 'test-model' },
  },
  controller: { model: 'default' },
  worker: { model: 'default', maxConcurrency: 2 },
};

/** Tight backoff so self-heal cycles run in milliseconds. */
const testBackoff = (over: Partial<BackoffPolicy> = {}): BackoffPolicy => ({
  initialDelayMs: 5,
  multiplier: 2,
  maxDelayMs: 50,
  maxAttempts: 2,
  ...over,
});

describe('ServerProcessHost state machine (§2.9, 4.2 工作项④)', () => {
  let dir: string;
  let servers: LoopbackServer[];
  let statuses: Array<{ phase: string; detail?: string; sessionId?: string }>;
  let stateEvents: Array<{ target: string; path: string; data: unknown }>;
  let options: HostSessionOptions;
  const log: MainLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => log, close: vi.fn(),
  };

  /** `auto` notifies ready right after fork; `manual`/`no-session-id` leave it to the test. */
  const setup = (readyMode: 'auto' | 'manual' | 'no-session-id' = 'auto'): void => {
    servers = [];
    statuses = [];
    stateEvents = [];
    electronState.forkImpl = (_modulePath, argv) => {
      const server = new LoopbackServer(`session-${servers.length + 1}`);
      (server as unknown as { argv: string[] }).argv = argv;
      servers.push(server);
      if (readyMode === 'auto') setImmediate(() => server.notifyReady());
      else if (readyMode === 'no-session-id') setImmediate(() => server.notifyReady(null));
      return server.child;
    };
  };

  const makeHost = (backoff?: BackoffPolicy): ServerProcessHost =>
    new ServerProcessHost({
      options,
      config: validConfig,
      onStatus: (phase, detail, sessionId) => statuses.push({ phase, detail, sessionId }),
      sendState: (payload) => stateEvents.push(payload),
      log,
      backoff,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wayang-host-'));
    options = {
      configPath: join(dir, 'config.json'),
      dataDir: join(dir, 'data'),
      logDir: join(dir, 'logs'),
      cacheDir: join(dir, 'caches'),
      workspaceDir: join(dir, 'workspace'),
      defaultWorkerWorkspace: join(dir, 'agents-workspace'),
      session: 'new',
      logLevel: 'info',
    };
    writeFileSync(options.configPath, JSON.stringify(makeEnvelope(validConfig)));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits ready with the session id and subscribes the live task path', async () => {
    setup();
    const host = makeHost();
    await host.start();
    expect(statuses).toEqual([{ phase: 'ready', sessionId: 'session-1' }]);
    expect(host.currentPhase).toBe('ready');
    expect(host.currentSessionId).toBe('session-1');
    // The full slice set is subscribed; tasks.history (not the dead
    // tasks.completed) is among them.
    const paths = servers[0].subscribeRequests.map((r) => `${r.target}:${r.path}`);
    expect(paths).toContain('engine:tasks.history');
    expect(paths).not.toContain('engine:tasks.completed');
    // The explicit injection surface travels in the fork argv (§2.5).
    expect(servers[0].argv).toEqual(expect.arrayContaining([
      '--data-dir', options.dataDir,
      '--log-dir', options.logDir,
      '--cache-dir', options.cacheDir,
      '--default-worker-workspace', options.defaultWorkerWorkspace,
    ]));
    await host.stop();
    expect(servers[0].shutdownRequests).toBe(1);
    expect(host.currentPhase).toBe('stopped');
  });

  it('resumes after an unexpected exit: reconnecting → fork with resume:<id> → ready + snapshot replay', async () => {
    setup();
    const host = makeHost(testBackoff());
    await host.start();
    servers[0].writeStderr('boom before exit\n');
    servers[0].emitExit(1);
    await vi.waitFor(() => {
      expect(statuses.map((s) => s.phase)).toContain('reconnecting');
    });
    // The restart fork targets the SAME session (resume), not a new one.
    expect(servers.length).toBe(2);
    const resumeIdx = servers[1].argv.indexOf('--session');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(servers[1].argv[resumeIdx + 1]).toBe('resume:session-1');
    await vi.waitFor(() => {
      expect(statuses.map((s) => s.phase)).toEqual(['ready', 'reconnecting', 'ready']);
    });
    expect(host.currentPhase).toBe('ready');
    // Replay: every subscribed slice re-pulled via GET_SNAPSHOT and pushed
    // through the state channel (the renderer converges on resumed state).
    await vi.waitFor(() => {
      expect(servers[1].snapshotRequests.length).toBeGreaterThanOrEqual(10);
    });
    expect(stateEvents.length).toBeGreaterThan(0);
    await host.stop();
  });

  it('the backoff delay is honored before the restart fork (not a hot loop)', async () => {
    setup();
    const host = makeHost(testBackoff({ initialDelayMs: 40, maxAttempts: 1 }));
    await host.start();
    const before = Date.now();
    servers[0].emitExit(1);
    await vi.waitFor(() => expect(servers.length).toBe(2));
    // The first restart waits at least the initial backoff delay.
    expect(Date.now() - before).toBeGreaterThanOrEqual(40);
    await host.stop();
  });

  it('consecutive failures hit the attempt budget and land on fatal (no further forks)', async () => {
    setup();
    const host = makeHost(testBackoff({ maxAttempts: 3 }));
    await host.start();
    // Every restart also becomes ready, then dies again — each success
    // resets the counter, so exhausting the budget needs back-to-back
    // failures. Kill each restart BEFORE its ready instead.
    let forkCount = 1;
    electronState.forkImpl = (_m, argv) => {
      forkCount += 1;
      const server = new LoopbackServer(`session-${forkCount}`);
      (server as unknown as { argv: string[] }).argv = argv;
      servers.push(server);
      // Never ready: dies right away — a failed restart attempt.
      setImmediate(() => server.emitExit(1));
      return server.child;
    };
    servers[0].emitExit(1);
    await vi.waitFor(() => {
      expect(statuses.at(-1)?.phase).toBe('crashed');
    });
    // Initial fork + maxAttempts restarts, then stop for good.
    expect(servers.length).toBe(1 + 3);
    // One reconnecting per restart attempt, numbered, then fatal.
    const reconnects = statuses.filter((s) => s.phase === 'reconnecting');
    expect(reconnects.map((s) => s.detail)).toEqual([
      expect.stringContaining('attempt 1/3'),
      expect.stringContaining('attempt 2/3'),
      expect.stringContaining('attempt 3/3'),
    ]);
    expect(statuses.at(-1)?.phase).toBe('crashed');
    expect(host.currentPhase).toBe('fatal');
    expect(host.supervisor).toBeUndefined();
    await host.stop();
  });

  it('a successful ready resets the attempt budget (self-heal keeps working across cycles)', async () => {
    setup();
    const host = makeHost(testBackoff({ maxAttempts: 2 }));
    await host.start();
    // Cycle 1: crash → resume (ready again, budget reset).
    servers[0].emitExit(1);
    await vi.waitFor(() => expect(servers.length).toBe(2));
    await vi.waitFor(() => expect(statuses.some((s) => s.phase === 'ready' && s.sessionId === 'session-2')).toBe(true));
    // Cycle 2: crash again → the budget was NOT consumed by cycle 1.
    servers[1].emitExit(1);
    await vi.waitFor(() => expect(servers.length).toBe(3));
    await vi.waitFor(() => {
      expect(statuses.map((s) => s.phase)).toEqual(['ready', 'reconnecting', 'ready', 'reconnecting', 'ready']);
    });
    expect(host.currentPhase).toBe('ready');
    await host.stop();
  });

  it('a restart boot that dies before its own ready counts as a failed attempt and reaches fatal within the budget', async () => {
    setup();
    const host = makeHost(testBackoff({ maxAttempts: 1 }));
    await host.start();
    electronState.forkImpl = (_m, argv) => {
      const server = new LoopbackServer('session-2');
      (server as unknown as { argv: string[] }).argv = argv;
      servers.push(server);
      // Never reports ready.
      return server.child;
    };
    servers[0].emitExit(1);
    await vi.waitFor(() => expect(servers.length).toBe(2));
    servers[1].emitExit(1);
    await vi.waitFor(() => {
      expect(statuses.at(-1)?.phase).toBe('crashed');
    });
    expect(servers.length).toBe(2);
    expect(statuses.at(-1)?.detail).toMatch(/before becoming ready/);
    expect(host.currentPhase).toBe('fatal');
    await host.stop();
  });

  it('a crash before the first ready settles on fatal and rejects start (no resume fork)', async () => {
    setup('manual');
    const host = makeHost();
    const pending = host.start();
    await vi.waitFor(() => expect(servers.length).toBe(1));
    servers[0].emitExit(1);
    await expect(pending).rejects.toThrow(/before becoming ready/);
    expect(servers.length).toBe(1);
    // The host reports the terminal phase itself (SessionService only logs).
    expect(statuses.map((s) => s.phase)).toEqual(['crashed']);
    expect(host.currentPhase).toBe('fatal');
  });

  it('an id-less ready means no session to resume: exit goes straight to fatal', async () => {
    setup('no-session-id');
    const host = makeHost();
    await host.start();
    expect(statuses[0].phase).toBe('ready');
    expect(statuses[0].sessionId).toBeUndefined();
    servers[0].emitExit(1);
    await vi.waitFor(() => {
      expect(statuses.at(-1)?.phase).toBe('crashed');
    });
    expect(servers.length).toBe(1);
    expect(statuses.some((s) => s.phase === 'reconnecting')).toBe(false);
    expect(host.currentPhase).toBe('fatal');
    await host.stop();
  });

  it('a quit racing an in-flight restart swallows the outcome (no crash status)', async () => {
    setup();
    const host = makeHost(testBackoff());
    await host.start();
    servers[0].emitExit(1);
    await vi.waitFor(() => expect(servers.length).toBe(2));
    // Server 2 is still booting (no ready yet) — the user quits now.
    const stopping = host.stop();
    servers[1].emitExit(0);
    await stopping;
    expect(statuses.some((s) => s.phase === 'crashed')).toBe(false);
    expect(statuses.some((s) => s.phase === 'reconnecting')).toBe(true);
    // The graceful-stop protocol reached the live (in-flight) child.
    expect(servers[1].shutdownRequests).toBe(1);
  });

  it('switchSession: graceful stop → resume:<target> boot → ready + replay, never degraded and never counted against the backoff', async () => {
    setup();
    const host = makeHost(testBackoff({ maxAttempts: 1 }));
    await host.start();
    await host.switchSession('resume:target-9');
    // The current server was gracefully stopped (session state preserved).
    expect(servers[0].shutdownRequests).toBe(1);
    // The new fork boots the TARGET session.
    expect(servers.length).toBe(2);
    const sessionIdx = servers[1].argv.indexOf('--session');
    expect(servers[1].argv[sessionIdx + 1]).toBe('resume:target-9');
    // User action: connecting → ready, no reconnecting, no crashed, no fatal.
    expect(statuses.map((s) => s.phase)).toEqual(['ready', 'connecting', 'ready']);
    expect(host.currentPhase).toBe('ready');
    expect(host.currentSessionId).toBe('session-2');
    // Snapshot replay restored the target session's slices.
    await vi.waitFor(() => {
      expect(servers[1].snapshotRequests.length).toBeGreaterThanOrEqual(10);
    });
    await host.stop();
  });

  it('switchSession failure lands on fatal with a precise message (no self-heal forks)', async () => {
    setup();
    const host = makeHost(testBackoff({ maxAttempts: 3 }));
    await host.start();
    // The switch target dies before ready.
    electronState.forkImpl = (_m, argv) => {
      const server = new LoopbackServer('session-2');
      (server as unknown as { argv: string[] }).argv = argv;
      servers.push(server);
      setImmediate(() => server.emitExit(1));
      return server.child;
    };
    await expect(host.switchSession('resume:missing')).rejects.toThrow(/switch to resume:missing failed/);
    expect(host.currentPhase).toBe('fatal');
    expect(statuses.at(-1)?.phase).toBe('crashed');
    // A failed switch is NOT a self-heal episode: no further forks.
    expect(servers.length).toBe(2);
  });

  it('getSnapshotSlices returns every subscribed slice; rejects without a live server', async () => {
    setup();
    const host = makeHost();
    await expect(host.getSnapshotSlices()).rejects.toThrow(/no live server/);
    await host.start();
    const slices = await host.getSnapshotSlices();
    expect(Object.keys(slices).sort()).toEqual([...Object.values(SLICE)].sort());
    expect(slices[SLICE.tasksHistory]).toMatchObject({ target: 'engine', path: 'tasks.history' });
  });

  it('resendSnapshot re-pushes the cached slices through the state channel (refresh replay)', async () => {
    setup();
    const host = makeHost();
    await host.start();
    // The SUBSCRIBE handshake seeds the main-side cache (one event per slice).
    await vi.waitFor(() => expect(stateEvents.length).toBeGreaterThanOrEqual(10));
    const before = stateEvents.length;
    host.resendSnapshot();
    expect(stateEvents.length).toBe(before + 10);
    await host.stop();
  });
});
