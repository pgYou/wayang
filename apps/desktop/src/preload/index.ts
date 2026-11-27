/**
 * Preload bridge — the renderer's ONLY channel to the main process
 * (desktop-app-design §2.2, 4.2 域二工作项①).
 *
 * contextIsolation on, nodeIntegration off, sandbox on; every capability is
 * explicit. Channel names, argument shapes and result types come from the
 * shared IPC contract — this module adds only the two transport wrappers:
 *   - `typedInvoke`: unified timeout guard + `{ok, data, error}` envelope
 *     unwrapping (a failed invoke rejects with the envelope's error);
 *   - `typedSubscribe`: typed listener registration returning unsubscribe.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  IPC_SUBSCRIBE,
  invokeTimeoutMs,
  type IpcInvokeContract,
  type IpcResult,
  type IpcSubscribeContract,
  type InvokeChannel,
  type SubscribeChannel,
} from '../shared/ipc-contract';

async function typedInvoke<K extends InvokeChannel>(
  channel: K,
  ...args: IpcInvokeContract[K]['args']
): Promise<IpcInvokeContract[K]['result']> {
  const timeoutMs = invokeTimeoutMs(channel);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      ipcRenderer.invoke(channel, ...args),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`IPC invoke ${channel} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (raw === null || typeof raw !== 'object' || !('ok' in raw)) {
      throw new Error(`malformed IPC envelope on ${channel}`);
    }
    const result = raw as IpcResult<IpcInvokeContract[K]['result']>;
    if (!result.ok) throw new Error(result.error);
    return result.data;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function typedSubscribe<K extends SubscribeChannel>(
  channel: K,
  callback: (payload: IpcSubscribeContract[K]['payload']) => void,
): () => void {
  const listener = (_e: unknown, payload: IpcSubscribeContract[K]['payload']): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  /** Subscribe to state slices forwarded from the server. Returns unsubscribe. */
  onState: (callback: (update: IpcSubscribeContract[typeof IPC_SUBSCRIBE.state]['payload']) => void): (() => void) =>
    typedSubscribe(IPC_SUBSCRIBE.state, callback),
  /** Connection lifecycle: connecting / reconnecting / ready / crashed (+ sessionId on ready). */
  onStatus: (callback: (status: IpcSubscribeContract[typeof IPC_SUBSCRIBE.status]['payload']) => void): (() => void) =>
    typedSubscribe(IPC_SUBSCRIBE.status, callback),
  /** Window state (§2.1 custom header): native fullscreen transitions. */
  onWindowState: (callback: (state: IpcSubscribeContract[typeof IPC_SUBSCRIBE.window]['payload']) => void): (() => void) =>
    typedSubscribe(IPC_SUBSCRIBE.window, callback),
  sendInput: (text: string): Promise<void> => typedInvoke(IPC.sendInput, text),
  abort: (): Promise<void> => typedInvoke(IPC.abort),
  answerInquiry: (answer: string): Promise<void> => typedInvoke(IPC.answerInquiry, answer),
  respondPermission: (requestId: string, approved: boolean, reason?: string): Promise<unknown> =>
    typedInvoke(IPC.respondPermission, { requestId, approved, reason }),
  listTasks: (status?: IpcInvokeContract[typeof IPC.listTasks]['args'][number]): Promise<IpcInvokeContract[typeof IPC.listTasks]['result']> =>
    typedInvoke(IPC.listTasks, status),
  cancelTask: (taskId: string): Promise<void> => typedInvoke(IPC.cancelTask, taskId),
  getContextUsage: (): Promise<IpcInvokeContract[typeof IPC.contextUsage]['result']> => typedInvoke(IPC.contextUsage),
  /** Full snapshot pull (§2.7): first-paint hydration and refresh replay. */
  getInitialState: (): Promise<IpcInvokeContract[typeof IPC.getInitialState]['result']> =>
    typedInvoke(IPC.getInitialState),
  /** Session switching (§2.2). */
  newSession: (): Promise<IpcInvokeContract[typeof IPC.newSession]['result']> => typedInvoke(IPC.newSession),
  switchSession: (sessionId: string): Promise<IpcInvokeContract[typeof IPC.switchSession]['result']> =>
    typedInvoke(IPC.switchSession, sessionId),
  /** Session index (time + summary per session). */
  listSessions: (): Promise<IpcInvokeContract[typeof IPC.listSessions]['result']> => typedInvoke(IPC.listSessions),
  /** Renderer log bridge (§2.9): renderer entries into the unified log. */
  rendererLog: (entry: IpcInvokeContract[typeof IPC.rendererLog]['args'][number]): Promise<void> =>
    typedInvoke(IPC.rendererLog, entry),
  /** Cold-boot decision (§2.11): welcome page trigger. */
  getOnboardState: (): Promise<IpcInvokeContract[typeof IPC.getOnboardState]['result']> =>
    typedInvoke(IPC.getOnboardState),
  /** Explicit CLI-config import (§2.11): read-only + validate. */
  importCliConfig: (): Promise<IpcInvokeContract[typeof IPC.importCliConfig]['result']> =>
    typedInvoke(IPC.importCliConfig),
  /** Save the envelope (§2.11 confirm page / §2.4 settings): validate → write → boot/hot-update. */
  saveConfig: (
    config: IpcInvokeContract[typeof IPC.saveConfig]['args'][0],
    desktop?: IpcInvokeContract[typeof IPC.saveConfig]['args'][1],
  ): Promise<IpcInvokeContract[typeof IPC.saveConfig]['result']> => typedInvoke(IPC.saveConfig, config, desktop),
  /** Settings read (§4.3 工作项②): the current envelope. */
  readConfig: (): Promise<IpcInvokeContract[typeof IPC.readConfig]['result']> => typedInvoke(IPC.readConfig),
  /** Directory picker (§4.3 工作项②): workspace selection. */
  chooseDirectory: (): Promise<IpcInvokeContract[typeof IPC.chooseDirectory]['result']> =>
    typedInvoke(IPC.chooseDirectory),
  /** Restart the server with the envelope config (§2.4 restart-needed fields). */
  restartServer: (): Promise<IpcInvokeContract[typeof IPC.restartServer]['result']> =>
    typedInvoke(IPC.restartServer),
  /** Custom-header window controls (§2.1): minimize / zoom / close. */
  windowControl: (action: IpcInvokeContract[typeof IPC.windowControl]['args'][0]): Promise<void> =>
    typedInvoke(IPC.windowControl, action),
};

export type WayangBridge = typeof api;

contextBridge.exposeInMainWorld('wayang', api);
