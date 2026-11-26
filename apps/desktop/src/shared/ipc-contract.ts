/**
 * IPC single contract (desktop-app-design §2.2, 4.2 域二工作项①).
 *
 * The ONLY source of channel names, request/response types, subscription
 * payloads, state slice keys, argument validators and invoke timeouts for the
 * main ↔ preload ↔ renderer surface. Every call site goes through this module
 * — no string channel literals anywhere else, no duplicate declarations in
 * `global.d.ts` (the renderer reuses the preload's exported bridge type).
 *
 * This module is shared by all three processes and therefore stays pure:
 * types + constants only, no Electron, no Node built-ins.
 */

import type {
  ActiveWorkerInfo,
  ContextUsage,
  ControllerSignal,
  ConversationEntry,
  InquireQuestion,
  TaskDetail,
  WayangConfig,
} from '@wayang-ai/protocol';
import type { OnboardState } from './onboard';

export type { OnboardState };

/* ------------------------------------------------------------------ *
 * State slices (§2.2 订阅载荷 + §2.7 快照面)
 * ------------------------------------------------------------------ */

/**
 * The state slices main subscribes on the server and forwards to the
 * renderer over `wayang:state`. Single source: the main-side subscription
 * table, the renderer's slice keys and the `getInitialState` snapshot set
 * all derive from this table.
 *
 * `controllerAgent:dynamicState.contextUsage` mirrors core's shared
 * CONTEXT_USAGE_STATE_PATH literal ('dynamicState.contextUsage') — the
 * shared layer cannot import core (preload/renderer boundary), the pin test
 * keeps the two literals equal.
 */
export const STATE_SLICE_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['controllerAgent', 'conversation'],
  ['controllerAgent', 'dynamicState.streamingEntries'],
  ['controllerAgent', 'dynamicState.busy'],
  ['controllerAgent', 'runtimeState.pendingInquiry'],
  ['controllerAgent', 'dynamicState.contextUsage'],
  ['signalQueue', 'signals'],
  ['engine', 'activeWorkers'],
  ['engine', 'tasks.pending'],
  ['engine', 'tasks.running'],
  // Core's task engine writes `tasks.history` (all terminal states); the old
  // `tasks.completed` path never carried a value, so the completed counter
  // was stuck at 0. The renderer filters statuses out of the history slice.
  ['engine', 'tasks.history'],
];

/** Renderer-side slice key map — every value is `${target}:${path}` from the table above. */
export const SLICE = {
  conversation: 'controllerAgent:conversation',
  streaming: 'controllerAgent:dynamicState.streamingEntries',
  busy: 'controllerAgent:dynamicState.busy',
  pendingInquiry: 'controllerAgent:runtimeState.pendingInquiry',
  contextUsage: 'controllerAgent:dynamicState.contextUsage',
  signals: 'signalQueue:signals',
  activeWorkers: 'engine:activeWorkers',
  tasksPending: 'engine:tasks.pending',
  tasksRunning: 'engine:tasks.running',
  // Core writes the full task history (all terminal states) to tasks.history;
  // `tasks.completed` was a dead path. Completed tasks are filtered below.
  tasksHistory: 'engine:tasks.history',
} as const;

export type SliceKey = keyof typeof SLICE;

/** Compose a slice key the same way the subscription table and events do. */
export function sliceKey(target: string, path: string): string {
  return `${target}:${path}`;
}

/* ------------------------------------------------------------------ *
 * Channel names — the only string channel literals in the app (§2.2)
 * ------------------------------------------------------------------ */

