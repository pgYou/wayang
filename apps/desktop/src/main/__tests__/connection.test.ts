import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { WayangConfig } from '@wayang-ai/protocol';

/**
 * Crash-resume contract tests for connectServer (§4.1 工作项④ + §2.9):
 * - ready is emitted with the session id after waitForReady succeeds;
 * - an unexpected exit (not stopping) → reconnecting → re-fork with
 *   `--session resume:<id>` → snapshot replay (GET_SNAPSHOT sweep) → ready;
 * - one-shot semantics: the second unexpected exit lands on crashed with no
 *   third fork; a resume boot that dies before ready also lands on crashed;
 * - a crash before the first ready (or an id-less ready) goes straight to
 *   crashed — no resume fork;
 * - a quit racing an in-flight reconnect is swallowed by the stopping flag.
 *
 * The fake electron module forges a UtilityProcess whose message port is
 * wired to a REAL RpcServer loopback (same protocol stack as production);
 * SUBSCRIBE / GET_SNAPSHOT / SHUTDOWN are served from fixtures, and the test
 * drives readiness and exits explicitly.
 */

const electronState = vi.hoisted(() => ({
  forkImpl: null as null | ((modulePath: string, argv: string[], options: unknown) => unknown),
  handleImpl: null as null | ((channel: string, handler: unknown) => void),
  removeImpl: null as null | ((channel: string) => void),
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (modulePath: string, argv: string[], options: unknown) => electronState.forkImpl!(modulePath, argv, options),
  },
  ipcMain: {
    handle: (channel: string, handler: unknown) => electronState.handleImpl!(channel, handler),
    removeHandler: (channel: string) => electronState.removeImpl!(channel),
  },
}));

import { connectServer, type ConnectDeps, type DesktopSessionOptions } from '../connection';
import { RpcServer } from '@wayang-ai/protocol/rpc/rpc-server';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { messagePortToStreams, type MessagePortLike } from '@wayang-ai/protocol/rpc/message-port';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';
import { makeEnvelope } from '../../shared/config-envelope';

interface FakeChild {
  postMessage(data: unknown): void;
  addListener(event: 'message', listener: (message: unknown) => void): void;
  removeListener(event: 'message', listener: (message: unknown) => void): void;
  once(event: 'exit', listener: (code: number | null) => void): void;
  kill(): void;
  stderr: PassThrough;
  stdout: PassThrough;
}

const validConfig: WayangConfig = {
  providers: {
    default: { baseURL: 'http://localhost:1234/v1', apiKey: 'test-key', modelName: 'test-model' },
  },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 2 },
};

/**
 * A fake utility child wired to a real RpcServer over the message-port
 * adapter — same framing path as production (asMessagePort on the main
 * side, structural port on the server side). Exiting closes the port: a
 * postMessage on a dead child throws, which fails the main-side transport
 * and rejects pending requests exactly like a real UtilityProcess death.
 */
class LoopbackServer {
  readonly child: FakeChild;
  readonly argv: string[] = [];
  readonly subscribeRequests: Array<{ target: string; path: string }> = [];
  readonly snapshotRequests: Array<{ target: string; path: string }> = [];
  shutdownRequests = 0;
  private readonly serverListeners = new Set<(event: { data: unknown }) => void>();
  private readonly childListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private readonly rpc: RpcServer;
  private exited = false;

