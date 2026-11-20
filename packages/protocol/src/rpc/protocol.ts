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
  error: { code: number; message: string };
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

/** Error carrying an RPC error code — thrown by handlers to surface structured errors. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
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
} as const;

// --- Notifications (server → client) ---

export const NOTIFY = {
  READY: 'ready',
  STATE_EVENT: 'state.event',
} as const;

/** Subscribable state targets exposed over RPC. */
export const RPC_TARGETS = ['controllerAgent', 'signalQueue', 'engine'] as const;
export type RpcTarget = (typeof RPC_TARGETS)[number];