export const IPC = {
  /** Forward RemoteSupervisor calls. */
  sendInput: 'wayang:sendInput',
  abort: 'wayang:abort',
  answerInquiry: 'wayang:answerInquiry',
  /** Declared but unwired UI-wise (worker-level permission cards are future work). */
  respondPermission: 'wayang:respondPermission',
  listTasks: 'wayang:listTasks',
  cancelTask: 'wayang:cancelTask',
  contextUsage: 'wayang:contextUsage',
  /** Full snapshot pull (§2.7): first-paint hydration and refresh replay. */
  getInitialState: 'wayang:getInitialState',
  /** Session switching (§2.2): new-session opens a fresh session. */
  newSession: 'wayang:newSession',
  /** Session switching (§2.2): switch-session takes the target sessionId. */
  switchSession: 'wayang:switchSession',
  /** Session index (§2.2/§4.2 工作项⑤): core session list (time + summary). */
  listSessions: 'wayang:listSessions',
  /** Renderer log bridge (§2.9 UnifiedLogger): renderer entries into the unified log. */
  rendererLog: 'wayang:rendererLog',
  /** Cold-boot decision (§2.11 决策九): does the envelope satisfy the core? */
  getOnboardState: 'wayang:getOnboardState',
  /** Explicit CLI-config import (§2.11): read `~/.wayang.config.json` (read-only) + validate. */
  importCliConfig: 'wayang:importCliConfig',
  /**
   * Save the config envelope (§2.11 最终确认页 / §2.4 设置页同源同校验):
   * validate → write envelope → boot (not running) / hot-update (running).
   */
  saveConfig: 'wayang:saveConfig',
  /** Settings page read: the current envelope's wayangConfig + desktop prefs. */
  readConfig: 'wayang:readConfig',
  /** Directory picker (§4.3 工作项② workspace selection, dialog.showOpenDialog). */
  chooseDirectory: 'wayang:chooseDirectory',
  /** Restart the server with the envelope config (§2.4 restart-needed fields). */
  restartServer: 'wayang:restartServer',
  /**
   * Custom-titlebar window controls (§2.1 header): the renderer-drawn
   * traffic-light dots. No session state involved — a shell concern riding
   * the same typed surface.
   */
  windowControl: 'wayang:windowControl',
} as const;

export const IPC_SUBSCRIBE = {
  /** `NOTIFY state.event` forwarded one by one (target + path + data). */
  state: 'wayang:state',
  /** Connection status machine (§2.9 phases). */
  status: 'wayang:status',
  /**
   * Window state pushes (§2.1 custom header): native fullscreen changes —
   * macOS hides the traffic lights in fullscreen, so the renderer collapses
   * the reserved spacer. Shell concern, same typed subscribe surface.
   */
  window: 'wayang:window',
} as const;

/** All invoke channel names — for bulk (re)registration and teardown. */
export const IPC_INVOKE_CHANNELS: readonly InvokeChannel[] = Object.values(IPC);

/* ------------------------------------------------------------------ *
 * Payload types
 * ------------------------------------------------------------------ */

/** One forwarded state event (§2.2 订阅载荷). */
export interface StateUpdate {
  target: string;
  path: string;
  data: unknown;
}

/**
 * Connection status phases. The host currently reports the legacy subset
 * (connecting / reconnecting / ready / crashed); the union keeps the
 * ServerProcessHost phases (§2.9) so the channel vocabulary extends without
 * another contract break.
 */
export type ConnectionPhase =
  | 'connecting'
  | 'reconnecting'
  | 'ready'
  | 'crashed'
  | 'degraded'
  | 'restarting'
  | 'fatal'
  | 'stopped';

export interface ConnectionStatus {
  phase: ConnectionPhase;
  detail?: string;
  sessionId?: string;
}

/** Session index entry (§4.2 工作项⑤): time + summary per session. */
export interface SessionIndexEntry {
  sessionId: string;
  /** Explicit title when present, else the first user input (summary). */
  title: string | null;
  createdAt: number;
  lastActiveAt: number;
}

/** Renderer log entry on the log bridge (§2.9 UnifiedLogger). */
export interface RendererLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

/** `wayang:window` payload: the live window state (§2.1 custom header). */
export interface WindowStateUpdate {
  /** Native fullscreen — macOS hides the traffic lights while in it. */
  fullscreen: boolean;
}

/** Result of saving the envelope (§2.4/§2.11): what took effect, and how. */
export interface SaveConfigResult {
  /** Op methods applied to the RUNNING server (hot path), in order. */
  applied: string[];
  /** Human-readable notes for fields that need a server restart. */
  restartRequired: string[];
  /** True when the save booted the server (first-boot / not-running path). */
  booted: boolean;
}

/** `wayang:readConfig` payload: the current envelope (§4.3 工作项②). */
export interface ReadConfigResult {
  config: WayangConfig;
  desktop: Record<string, unknown>;
}

/** `wayang:chooseDirectory` payload (§4.3 工作项②): picked path or null. */
export interface ChooseDirectoryResult {
  path: string | null;
}

/**
 * `wayang:windowControl` action — the custom header's traffic-light dots.
 * `toggleZoom` is the green button: macOS system fullscreen, maximize on the
 * other platforms (see WindowManager.toggleZoom).
 */