  constructor(readonly sessionId: string) {
    const serverPort: MessagePortLike = {
      // child→parent frames arrive as raw payloads on the parent side.
      postMessage: (data) => {
        for (const fn of this.childListeners) fn(data);
      },
      addListener: (_event, fn) => {
        this.serverListeners.add(fn);
      },
      removeListener: (_event, fn) => {
        this.serverListeners.delete(fn);
      },
    };
    this.child = {
      // parent→child frames arrive MessageEvent-shaped on the child side.
      postMessage: (data) => {
        if (this.exited) throw new Error('port closed: child exited');
        for (const fn of this.serverListeners) fn({ data });
      },
      addListener: (_event, fn) => {
        this.childListeners.add(fn);
      },
      removeListener: (_event, fn) => {
        this.childListeners.delete(fn);
      },
      once: (event, listener) => {
        if (event !== 'exit') throw new Error(`unexpected once(${event})`);
        this.exitListeners.push(listener);
      },
      kill: () => this.emitExit(9),
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    };

    const io = messagePortToStreams(serverPort);
    this.rpc = new RpcServer(createStreamTransport(io.stdin, io.stdout));
    this.rpc.register(METHOD.SUBSCRIBE, (params) => {
      this.subscribeRequests.push({ target: String(params.target), path: String(params.path) });
      return { subscriptionId: `sub-${this.subscribeRequests.length}`, data: { fixture: true, target: params.target, path: params.path } };
    });
    this.rpc.register(METHOD.GET_SNAPSHOT, (params) => {
      this.snapshotRequests.push({ target: String(params.target), path: String(params.path) });
      return { data: { fixture: true, target: params.target, path: params.path } };
    });
    this.rpc.register(METHOD.SHUTDOWN, () => {
      this.shutdownRequests += 1;
      // Mirror the real server: a graceful shutdown ends the process.
      setImmediate(() => this.emitExit(0));
      return {};
    });
  }

  /** Announce readiness; a null id reproduces an id-less ready frame. */
  notifyReady(sessionId: string | null = this.sessionId): void {
    const params: Record<string, unknown> = { sessionDir: `/sessions/${this.sessionId}` };
    if (sessionId !== null) params.sessionId = sessionId;
    this.rpc.notify(NOTIFY.READY, params);
  }

  emitExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const fn of [...this.exitListeners]) fn(code);
  }

  writeStderr(text: string): void {
    this.child.stderr.write(text);
  }
}

