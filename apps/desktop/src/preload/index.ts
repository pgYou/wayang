/**
 * Preload bridge — the renderer's ONLY channel to the main process.
 * contextIsolation on, nodeIntegration off; every capability is explicit.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** Subscribe to state slices forwarded from the server. Returns unsubscribe. */
  onState(callback: (update: { target: string; path: string; data: unknown }) => void): () => void {
    const listener = (_e: unknown, update: { target: string; path: string; data: unknown }): void => callback(update);
    ipcRenderer.on('wayang:state', listener);
    return () => ipcRenderer.removeListener('wayang:state', listener);
  },
  /** Connection lifecycle: connecting / ready / crashed. */
  onStatus(callback: (status: { phase: string; detail?: string }) => void): () => void {
    const listener = (_e: unknown, status: { phase: string; detail?: string }): void => callback(status);
    ipcRenderer.on('wayang:status', listener);
    return () => ipcRenderer.removeListener('wayang:status', listener);
  },
  sendInput: (text: string): Promise<void> => ipcRenderer.invoke('wayang:sendInput', text),
  abort: (): Promise<void> => ipcRenderer.invoke('wayang:abort'),
  answerInquiry: (answer: string): Promise<void> => ipcRenderer.invoke('wayang:answerInquiry', answer),
  respondPermission: (requestId: string, approved: boolean, reason?: string): Promise<unknown> =>
    ipcRenderer.invoke('wayang:respondPermission', { requestId, approved, reason }),
  listTasks: (): Promise<unknown> => ipcRenderer.invoke('wayang:listTasks'),
  cancelTask: (taskId: string): Promise<void> => ipcRenderer.invoke('wayang:cancelTask', taskId),
  getContextUsage: (): Promise<unknown> => ipcRenderer.invoke('wayang:contextUsage'),
};

export type WayangApi = typeof api;

contextBridge.exposeInMainWorld('wayang', api);
