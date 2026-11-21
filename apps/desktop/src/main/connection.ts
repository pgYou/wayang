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
import { messagePortToStreams, type MessagePortLike } from '@wayang-ai/protocol/rpc/message-port';
import { createStreamTransport } from '@wayang-ai/protocol/rpc/transport';
import { RpcClient, RemoteStateStore } from '@wayang-ai/protocol/rpc/rpc-client';
import { METHOD, NOTIFY } from '@wayang-ai/protocol/rpc/protocol';
import { RemoteSupervisor, CONTEXT_USAGE_STATE_PATH } from '@wayang-ai/core/client/remote-supervisor';

const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

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
}

export async function connectServer(deps: ConnectDeps): Promise<DesktopConnection> {
  const { options, onStatus } = deps;
  onStatus('connecting');

  const child = utilityProcess.fork(join(__dirname, 'utility-entry.js'), [
    '--config', options.configPath,
    '--data-dir', options.dataDir,
    '--workspace-dir', options.workspaceDir,
    '--session', options.session,
    '--log-level', options.logLevel,
  ], { stdio: 'pipe', serviceName: 'wayang-server' });

  // Server logs flow to the desktop app's console (dev tools / terminal).
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`));

  // The UtilityProcess object is structurally a message port for our framing.
  const port = child as unknown as MessagePortLike;
  const io = messagePortToStreams(port);
  const rpc = new RpcClient(createStreamTransport(io.stdin, io.stdout));

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  await waitForReady(rpc, exited, stderrTail, child);
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
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`server did not become ready within ${READY_TIMEOUT_MS}ms.\n${stderrTail}`));
    }, READY_TIMEOUT_MS);
    rpc.on(NOTIFY.READY, () => finish());
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
