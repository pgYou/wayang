import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WayangConfig } from '@wayang-ai/protocol';

/**
 * SessionService wiring tests (§2.2/§2.9, 4.2 域二工作项①②⑤): the typed IPC
 * surface, the renderer forwarding, the initial-status sequence, the
 * getInitialState snapshot, the session index channel and the switch
 * validation — all against the REAL ServerProcessHost + loopback server
 * (integration, not mocks).
 */

const electronState = vi.hoisted(() => ({
  forkImpl: null as null | ((modulePath: string, argv: string[], options: unknown) => unknown),
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (modulePath: string, argv: string[], options: unknown) => electronState.forkImpl!(modulePath, argv, options),
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      electronState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      electronState.handlers.delete(channel);
    },
  },
}));

import { SessionService, type DesktopSessionOptions } from '../session-service';
import { IPC, IPC_INVOKE_CHANNELS, IPC_SUBSCRIBE, SLICE } from '../../shared/ipc-contract';
import { LoopbackServer } from './helpers/loopback-server';
import { makeEnvelope } from '../../shared/config-envelope';
import type { MainLogger } from '../logger';
import type { UnifiedLogger } from '../unified-logger';

const validConfig: WayangConfig = {
  providers: {
    default: { baseURL: 'http://localhost:1234/v1', apiKey: 'test-key', modelName: 'test-model' },
  },
  controller: { provider: 'default' },
  worker: { provider: 'default', maxConcurrency: 2 },
};

interface SentPayload {
  channel: string;
  payload: unknown;
}

