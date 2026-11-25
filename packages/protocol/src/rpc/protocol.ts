/**
 * RPC v1 protocol — transport-agnostic message envelopes.
 *
 * 0.5 uses newline-delimited JSON over stdio; the same message set is
 * intended for WebSocket when the WebUI lands (0.6). See
 * docs/develop/v0.5-server-rpc-design.md §3.
 */

// --- Messages ---

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcSuccess {
  id: number;
  result: unknown;
}

export interface RpcFailure {
  id: number;
  /** JSON-RPC error envelope; `data` is an optional structured payload (design 4.1 热更引用清单). */
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccess | RpcFailure;

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const RPC_ERROR = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32002,
  INTERNAL: -32000,
} as const;

/**
 * Error carrying an RPC error code — thrown by handlers to surface structured
 * errors. `data` rides along in the failure envelope's `error.data` (the
 * JSON-RPC standard slot), e.g. the reference list that blocks a config
 * removal; older clients simply ignore it.
 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** Optional structured payload surfaced as `error.data` on the wire. */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function isRpcRequest(msg: RpcMessage): msg is RpcRequest {
  return 'method' in msg && 'id' in msg;
}

export function isRpcResponse(msg: RpcMessage): msg is RpcResponse {
  return 'id' in msg && !('method' in msg);
}

// --- Methods (client → server) ---

export const METHOD = {
  SUBMIT_INPUT: 'submit_input',
  RESOLVE_INQUIRY: 'resolve_inquiry',
  LIST_TASKS: 'list_tasks',
  CANCEL_TASK: 'cancel_task',
  UPDATE_TASK: 'update_task',
  RESPOND_PERMISSION: 'respond_permission',
  RESPOND_WORKER_INQUIRY: 'respond_worker_inquiry',
  CHAT_WORKER: 'chat_worker',
  DISPOSE_WORKER: 'dispose_worker',
  PERFORM_COMPACTION: 'perform_compaction',
  ABORT_CONTROLLER: 'abort_controller',
  GET_STATUS: 'get_status',
  GET_SNAPSHOT: 'get_snapshot',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  SHUTDOWN: 'shutdown',
  /** Read-only: list turns of the controller conversation (limit/offset). */
  CONVERSATION_LIST_TURNS: 'conversation_list_turns',
  /** Read-only: one turn of the controller conversation by turnId. */
  CONVERSATION_GET_TURN: 'conversation_get_turn',
  // --- Runtime config hot-update (monorepo-design 4.1 运行时热更) ---
  /** updateProvider(name, patch) — declared-value only, effective next turn/spawn. */
  UPDATE_PROVIDER: 'update_provider',
  /** updateModel(name, patch) — declared-value only, effective next turn/spawn. */
  UPDATE_MODEL: 'update_model',
  /** addProvider(name, def) — strict duplicate-name rejection. */
  ADD_PROVIDER: 'add_provider',
  /** addModel(name, def) — strict duplicate-name rejection. */
  ADD_MODEL: 'add_model',
  /** removeProvider(name) — rejected with a reference list when still referenced. */
  REMOVE_PROVIDER: 'remove_provider',
  /** removeModel(name) — rejected with a reference list when still bound. */
  REMOVE_MODEL: 'remove_model',
  /** updateControllerModel(model) — rebinds the controller binding (next turn). */
  UPDATE_CONTROLLER_MODEL: 'update_controller_model',
  /** updateWorkerSettings(patch) — default worker binding + settings (next spawn). */
  UPDATE_WORKER_SETTINGS: 'update_worker_settings',
} as const;

// --- Notifications (server → client) ---

export const NOTIFY = {
  READY: 'ready',
  STATE_EVENT: 'state.event',
} as const;

/** Subscribable state targets exposed over RPC. */
export const RPC_TARGETS = ['controllerAgent', 'signalQueue', 'engine'] as const;
export type RpcTarget = (typeof RPC_TARGETS)[number];
