/**
 * Desktop server connection — spawns the wayang server in a UtilityProcess
 * and exposes it to the renderer over IPC.
 *
 * Same client stack as the CLI's connect.ts (RpcClient + RemoteStateStore +
 * RemoteSupervisor from core's client SDK); only the host differs:
 * UtilityProcess + message port instead of a spawned node child + stdio.
 */

import { ipcMain, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type { WayangConfig } from '@wayang-ai/protocol';
import { messagePortToStreams, type MessagePortLike } from '@wayang-ai/protocol/rpc/message-port';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { RpcClient, RemoteStateStore } from '@wayang-ai/protocol/rpc/rpc-client';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';
import { RemoteSupervisor } from '@wayang-ai/core/client/remote-supervisor';
import { CONFIG_OBJECT_ENV } from '../shared/config-env';
import { IPC, IPC_INVOKE_CHANNELS, STATE_SLICE_PATHS } from '../shared/ipc-contract';
import { ConfigStore } from './config-store';
import type { MainLogger } from './logger';
import { createLineSplitter } from './log-lines';

const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Electron's message direction is asymmetric: parent→child delivers
 * MessageEvent-shaped events, but child→parent (UtilityProcess 'message')
 * delivers the payload directly. The port adapter speaks the MessageEvent
 * shape, so translate here — protocol stays shape-agnostic.
 */
function asMessagePort(child: UtilityProcess): MessagePortLike {
  const shims = new Map<(event: { data: unknown }) => void, (message: unknown) => void>();
  return {
    postMessage: (data) => child.postMessage(data),
    addListener: (event, listener) => {
      const shim = (message: unknown): void => listener({ data: message });
      shims.set(listener, shim);
      child.addListener(event, shim);
    },
    removeListener: (event, listener) => {
      const shim = shims.get(listener);
      if (shim) {
        child.removeListener(event, shim);
        shims.delete(listener);
      }
    },
  };
}

/**
 * State slices forwarded to the renderer (mirrors the TUI's subscriptions).
 * Single source: the shared IPC contract (§2.2) — re-exported here for the
 * existing pin tests until the layering lands (域二).
 */
export { STATE_SLICE_PATHS as SUBSCRIBED_PATHS };

export interface DesktopSessionOptions {
  /** Envelope config file (`<userData>/config.json`, 决策九) — the load source. */
  configPath: string;
  /**
   * Legacy CLI config (`~/.wayang.config.json`) — read-only source for the
   * transitional one-time import when the envelope does not exist yet.
   */
  legacyConfigPath: string;
  /** storagePaths.dataDir (= userData): sessions live under `<dataDir>/sessions`. */
  dataDir: string;
  /** storagePaths.logDir: the session log lands in the app logs dir (§2.5). */
  logDir: string;
  /** storagePaths.cacheDir: MCP sockets and runtime temp (§2.5). */
  cacheDir: string;
  /** workspacePolicy.controllerWorkspace — also mirrors the legacy --workspace-dir. */
  workspaceDir: string;
  /** workspacePolicy.defaultWorkerWorkspace — the user-visible worker workspace. */
  defaultWorkerWorkspace: string;
  session: string;
  logLevel: string;
}

export interface DesktopConnection {
  supervisor: RemoteSupervisor;
  stop: () => Promise<void>;
}

export interface ConnectDeps {
  getWindow: () => BrowserWindow | null;
  options: DesktopSessionOptions;
  /**
   * Connection status machine (main only, §5 进程纪律). Phases:
   * connecting → ready (with the session id) → [reconnecting → ready] → crashed.
   */
  onStatus: (phase: 'connecting' | 'reconnecting' | 'ready' | 'crashed', detail?: string, sessionId?: string) => void;
  log: MainLogger;
}

/**
 * Host-side config load (design 2.4 / 决策九): read the desktop envelope
 * store at `options.configPath` (`<userData>/config.json`). The store
 * validates the embedded `wayangConfig` with protocol's `validateConfig`.
 * A missing envelope triggers the store's transitional one-time import from
 * the CLI config (read-only, marked for removal once the explicit import
 * action lands); beyond that import the desktop never touches CLI files at
 * runtime.
 */
async function loadSessionConfig(configPath: string, legacyConfigPath: string): Promise<WayangConfig> {
  const store = new ConfigStore(configPath);
  return store.loadOrImport(legacyConfigPath);
}

/**
 * One live server attachment: the forked utility child plus the client stack
 * wired to it (rpc, state store, supervisor) and its exit signal. Rebuilt
 * from scratch on every (re)boot — a resume is a full re-fork, never a
 * half-repaired connection.
 */
interface ServerWiring {
  child: UtilityProcess;
  rpc: RpcClient;
  exited: Promise<number | null>;
  ready: { sessionId?: string; sessionDir?: string };
  supervisor: RemoteSupervisor;
  /** Latest stderr tail (crash/timeout diagnostics). */
  stderrTail: () => string;
}

export async function connectServer(deps: ConnectDeps): Promise<DesktopConnection> {
  const { options, onStatus, log } = deps;
  const connLog = log.child('connection');
  const serverLog = log.child('server');
  connLog.info('connecting', { ...options });
  onStatus('connecting');

  // The main process owns config resolution (design 4.1 via
  // desktop-app-design §2): load and validate the object ONCE here — the
  // spawned utility receives it through the env channel and never reads
  // config files. A missing/invalid config rejects this promise and surfaces
  // as the `crashed` status, the same UX the old server-side load failure
  // produced. `--config` stays in the argv surface as the utility's
  // standalone-run fallback (mirrors the CLI's server-entry).
  const config = await loadSessionConfig(options.configPath, options.legacyConfigPath);

  // Crash-resume state (§2.9, one-shot semantics):
  // - `stopping` is the idempotent quit flag: an exit caused by (or landing
  //   during) the shutdown path is swallowed — never a crash, never a
  //   reconnect. This is what defuses the before-quit ↔ reconnect race.
  // - `resumeUsed` pins the one-shot retry: exactly one resume attempt after
  //   an unexpected exit; the next exit is terminal (`crashed`).
  // - `readySessionId` is only set once the server reported a session id —
  //   a crash before that (or an id-less ready) goes straight to `crashed`.
  let stopping = false;
  let resumeUsed = false;
  let readySessionId: string | undefined;
  let live: ServerWiring | null = null;
  let currentSupervisor: RemoteSupervisor;

  // Forward state slices to the renderer. Subscriptions also make the server
  // push the initial snapshot, so the renderer gets values without polling.
  const send = (payload: { target: string; path: string; data: unknown }): void => {
    deps.getWindow()?.webContents.send('wayang:state', payload);
  };

  async function boot(sessionArg: string, replay: boolean): Promise<ServerWiring> {
    const child = utilityProcess.fork(join(__dirname, 'utility-entry.js'), [
      '--config', options.configPath,
      '--data-dir', options.dataDir,
      '--workspace-dir', options.workspaceDir,
      // Explicit injection surface (§2.5): the utility entry turns these into
      // StoragePaths / WorkspacePolicy for serverMain; the legacy pair above
      // mirrors contract members so there is no second semantic source.
      '--log-dir', options.logDir,
      '--cache-dir', options.cacheDir,
      '--default-worker-workspace', options.defaultWorkerWorkspace,
      '--session', sessionArg,
      '--log-level', options.logLevel,
    ], {
      stdio: 'pipe',
      serviceName: 'wayang-server',
      env: { ...process.env, [CONFIG_OBJECT_ENV]: JSON.stringify(config) },
    });

    // The wayang server logs to its log dir, so its stdio carries only fatal
    // output — echo to the console and persist to main.log. The tail feeds
    // crash/timeout diagnostics.
    let stderrTail = '';
    const stderrLines = createLineSplitter((line) => serverLog.error(line));
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[server] ${chunk}`);
      stderrTail = (stderrTail + chunk).slice(-4000);
      stderrLines(chunk);
    });
    const stdoutLines = createLineSplitter((line) => serverLog.debug(line));
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      process.stdout.write(`[server] ${chunk}`);
      stdoutLines(chunk);
    });

    // The UtilityProcess object is structurally a message port for our framing,
    // modulo Electron's event-shape asymmetry (see asMessagePort).
    const io = messagePortToStreams(asMessagePort(child));
    const rpc = new RpcClient(createStreamTransport(io.stdin, io.stdout));

    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });

    // Register before awaiting ready so a quit racing the boot can still
    // reach (and stop) the freshly forked child.
    const wiring: ServerWiring = {
      child,
      rpc,
      exited,
      ready: {},
      supervisor: undefined as unknown as RemoteSupervisor,
      stderrTail: () => stderrTail,
    };
    live = wiring;

    const ready = await waitForReady(rpc, exited, wiring.stderrTail, child, options.logDir);
    wiring.ready = ready;
    readySessionId = ready.sessionId;

    connLog.info('server ready', {
      sessionId: ready.sessionId,
      sessionDir: ready.sessionDir,
      serverLog: join(ready.sessionDir ?? '', 'wayang.log'),
    });
    // The renderer status bar waits for this to show 已连接 — without it the
    // connection stays "connecting" forever even though the server is up.
    onStatus('ready', undefined, ready.sessionId);

    const store = new RemoteStateStore(rpc);
    const supervisor = new RemoteSupervisor(rpc, store, options.workspaceDir, {
      stop: () => gracefulStop(rpc, child, exited),
    });
    wiring.supervisor = supervisor;
    currentSupervisor = supervisor;

    for (const [target, path] of STATE_SLICE_PATHS) {
      store.subscribe(target, path, (event) => {
        send({ target, path, data: (event as { data?: unknown }).data });
      });
    }
    registerIpcHandlers(supervisor, rpc);

    // Snapshot replay after a resume boot (§2.7 replay, one source): the
    // SUBSCRIBE handshake already carries each path's current value, but a
    // server-side null fires no event — a GET_SNAPSHOT sweep pushes every
    // slice once more through the same wayang:state channel so the renderer
    // converges on the resumed session's state.
    if (replay) {
      for (const [target, path] of STATE_SLICE_PATHS) {
        void rpc.request<{ data: unknown }>(METHOD.GET_SNAPSHOT, { target, path })
          .then((res) => send({ target, path, data: res.data }))
          .catch(() => { /* server gone: the exit path takes over */ });
      }
    }

    void exited.then((code) => {
      // The stop path owns exits it caused (before-quit race); everything
      // else is an unexpected crash.
      if (!stopping) handleUnexpectedExit(wiring, code);
    });

    return wiring;
  }

  function handleUnexpectedExit(wiring: ServerWiring, code: number | null): void {
    const tail = wiring.stderrTail();
    // Crash before ready (or an id-less ready): no session to resume, no
    // blind retries — straight to `crashed`.
    if (readySessionId === undefined) {
      onStatus('crashed', `server exited without a usable session (code ${code})\n${tail}`);
      return;
    }
    if (resumeUsed) {
      // One-shot semantics: the second unexpected exit is terminal.
      onStatus('crashed', `server exited again after one resume (code ${code})\n${tail}`);
      return;
    }
    resumeUsed = true;
    connLog.warn('server exited unexpectedly — resuming session', { code, sessionId: readySessionId });
    onStatus('reconnecting', `server exited (code ${code}) — resuming session ${readySessionId}`);
    wiring.rpc.close();
    // Drop the IPC surface while reconnecting: invokes would hit a dead
    // transport; the resume boot re-registers the handlers.
    removeIpcHandlers();
    void boot(`resume:${readySessionId}`, true).catch((err: unknown) => {
      // A quit mid-reconnect owns the outcome — never report it as a crash.
      if (stopping) return;
      const message = err instanceof Error ? err.message : String(err);
      connLog.error('resume failed', { error: message });
      onStatus('crashed', message);
    });
  }

  const first = await boot(options.session, false);

  return {
    get supervisor(): RemoteSupervisor {
      return currentSupervisor ?? first.supervisor;
    },
    stop: async () => {
      // Idempotent quit flag — before-quit can re-enter, and an in-flight
      // resume boot checks the same flag before reporting anything.
      stopping = true;
      removeIpcHandlers();
      connLog.info('stopping server');
      const victim = live;
      if (victim) await gracefulStop(victim.rpc, victim.child, victim.exited);
    },
  };
}

async function gracefulStop(rpc: RpcClient, child: UtilityProcess, exited: Promise<number | null>): Promise<void> {
  try {
    await Promise.race([
      rpc.request(METHOD.SHUTDOWN),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('shutdown timeout')), SHUTDOWN_GRACE_MS)),
    ]);
  } catch {
    /* fall through to exit wait / kill */
  }
  await Promise.race([
    exited,
    new Promise<number | null>((resolve) => {
      setTimeout(() => {
        child.kill();
        resolve(null);
      }, SHUTDOWN_GRACE_MS);
    }),
  ]);
  rpc.close();
}

function waitForReady(
  rpc: RpcClient,
  exited: Promise<number | null>,
  stderrTail: () => string,
  child: UtilityProcess,
  logDir: string,
): Promise<{ sessionId?: string; sessionDir?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let readyInfo: { sessionId?: string; sessionDir?: string } = {};
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(readyInfo);
    };
    const timer = setTimeout(() => {
      child.kill();
      // The injected logDir (§2.5) is where the server's session log lands
      // — point whoever reads this at both evidence sources (stderr tail +
      // the log file).
      finish(new Error(
        `server did not become ready within ${READY_TIMEOUT_MS}ms.\n${stderrTail()}` +
        `\nServer-side logs (if it booted): ${join(logDir, 'wayang.log')}`,
      ));
    }, READY_TIMEOUT_MS);
    rpc.on(NOTIFY.READY, (params) => {
      readyInfo = {
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        sessionDir: typeof params.sessionDir === 'string' ? params.sessionDir : undefined,
      };
      finish();
    });
    void exited.then((code) => {
      setImmediate(() => finish(new Error(`server exited before becoming ready (code ${code}).\n${stderrTail()}`)));
    });
  });
}

function registerIpcHandlers(supervisor: RemoteSupervisor, rpc: RpcClient): void {
  removeIpcHandlers();
  ipcMain.handle(IPC.sendInput, (_e, text: string) => {
    supervisor.signalQueue.enqueue({ source: 'user', type: 'input', payload: { text } });
  });
  ipcMain.handle(IPC.abort, () => supervisor.controllerAgent.abort());
  ipcMain.handle(IPC.answerInquiry, (_e, answer: string) => supervisor.resolveInquiry(answer));
  ipcMain.handle(IPC.respondPermission, (_e, p: { requestId: string; approved: boolean; reason?: string }) =>
    rpc.request(METHOD.RESPOND_PERMISSION, p));
  ipcMain.handle(IPC.listTasks, () => supervisor.engine.list());
  ipcMain.handle(IPC.cancelTask, (_e, taskId: string) => supervisor.engine.cancel(taskId));
  ipcMain.handle(IPC.contextUsage, () => supervisor.getContextUsage());
}

function removeIpcHandlers(): void {
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
