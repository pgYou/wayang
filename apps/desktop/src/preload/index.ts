/**
 * Preload bridge — the renderer's ONLY channel to the main process.
 * contextIsolation on, nodeIntegration off; every capability is explicit.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IPC_SUBSCRIBE } from '../shared/ipc-contract';

const api = {
  /** Subscribe to state slices forwarded from the server. Returns unsubscribe. */
  onState(callback: (update: { target: string; path: string; data: unknown }) => void): () => void {
    const listener = (_e: unknown, update: { target: string; path: string; data: unknown }): void => callback(update);
    ipcRenderer.on(IPC_SUBSCRIBE.state, listener);
    return () => ipcRenderer.removeListener(IPC_SUBSCRIBE.state, listener);
  },
  /** Connection lifecycle: connecting / reconnecting / ready / crashed (+ sessionId on ready). */
  onStatus(callback: (status: { phase: string; detail?: string; sessionId?: string }) => void): () => void {
    const listener = (_e: unknown, status: { phase: string; detail?: string; sessionId?: string }): void => callback(status);
    ipcRenderer.on(IPC_SUBSCRIBE.status, listener);
    return () => ipcRenderer.removeListener(IPC_SUBSCRIBE.status, listener);
  },
  sendInput: (text: string): Promise<void> => ipcRenderer.invoke(IPC.sendInput, text),
  abort: (): Promise<void> => ipcRenderer.invoke(IPC.abort),
  answerInquiry: (answer: string): Promise<void> => ipcRenderer.invoke(IPC.answerInquiry, answer),
  respondPermission: (requestId: string, approved: boolean, reason?: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.respondPermission, { requestId, approved, reason }),
  listTasks: (): Promise<unknown> => ipcRenderer.invoke(IPC.listTasks),
  cancelTask: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.cancelTask, taskId),
  getContextUsage: (): Promise<unknown> => ipcRenderer.invoke(IPC.contextUsage),
};

export type WayangApi = typeof api;

contextBridge.exposeInMainWorld('wayang', api);