describe('connectServer crash resume (§4.1 工作项④)', () => {
  let dir: string;
  let servers: LoopbackServer[];
  let statuses: Array<{ phase: string; detail?: string; sessionId?: string }>;
  let stateEvents: Array<{ target: string; path: string; data: unknown }>;
  let ipcChannels: Set<string>;
  let options: DesktopSessionOptions;
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => log, close: vi.fn(),
  };

  /** `auto` notifies ready right after fork; `manual`/`no-session-id` leave it to the test. */
  const setup = (readyMode: 'auto' | 'manual' | 'no-session-id' = 'auto'): void => {
    servers = [];
    statuses = [];
    stateEvents = [];
    ipcChannels = new Set();
    electronState.handleImpl = (channel) => ipcChannels.add(channel);
    electronState.removeImpl = (channel) => ipcChannels.delete(channel);
    electronState.forkImpl = (_modulePath, argv) => {
      const server = new LoopbackServer(`session-${servers.length + 1}`);
      (server as unknown as { argv: string[] }).argv = argv;
      servers.push(server);
      if (readyMode === 'auto') setImmediate(() => server.notifyReady());
      else if (readyMode === 'no-session-id') setImmediate(() => server.notifyReady(null));
      return server.child;
    };
  };

  const connect = () =>
    connectServer({
      getWindow: () =>
        ({
          webContents: {
            send: (_channel: string, payload: { target: string; path: string; data: unknown }) => {
              stateEvents.push(payload);
            },
          },
        }) as unknown as ReturnType<ConnectDeps['getWindow']>,
      options,
      onStatus: (phase: string, detail?: string, sessionId?: string) => statuses.push({ phase, detail, sessionId }),
      log,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wayang-connection-'));
    options = {
      configPath: join(dir, 'config.json'),
      legacyConfigPath: join(dir, '.wayang.config.json'),
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
    const conn = await connect();
    expect(statuses.map((s) => s.phase)).toEqual(['connecting', 'ready']);
    expect(statuses[1]).toMatchObject({ phase: 'ready', sessionId: 'session-1' });
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
    expect(ipcChannels.size).toBeGreaterThan(0);
    await conn.stop();
    expect(servers[0].shutdownRequests).toBe(1);
  });

  it('resumes after an unexpected exit: reconnecting → fork with resume:<id> → ready + snapshot replay', async () => {
    setup();
    const conn = await connect();
    servers[0].writeStderr('boom before exit\n');
    servers[0].emitExit(1);
    await vi.waitFor(() => {
      expect(statuses.map((s) => s.phase)).toContain('reconnecting');
    });
    // The second fork targets the SAME session (resume), not a new one.
    expect(servers.length).toBe(2);
    const resumeIdx = servers[1].argv.indexOf('--session');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(servers[1].argv[resumeIdx + 1]).toBe('resume:session-1');
    await vi.waitFor(() => {
      expect(statuses.map((s) => s.phase)).toEqual(['connecting', 'ready', 'reconnecting', 'ready']);
    });
    // Replay: every subscribed slice re-pulled via GET_SNAPSHOT and pushed
    // through wayang:state (the renderer converges on resumed state).
    await vi.waitFor(() => {
      expect(servers[1].snapshotRequests.length).toBeGreaterThanOrEqual(10);
    });
    expect(stateEvents.length).toBeGreaterThan(0);
    await conn.stop();
  });

  it('one-shot semantics: after a successful resume the next exit lands on crashed (no third fork)', async () => {
    setup();
    const conn = await connect();
    servers[0].emitExit(1);
    await vi.waitFor(() => expect(servers.length).toBe(2));
    await vi.waitFor(() => expect(statuses.some((s) => s.phase === 'ready' && s.sessionId === 'session-2')).toBe(true));
    servers[1].emitExit(1);
    await vi.waitFor(() => {
      expect(statuses.at(-1)?.phase).toBe('crashed');
    });
    expect(servers.length).toBe(2);
    expect(statuses.filter((s) => s.phase === 'crashed').length).toBe(1);
    await conn.stop();
  });

  it('a resume boot that dies before its own ready lands on crashed (still one-shot)', async () => {
    setup();
    const conn = await connect();
    // Server 2 never reports ready.
    electronState.forkImpl = (_m, argv) => {
      const server = new LoopbackServer('session-2');
      (server as unknown as { argv: string[] }).argv = argv;
      servers.push(server);
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
    await conn.stop();
  });

  it('a crash before the first ready rejects the connect promise (no resume fork)', async () => {
    setup('manual');
    const pending = connect();
    await vi.waitFor(() => expect(servers.length).toBe(1));
    servers[0].emitExit(1);
    await expect(pending).rejects.toThrow(/before becoming ready/);
    expect(servers.length).toBe(1);
    expect(statuses.map((s) => s.phase)).toEqual(['connecting']);
  });

  it('an id-less ready means no session to resume: exit goes straight to crashed', async () => {
    setup('no-session-id');
    const conn = await connect();
    expect(statuses[1].phase).toBe('ready');
    expect(statuses[1].sessionId).toBeUndefined();
    servers[0].emitExit(1);
    await vi.waitFor(() => {
      expect(statuses.at(-1)?.phase).toBe('crashed');
    });
    expect(servers.length).toBe(1);
    expect(statuses.some((s) => s.phase === 'reconnecting')).toBe(false);
    await conn.stop();
  });

  it('a quit racing an in-flight reconnect swallows the outcome (no crash status)', async () => {
    setup();
    const conn = await connect();
    servers[0].emitExit(1);
    await vi.waitFor(() => expect(servers.length).toBe(2));
    // Server 2 is still booting (no ready yet) — the user quits now.
    const stopping = conn.stop();
    servers[1].emitExit(0);
    await stopping;
    expect(statuses.some((s) => s.phase === 'crashed')).toBe(false);
    expect(statuses.some((s) => s.phase === 'reconnecting')).toBe(true);
    // The graceful-stop protocol reached the live (in-flight) child.
    expect(servers[1].shutdownRequests).toBe(1);
  });
});
