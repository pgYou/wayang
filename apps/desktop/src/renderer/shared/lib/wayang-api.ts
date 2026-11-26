/**
 * wayang-api — the renderer's ONLY module allowed to touch `window.wayang`
 *
 *
 * A thin wrapper over the preload bridge: method-for-method delegation with
 * lazy bridge access (so importing this module never touches `window` —
 * node-environment tests can import the store without a DOM). Components
 * import from here and never reach for the bridge directly; the boundary
 * pin test scans the renderer tree for direct `window.wayang` access.
 */

import type { WayangBridge } from '@/preload/index';
import type {
  ChooseDirectoryResult,
  ConnectionStatus,
  InitialStateSnapshot,
  OnboardState,
  ReadConfigResult,
  RendererLogEntry,
  SaveConfigResult,
  StateUpdate,
  WayangConfig,
} from '@/shared/ipc-contract';

function bridge(): WayangBridge {
  if (typeof window === 'undefined' || !window.wayang) {
    throw new Error('window.wayang is unavailable — the preload bridge did not run');
  }
  return window.wayang;
}

/** The full preload bridge surface, lazily resolved. */
export const wayang = {
  onState: (callback: (update: StateUpdate) => void): (() => void) => bridge().onState(callback),
  onStatus: (callback: (status: ConnectionStatus) => void): (() => void) => bridge().onStatus(callback),
  sendInput: (text: string): Promise<void> => bridge().sendInput(text),
  abort: (): Promise<void> => bridge().abort(),
  answerInquiry: (answer: string): Promise<void> => bridge().answerInquiry(answer),
  respondPermission: (requestId: string, approved: boolean, reason?: string): Promise<unknown> =>
    bridge().respondPermission(requestId, approved, reason),
  listTasks: (status?: Parameters<WayangBridge['listTasks']>[0]): ReturnType<WayangBridge['listTasks']> =>
    bridge().listTasks(status),
  cancelTask: (taskId: string): Promise<void> => bridge().cancelTask(taskId),
  getContextUsage: (): ReturnType<WayangBridge['getContextUsage']> => bridge().getContextUsage(),
  getInitialState: (): ReturnType<WayangBridge['getInitialState']> => bridge().getInitialState(),
  newSession: (): ReturnType<WayangBridge['newSession']> => bridge().newSession(),
  switchSession: (sessionId: string): ReturnType<WayangBridge['switchSession']> => bridge().switchSession(sessionId),
  listSessions: (): ReturnType<WayangBridge['listSessions']> => bridge().listSessions(),
  rendererLog: (entry: RendererLogEntry): Promise<void> => bridge().rendererLog(entry),
  getOnboardState: (): Promise<OnboardState> => bridge().getOnboardState(),
  importCliConfig: (): Promise<{ config: WayangConfig }> => bridge().importCliConfig(),
  saveConfig: (config: WayangConfig, desktop?: Record<string, unknown>): Promise<SaveConfigResult> =>
    bridge().saveConfig(config, desktop),
  readConfig: (): Promise<ReadConfigResult> => bridge().readConfig(),
  chooseDirectory: (): Promise<ChooseDirectoryResult> => bridge().chooseDirectory(),
  restartServer: (): Promise<{ sessionId: string }> => bridge().restartServer(),
};

/** Bridge surface subset the store boot needs (DI seam for tests). */
export interface BridgeLike {
  onState(callback: (update: StateUpdate) => void): () => void;
  onStatus(callback: (status: ConnectionStatus) => void): () => void;
  getInitialState(): Promise<InitialStateSnapshot>;
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Renderer log bridge: console warn/error, window
 * error events and unhandled rejections land in the main process's unified
 * log through `wayang:rendererLog`. Fire-and-forget — logging must never
 * break the renderer.
 */
export function installRendererLogBridge(): void {
  if (typeof window === 'undefined') return;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      void wayang.rendererLog({ level, message: args.map(formatLogArg).join(' ') }).catch(() => undefined);
    };
  }
  window.addEventListener('error', (event) => {
    void wayang.rendererLog({ level: 'error', message: `window error: ${event.message} @ ${event.filename}:${event.lineno}` })
      .catch(() => undefined);
  });
  window.addEventListener('unhandledrejection', (event) => {
    void wayang.rendererLog({ level: 'error', message: `unhandledrejection: ${formatLogArg(event.reason)}` })
      .catch(() => undefined);
  });
}