export type WindowControlAction = 'minimize' | 'toggleZoom' | 'close';

/** Envelope every typed invoke resolves/rejects through (§2.2 typedHandle/typedInvoke). */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/* ------------------------------------------------------------------ *
 * Typed invoke contract: channel → { args, result }
 * ------------------------------------------------------------------ */

export interface IpcInvokeContract {
  [IPC.sendInput]: { args: [text: string]; result: void };
  [IPC.abort]: { args: []; result: void };
  [IPC.answerInquiry]: { args: [answer: string]; result: void };
  [IPC.respondPermission]: {
    args: [request: { requestId: string; approved: boolean; reason?: string }];
    result: unknown;
  };
  [IPC.listTasks]: { args: [status?: TaskDetail['status']]; result: TaskDetail[] };
  [IPC.cancelTask]: { args: [taskId: string]; result: void };
  [IPC.contextUsage]: { args: []; result: ContextUsage | null };
  /**
   * The full renderer initial state (§2.7): every subscribed slice's current
   * value plus the current connection status — so a first paint (or a
   * refresh) converges in ONE pull without racing the status event stream.
   */
  [IPC.getInitialState]: { args: []; result: InitialStateSnapshot };
  [IPC.newSession]: { args: []; result: { sessionId: string } };
  [IPC.switchSession]: { args: [sessionId: string]; result: { sessionId: string } };
  [IPC.listSessions]: { args: []; result: SessionIndexEntry[] };
  [IPC.rendererLog]: { args: [entry: RendererLogEntry]; result: void };
  [IPC.getOnboardState]: { args: []; result: OnboardState };
  [IPC.importCliConfig]: { args: []; result: { config: WayangConfig } };
  [IPC.saveConfig]: {
    args: [config: WayangConfig, desktop?: Record<string, unknown>];
    result: SaveConfigResult;
  };
  [IPC.readConfig]: { args: []; result: ReadConfigResult };
  [IPC.chooseDirectory]: { args: []; result: ChooseDirectoryResult };
  [IPC.restartServer]: { args: []; result: { sessionId: string } };
  [IPC.windowControl]: { args: [action: WindowControlAction]; result: void };
}

/** Snapshot payload of `wayang:getInitialState` (§2.7). */
export interface InitialStateSnapshot {
  status: ConnectionStatus;
  /** Slice values keyed by `${target}:${path}` (null = not set server-side). */
  slices: Record<string, unknown>;
}

/** Typed subscribe contract: channel → { payload }. */
export interface IpcSubscribeContract {
  [IPC_SUBSCRIBE.state]: { payload: StateUpdate };
  [IPC_SUBSCRIBE.status]: { payload: ConnectionStatus };
  [IPC_SUBSCRIBE.window]: { payload: WindowStateUpdate };
}

export type InvokeChannel = keyof IpcInvokeContract;
export type SubscribeChannel = keyof IpcSubscribeContract;

/* ------------------------------------------------------------------ *
 * Argument validation (§2.2 typedHandle 入参校验) — runtime guards for the
 * boundary crossing, one per invoke channel.
 * ------------------------------------------------------------------ */

/** Returns a human-readable problem, or null when the arguments are valid. */
export type IpcArgValidator = (args: readonly unknown[]) => string | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (value: unknown, label: string): string | null =>
  typeof value === 'string' ? null : `${label} must be a string`;

