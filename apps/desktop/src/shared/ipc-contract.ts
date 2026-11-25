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
} from '@wayang-ai/protocol';

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
} as const;

export const IPC_SUBSCRIBE = {
  /** `NOTIFY state.event` forwarded one by one (target + path + data). */
  state: 'wayang:state',
  /** Connection status machine (§2.9 phases). */
  status: 'wayang:status',
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
  [IPC.getInitialState]: { args: []; result: Record<string, unknown> };
  [IPC.newSession]: { args: []; result: { sessionId: string } };
  [IPC.switchSession]: { args: [sessionId: string]; result: { sessionId: string } };
  [IPC.listSessions]: { args: []; result: SessionIndexEntry[] };
  [IPC.rendererLog]: { args: [entry: RendererLogEntry]; result: void };
}

/** Typed subscribe contract: channel → { payload }. */
export interface IpcSubscribeContract {
  [IPC_SUBSCRIBE.state]: { payload: StateUpdate };
  [IPC_SUBSCRIBE.status]: { payload: ConnectionStatus };
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
};
