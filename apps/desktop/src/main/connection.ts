/**
 * Desktop server connection — spawns the wayang server in a UtilityProcess
 * and exposes it to the renderer over IPC.
 *
 * Same client stack as the CLI's connect.ts (RpcClient + RemoteStateStore +
 * RemoteSupervisor from core's client SDK); only the host differs:
 * UtilityProcess + message port instead of a spawned node child + stdio.
 */

import { readFile } from 'node:fs/promises';
import { ipcMain, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { validateConfig, type WayangConfig } from '@wayang-ai/protocol';
import { messagePortToStreams, type MessagePortLike } from '@wayang-ai/protocol/rpc/message-port';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { RpcClient, RemoteStateStore } from '@wayang-ai/protocol/rpc/rpc-client';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';
import { RemoteSupervisor, CONTEXT_USAGE_STATE_PATH } from '@wayang-ai/core/client/remote-supervisor';
import { CONFIG_OBJECT_ENV } from '../shared/config-env';
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

/** State slices forwarded to the renderer (mirrors the TUI's subscriptions). */
const SUBSCRIBED_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['controllerAgent', 'conversation'],
  ['controllerAgent', 'dynamicState.streamingEntries'],
  ['controllerAgent', 'dynamicState.busy'],
  ['controllerAgent', 'runtimeState.pendingInquiry'],
  ['controllerAgent', CONTEXT_USAGE_STATE_PATH],
  ['signalQueue', 'signals'],
  ['engine', 'activeWorkers'],
  ['engine', 'tasks.pending'],
  ['engine', 'tasks.running'],
  ['engine', 'tasks.completed'],
];

export interface DesktopSessionOptions {
  configPath: string;
  dataDir: string;
  workspaceDir: string;
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
  onStatus: (phase: 'connecting' | 'ready' | 'crashed', detail?: string) => void;
  log: MainLogger;
}

/**
 * Host-side config load (design 4.1): read the file once, parse, validate.
 * The CLI host's loader is app-local to apps/cli and not importable here, so
 * the desktop keeps this minimal read+validate slice — env-var key filling
 * and interactive prompts stay CLI concerns; the desktop settings page
 * (desktop-app-design §4) supersedes them later.
 */
async function loadSessionConfig(configPath: string): Promise<WayangConfig> {
  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as WayangConfig;
  const problem = validateConfig(config);
  if (problem) throw new Error(`Invalid config ${configPath}: ${problem}`);
  return config;
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
  const config = await loadSessionConfig(options.configPath);

  const child = utilityProcess.fork(join(__dirname, 'utility-entry.js'), [
    '--config', options.configPath,
    '--data-dir', options.dataDir,
    '--workspace-dir', options.workspaceDir,
    '--session', options.session,
    '--log-level', options.logLevel,
  ], {
    stdio: 'pipe',
    serviceName: 'wayang-server',
    env: { ...process.env, [CONFIG_OBJECT_ENV]: JSON.stringify(config) },
  });

  // The wayang server logs to <sessionDir>/wayang.log, so its stdio carries
  // only fatal output — echo to the console and persist to main.log. The
  // tail feeds crash/timeout diagnostics.
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

  const ready = await waitForReady(rpc, exited, stderrTail, child, options.dataDir);
  connLog.info('server ready', {
    sessionId: ready.sessionId,
    sessionDir: ready.sessionDir,
    serverLog: join(ready.sessionDir ?? '', 'wayang.log'),
  });
  const store = new RemoteStateStore(rpc);
  const supervisor = new RemoteSupervisor(rpc, store, options.workspaceDir, {
    stop: () => gracefulStop(rpc, child, exited),
  });

  // Forward state slices to the renderer. Subscriptions also make the server
  // push the initial snapshot, so the renderer gets values without polling.
  const send = (payload: { target: string; path: string; data: unknown }): void => {
    deps.getWindow()?.webContents.send('wayang:state', payload);
  };
  for (const [target, path] of SUBSCRIBED_PATHS) {
    store.subscribe(target, path, (event) => {
      send({ target, path, data: (event as { data?: unknown }).data });
    });
  }

  registerIpcHandlers(supervisor, rpc);

  let stopping = false;
  void exited.then((code) => {
    if (!stopping) onStatus('crashed', `server exited (code ${code})\n${stderrTail}`);
  });

  return {
    supervisor,
    stop: async () => {
      stopping = true;
      removeIpcHandlers();
      connLog.info('stopping server');
      await gracefulStop(rpc, child, exited);
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
  stderrTail: string,
  child: UtilityProcess,
  dataDir: string,
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
      // The server logs to its session file, not stdio — point whoever reads
      // this at both evidence sources (stderr tail + session log path).
      finish(new Error(
        `server did not become ready within ${READY_TIMEOUT_MS}ms.\n${stderrTail}` +
        `\nServer-side logs (if it booted): ${join(dataDir, 'sessions', '<sessionId>', 'wayang.log')}`,
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
      setImmediate(() => finish(new Error(`server exited before becoming ready (code ${code}).\n${stderrTail}`)));
    });
  });
}

const IPC_CHANNEL = {
  sendInput: 'wayang:sendInput',
  abort: 'wayang:abort',
  answerInquiry: 'wayang:answerInquiry',
  respondPermission: 'wayang:respondPermission',
  listTasks: 'wayang:listTasks',
  cancelTask: 'wayang:cancelTask',
  contextUsage: 'wayang:contextUsage',
} as const;

function registerIpcHandlers(supervisor: RemoteSupervisor, rpc: RpcClient): void {
  removeIpcHandlers();
  ipcMain.handle(IPC_CHANNEL.sendInput, (_e, text: string) => {
    supervisor.signalQueue.enqueue({ source: 'user', type: 'input', payload: { text } });
  });
  ipcMain.handle(IPC_CHANNEL.abort, () => supervisor.controllerAgent.abort());
  ipcMain.handle(IPC_CHANNEL.answerInquiry, (_e, answer: string) => supervisor.resolveInquiry(answer));
  ipcMain.handle(IPC_CHANNEL.respondPermission, (_e, p: { requestId: string; approved: boolean; reason?: string }) =>
    rpc.request(METHOD.RESPOND_PERMISSION, p));
  ipcMain.handle(IPC_CHANNEL.listTasks, () => supervisor.engine.list());
  ipcMain.handle(IPC_CHANNEL.cancelTask, (_e, taskId: string) => supervisor.engine.cancel(taskId));
  ipcMain.handle(IPC_CHANNEL.contextUsage, () => supervisor.getContextUsage());
}

function removeIpcHandlers(): void {
  for (const channel of Object.values(IPC_CHANNEL)) {
    ipcMain.removeHandler(channel);
  }
}