export const IPC_ARG_VALIDATORS: Readonly<Record<InvokeChannel, IpcArgValidator>> = {
  [IPC.sendInput]: (args) => {
    if (args.length !== 1) return 'sendInput takes exactly one argument';
    return requireString(args[0], 'sendInput text');
  },
  [IPC.abort]: (args) => (args.length === 0 ? null : 'abort takes no arguments'),
  [IPC.answerInquiry]: (args) => {
    if (args.length !== 1) return 'answerInquiry takes exactly one argument';
    return requireString(args[0], 'answerInquiry answer');
  },
  [IPC.respondPermission]: (args) => {
    if (args.length !== 1) return 'respondPermission takes exactly one argument';
    const request = args[0];
    if (!isRecord(request)) return 'respondPermission request must be an object';
    if (typeof request.requestId !== 'string') return 'respondPermission requestId must be a string';
    if (typeof request.approved !== 'boolean') return 'respondPermission approved must be a boolean';
    if (request.reason !== undefined && typeof request.reason !== 'string') return 'respondPermission reason must be a string';
    return null;
  },
  [IPC.listTasks]: (args) => {
    if (args.length > 1) return 'listTasks takes at most one argument';
    if (args[0] !== undefined && typeof args[0] !== 'string') return 'listTasks status must be a string';
    return null;
  },
  [IPC.cancelTask]: (args) => {
    if (args.length !== 1) return 'cancelTask takes exactly one argument';
    return requireString(args[0], 'cancelTask taskId');
  },
  [IPC.contextUsage]: (args) => (args.length === 0 ? null : 'contextUsage takes no arguments'),
  [IPC.getInitialState]: (args) => (args.length === 0 ? null : 'getInitialState takes no arguments'),
  [IPC.newSession]: (args) => (args.length === 0 ? null : 'newSession takes no arguments'),
  [IPC.switchSession]: (args) => {
    if (args.length !== 1) return 'switchSession takes exactly one argument';
    const problem = requireString(args[0], 'switchSession sessionId');
    if (problem) return problem;
    return (args[0] as string).length > 0 ? null : 'switchSession sessionId must be non-empty';
  },
  [IPC.listSessions]: (args) => (args.length === 0 ? null : 'listSessions takes no arguments'),
  [IPC.rendererLog]: (args) => {
    if (args.length !== 1) return 'rendererLog takes exactly one argument';
    const entry = args[0];
    if (!isRecord(entry)) return 'rendererLog entry must be an object';
    if (!['debug', 'info', 'warn', 'error'].includes(String(entry.level))) {
      return 'rendererLog level must be debug | info | warn | error';
    }
    if (typeof entry.message !== 'string') return 'rendererLog message must be a string';
    if (entry.data !== undefined && !isRecord(entry.data)) return 'rendererLog data must be an object';
    return null;
  },
  [IPC.getOnboardState]: (args) => (args.length === 0 ? null : 'getOnboardState takes no arguments'),
  [IPC.importCliConfig]: (args) => (args.length === 0 ? null : 'importCliConfig takes no arguments'),
  [IPC.saveConfig]: (args) => {
    if (args.length !== 1 && args.length !== 2) return 'saveConfig takes a config and an optional desktop prefs object';
    if (!isRecord(args[0])) return 'saveConfig config must be an object';
    if (args[1] !== undefined && !isRecord(args[1])) return 'saveConfig desktop prefs must be an object';
    return null;
  },
  [IPC.readConfig]: (args) => (args.length === 0 ? null : 'readConfig takes no arguments'),
  [IPC.chooseDirectory]: (args) => (args.length === 0 ? null : 'chooseDirectory takes no arguments'),
  [IPC.restartServer]: (args) => (args.length === 0 ? null : 'restartServer takes no arguments'),
  [IPC.windowControl]: (args) => {
    if (args.length !== 1) return 'windowControl takes exactly one argument';
    if (typeof args[0] !== 'string' || !['minimize', 'toggleZoom', 'close'].includes(args[0])) {
      return 'windowControl action must be minimize | toggleZoom | close';
    }
    return null;
  },
};

/* ------------------------------------------------------------------ *
 * Invoke timeouts (§2.2 typedInvoke 统一超时保护)
 * ------------------------------------------------------------------ */

/** Default guard for typedInvoke. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 15_000;

/**
 * Per-channel overrides. Session switches run the graceful stop protocol
 * (SHUTDOWN → 5s grace → kill) plus a full boot (30s ready timeout), so they
 * get a wider guard than plain RPC forwards.
 */
export const INVOKE_TIMEOUT_OVERRIDES_MS: Partial<Record<InvokeChannel, number>> = {
  [IPC.newSession]: 60_000,
  [IPC.switchSession]: 60_000,
  // A save may boot the server (30s ready timeout) before resolving.
  [IPC.saveConfig]: 60_000,
  [IPC.restartServer]: 60_000,
};

/** Effective timeout for a channel (override when present, else the default). */
export function invokeTimeoutMs(channel: InvokeChannel): number {
  return INVOKE_TIMEOUT_OVERRIDES_MS[channel] ?? DEFAULT_INVOKE_TIMEOUT_MS;
}

/* ------------------------------------------------------------------ *
 * Convenience re-exports for typed call sites
 * ------------------------------------------------------------------ */

export type {
  ActiveWorkerInfo,
  ContextUsage,
  ControllerSignal,
  ConversationEntry,
  InquireQuestion,
  TaskDetail,
  WayangConfig,
};
