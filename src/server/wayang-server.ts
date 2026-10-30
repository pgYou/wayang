/**
 * WayangServer — headless logic process core.
 *
 * Boots a Supervisor (zero ink/react dependencies) and exposes it over
 * RPC v1. All interactive UX (onboard, session select) stays in the
 * client; the server receives decisions as options.
 */

import { loadConfig } from '@/onboard';
import { Supervisor } from '@/services/supervisor';
import { getSession } from '@/infra/session-helpers';
import { RpcServer } from '@/rpc/rpc-server';
import { createStreamTransport } from '@/rpc/transport';
import { METHOD, NOTIFY, RpcError, RPC_ERROR, type RpcTarget } from '@/rpc/protocol';
import { serializeTurnView, summarizeTurn, DEFAULT_TURN_TEXT_LIMIT } from '@/services/conversation/turn-serialize';
import type { Subscribable } from '@/infra/state/subscribable';
import type { TaskDetail } from '@/types/index';

export interface WayangServerOptions {
  configPath: string;
  /** Wayang home dir (the `~/.wayang` equivalent, parent of `sessions/`). */
  homeDir: string;
  workspaceDir: string;
  /** Session decision made by the client: new, or resume a specific id. */
  session: { mode: 'new' } | { mode: 'resume'; sessionId: string };
  /** Sessionless inherit: surface unfinished tasks as a signal on resume. */
  injectPreviousTasks?: boolean;
  logLevel?: string;
}