describe('SessionService (§2.2 typed surface + §2.9 wiring)', () => {
  let dir: string;
  let servers: LoopbackServer[];
  let sent: SentPayload[];
  let options: DesktopSessionOptions;
  const log: MainLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => log, close: vi.fn(),
  };
  const rendererSink = vi.fn();
  const unifiedLog = {
    debug: log.debug, info: log.info, warn: log.warn, error: log.error,
    child: () => unifiedLog, close: log.close,
    renderer: rendererSink,
    crash: vi.fn(),
  } as unknown as UnifiedLogger;

  const fakeEvent = (trusted: boolean): { sender: { id: number } } => ({
    sender: { id: trusted ? 7 : 999 },
  });

  const makeService = (): SessionService =>
    new SessionService({
      getWindow: () =>
        ({
          webContents: {
            send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
          },
        }) as never,
      options,
      log: unifiedLog,
      isTrustedSender: (sender) => (sender as { id: number }).id === 7,
    });

  /** Invoke a registered channel handler the way ipcMain would. */
  const invoke = async (channel: string, args: unknown[], trusted = true): Promise<unknown> => {
    const handler = electronState.handlers.get(channel);
    if (!handler) throw new Error(`no handler registered on ${channel}`);
    return handler(fakeEvent(trusted), ...args);
  };

  const statusEvents = (): Array<{ phase: string; detail?: string; sessionId?: string }> =>
    sent.filter((s) => s.channel === IPC_SUBSCRIBE.status).map((s) => s.payload as { phase: string; detail?: string; sessionId?: string });

  const stateEvents = (): Array<{ target: string; path: string; data: unknown }> =>
    sent.filter((s) => s.channel === IPC_SUBSCRIBE.state).map((s) => s.payload as { target: string; path: string; data: unknown });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wayang-session-'));
    servers = [];
    sent = [];
    electronState.handlers.clear();
    electronState.forkImpl = (_modulePath, argv) => {
      const server = new LoopbackServer(`session-${servers.length + 1}`);
      (server as unknown as { argv: string[] }).argv = argv;
      servers.push(server);
      setImmediate(() => server.notifyReady());
      return server.child;
    };
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
    // A resumable target session on disk (core's session index layout).
    mkdirSync(join(options.dataDir, 'sessions', 'target-1'), { recursive: true });
    writeFileSync(join(options.dataDir, 'sessions', 'target-1', 'meta.json'), JSON.stringify({
      sessionId: 'target-1',
      workspace: options.workspaceDir,
      firstInput: 'help me ship the desktop app',
      createdAt: 1730000000000,
      lastActiveAt: 1730000100000,
    }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('start() emits connecting → ready to the window, registers every contract channel, forwards state', async () => {
    const service = makeService();
    await service.start();
    await vi.waitFor(() => {
      expect(statusEvents().map((s) => s.phase)).toEqual(['connecting', 'ready']);
    });
    expect(statusEvents()[1]).toMatchObject({ sessionId: 'session-1' });
    // The typed surface: every contract invoke channel is registered.
    expect(new Set(electronState.handlers.keys())).toEqual(new Set(IPC_INVOKE_CHANNELS));
    // State events reach the renderer on the contract's state channel.
    await vi.waitFor(() => expect(stateEvents().length).toBeGreaterThanOrEqual(10));
    expect(stateEvents()[0]).toMatchObject({ target: 'controllerAgent', path: 'conversation' });
    await service.stop();
    // The IPC surface is dropped on stop (late invokes fail fast).
    expect(electronState.handlers.size).toBe(0);
  });

  it('getInitialState returns the full 10-slice snapshot in an ok envelope', async () => {
    const service = makeService();
    await service.start();
    const result = await invoke(IPC.getInitialState, []);
    expect(result).toMatchObject({ ok: true });
    const slices = (result as { data: Record<string, unknown> }).data;
    expect(Object.keys(slices).sort()).toEqual([...Object.values(SLICE)].sort());
    expect(slices[SLICE.busy]).toMatchObject({ target: 'controllerAgent', path: 'dynamicState.busy' });
    await service.stop();
  });

  it('typed router: untrusted sender, invalid args and not-ready failures are error envelopes', async () => {
    const service = makeService();
    await service.start();

    // Untrusted sender — rejected before the arguments are even read.
    const untrusted = await invoke(IPC.sendInput, ['hello'], false);
    expect(untrusted).toMatchObject({ ok: false, error: expect.stringContaining('untrusted sender') });
    // Invalid arguments — the contract validator's message.
    const invalid = await invoke(IPC.sendInput, [42]);
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining('text') });
    // Handler failure (host not ready) — structured, never a bare throw.
    // Capture the handler before stop drops the registration, then invoke
    // it against the stopped host: the guard rejects with a clean envelope.
    const cancelHandler = electronState.handlers.get(IPC.cancelTask);
    expect(cancelHandler).toBeTypeOf('function');
    await service.stop();
    const stopped = await cancelHandler!(fakeEvent(true), 't-1');
    expect(stopped).toMatchObject({ ok: false, error: expect.stringContaining('server not ready') });
  });

  it('listSessions returns the core session index (time + summary)', async () => {
    const service = makeService();
    await service.start();
    const result = await invoke(IPC.listSessions, []);
    expect(result).toMatchObject({ ok: true });
    const entries = (result as { data: Array<{ sessionId: string; title: string | null; createdAt: number; lastActiveAt: number }> }).data;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      sessionId: 'target-1',
      title: 'help me ship the desktop app',
      createdAt: 1730000000000,
      lastActiveAt: 1730000100000,
    });
    await service.stop();
  });

  it('switchSession validates the target, then boots resume:<id> via the host', async () => {
    const service = makeService();
    await service.start();
    const result = await invoke(IPC.switchSession, ['target-1']);
    expect(result).toMatchObject({ ok: true, data: { sessionId: 'session-2' } });
    // The old server was gracefully stopped; the new fork boots the target.
    expect(servers[0].shutdownRequests).toBe(1);
    const sessionIdx = servers[1].argv.indexOf('--session');
    expect(servers[1].argv[sessionIdx + 1]).toBe('resume:target-1');
    // The window saw the switch as connecting → ready (no reconnecting).
    const phases = statusEvents().map((s) => s.phase);
    expect(phases).toEqual(['connecting', 'ready', 'connecting', 'ready']);
    await service.stop();
  });

  it('switchSession rejects an unknown target with a precise error envelope', async () => {
    const service = makeService();
    await service.start();
    const result = await invoke(IPC.switchSession, ['missing-session']);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('unknown session missing-session') });
    // No switch happened: no extra fork, no graceful stop.
    expect(servers).toHaveLength(1);
    expect(servers[0].shutdownRequests).toBe(0);
    await service.stop();
  });

  it('a config load failure lands on crashed (no host, no IPC surface)', async () => {
    rmSync(options.configPath, { force: true });
    const service = makeService();
    await service.start();
    const phases = statusEvents().map((s) => s.phase);
    expect(phases).toEqual(['connecting', 'crashed']);
    expect(statusEvents()[1].detail).toMatch(/no desktop config/);
    expect(electronState.handlers.size).toBe(0);
    expect(servers).toHaveLength(0);
  });

  it('rendererLog entries flow into the unified logger sink', async () => {
    const service = makeService();
    await service.start();
    const result = await invoke(IPC.rendererLog, [{ level: 'warn', message: 'renderer bridge works' }]);
    expect(result).toMatchObject({ ok: true });
    // The unified sink received the entry (§2.9 renderer log bridge).
    expect(rendererSink).toHaveBeenCalledWith({ level: 'warn', message: 'renderer bridge works' });
    await service.stop();
  });
});