export async function runWayangServer(
  options: WayangServerOptions,
  io: { stdin: import('node:stream').Readable; stdout: import('node:stream').Writable } = process,
): Promise<void> {
  const config = await loadConfig(options.configPath, { nonInteractive: true });

  let resume: { sessionId: string; sessionDir: string } | undefined;
  if (options.session.mode === 'resume') {
    const existing = getSession(options.homeDir, options.session.sessionId);
    if (!existing) throw new Error(`Session "${options.session.sessionId}" not found.`);
    resume = { sessionId: existing.sessionId, sessionDir: existing.sessionDir };
  }

  const supervisor = new Supervisor({
    config,
    workspaceDir: options.workspaceDir,
    logLevel: options.logLevel,
    resume,
    homeDir: options.homeDir,
    injectPreviousTasks: options.injectPreviousTasks,
  });

  await supervisor.restore();
  await supervisor.start();

  const transport = createStreamTransport(io.stdin, io.stdout);
  const rpc = new RpcServer(transport);

  const targets: Record<RpcTarget, Subscribable> = {
    controllerAgent: supervisor.controllerAgent,
    signalQueue: supervisor.signalQueue,
    engine: supervisor.engine,
  };
  const resolveTarget = (name: unknown): Subscribable => {
    const target = targets[name as RpcTarget];
    if (!target) throw new RpcError(RPC_ERROR.INVALID_PARAMS, `Unknown target: ${String(name)}`);
    return target;
  };

  // --- Subscriptions ---

  const subscriptions = new Map<string, () => void>();
  let nextSubscriptionId = 1;

  rpc.register(METHOD.SUBSCRIBE, (params) => {
    const target = resolveTarget(params.target);
    const path = requiredString(params, 'path');
    // Snapshot-then-subscribe, both synchronous — no event can slip between
    // (JS single thread), so clients always see a monotonic value stream.
    const data = target.getSnapshot(path);
    const subscriptionId = `sub-${nextSubscriptionId++}`;
    subscriptions.set(subscriptionId, target.subscribe(path, (event) => {
      rpc.notify(NOTIFY.STATE_EVENT, { subscriptionId, target: params.target, path, data: event.data });
    }));
    return { subscriptionId, data: data === undefined ? null : data };
  });

  rpc.register(METHOD.UNSUBSCRIBE, (params) => {
    const id = requiredString(params, 'subscriptionId');
    subscriptions.get(id)?.();
    subscriptions.delete(id);
    return {};
  });

  // --- Commands ---

  rpc.register(METHOD.SUBMIT_INPUT, (params) => {
    const text = requiredString(params, 'text');
    supervisor.signalQueue.enqueue({ source: 'user', type: 'input', payload: { text } });
    supervisor.sessionManager.onUserInput(text);
    return {};
  });

  rpc.register(METHOD.RESOLVE_INQUIRY, (params) => {
    supervisor.resolveInquiry(requiredString(params, 'answer'));
    return {};
  });

  rpc.register(METHOD.LIST_TASKS, (params) => {
    const status = typeof params.status === 'string' ? (params.status as TaskDetail['status']) : undefined;
    return supervisor.engine.list(status);
  });

  rpc.register(METHOD.CANCEL_TASK, (params) => {
    supervisor.engine.cancel(requiredString(params, 'taskId'));
    return {};
  });

  rpc.register(METHOD.UPDATE_TASK, (params) => {
    supervisor.engine.updatePending(
      requiredString(params, 'taskId'),
      (params.updates ?? {}) as Partial<Pick<TaskDetail, 'description' | 'priority'>>,
    );
    return {};
  });

  rpc.register(METHOD.RESPOND_PERMISSION, (params) => {
    const resolved = supervisor.engine.resolvePermission(
      requiredString(params, 'requestId'),
      params.approved === true,
      typeof params.reason === 'string' ? params.reason : undefined,
    );
    return { resolved };
  });

  rpc.register(METHOD.CHAT_WORKER, (params) => {
    supervisor.engine.sendMessageToWorker(requiredString(params, 'workerId'), requiredString(params, 'message'));
    return {};
  });

  rpc.register(METHOD.DISPOSE_WORKER, (params) => {
    supervisor.engine.abortByWorkerId(requiredString(params, 'workerId'));
    return {};
  });

  rpc.register(METHOD.PERFORM_COMPACTION, async () => {
    await supervisor.controllerAgent.performCompaction();
    return {};
  });

  rpc.register(METHOD.ABORT_CONTROLLER, () => {
    supervisor.controllerAgent.abort();
    return {};
  });

  rpc.register(METHOD.GET_STATUS, () => ({
    sessionId: supervisor.ctx.sessionId,
    sessionDir: supervisor.ctx.sessionDir,
    workspaceDir: supervisor.ctx.workspaceDir,
    busy: supervisor.controllerAgent.getSnapshot<boolean>('dynamicState.busy') ?? false,
    running: supervisor.engine.getRunningCount(),
    pending: supervisor.engine.list('pending').length,
    activeWorkers: supervisor.engine.getActiveWorkers(),
  }));

  rpc.register(METHOD.GET_SNAPSHOT, (params) => {
    const target = resolveTarget(params.target);
    const data = target.getSnapshot(requiredString(params, 'path'));
    return { data: data === undefined ? null : data };
  });

  // --- Read-only conversation index (WebUI / audit) ---

  rpc.register(METHOD.CONVERSATION_LIST_TURNS, (params) => {
    const index = supervisor.getConversationIndex();
    const limit = optionalInt(params, 'limit', 50, 1, 500);
    const offset = optionalInt(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const turns = index.turns
      .slice(offset, offset + limit)
      .map(view => summarizeTurn(view, { maxTextLength: optionalInt(params, 'previewLength', 200, 1, 2000) }));
    return { total: index.turns.length, offset, limit, turns };
  });

  rpc.register(METHOD.CONVERSATION_GET_TURN, (params) => {
    const turnId = requiredString(params, 'turnId');
    const view = supervisor.getTurn(turnId);
    if (!view) {
      throw new RpcError(RPC_ERROR.INVALID_PARAMS, `Unknown turnId: ${turnId}`);
    }
    return serializeTurnView(view, {
      // Optional — falls back to the serializer's DEFAULT_TURN_TEXT_LIMIT.
      maxTextLength: optionalInt(params, 'maxTextLength', DEFAULT_TURN_TEXT_LIMIT, 1, 100_000),
    });
  });

  rpc.register(METHOD.SHUTDOWN, () => {
    // Resolve first so the response frame is written synchronously, then
    // exit from a macrotask — microtask continuation (response send) runs first.
    setImmediate(() => {
      void supervisor
        .shutdown()
        .catch(() => { /* best effort */ })
        .finally(() => process.exit(0));
    });
    return {};
  });

  rpc.notify(NOTIFY.READY, {
    sessionId: supervisor.ctx.sessionId,
    sessionDir: supervisor.ctx.sessionDir,
    workspaceDir: supervisor.ctx.workspaceDir,
  });

  // SIGTERM (external kill): graceful shutdown like the old bootstrap path.
  process.on('SIGTERM', () => {
    void supervisor
      .shutdown()
      .catch(() => { /* best effort */ })
      .finally(() => process.exit(0));
  });
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(RPC_ERROR.INVALID_PARAMS, `Missing required string param: ${key}`);
  }
  return value;
}

/** Optional integer param with default and inclusive bounds. Rejects non-integers. */
function optionalInt(
  params: Record<string, unknown>,
  key: string,
  defaultValue: number | undefined,
  min: number,
  max: number,
): number {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    if (defaultValue === undefined) {
      throw new RpcError(RPC_ERROR.INVALID_PARAMS, `Missing required number param: ${key}`);
    }
    return defaultValue;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new RpcError(RPC_ERROR.INVALID_PARAMS, `Param ${key} must be an integer in [${min}, ${max}]`);
  }
  return raw;
}
