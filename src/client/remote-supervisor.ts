/**
 * RemoteSupervisor — client-side facade presenting the same surface the
 * TUI consumed from the in-process Supervisor, but backed by RPC.
 *
 * `getSnapshot` is served from the RemoteStateStore cache (undefined
 * until the first subscribe response lands — TUI components tolerate
 * that with `?? fallback` defaults).
 */

import { RemoteSubscribable, type RpcClient, type RemoteStateStore } from '@/rpc/rpc-client';
import { METHOD } from '@/rpc/protocol';
import type { ActiveWorkerInfo, ContextUsage, NewSignalInput, TaskDetail } from '@/types/index';

/**
 * State path of the controller's context usage snapshot. Single shared literal
 * for the facade below and the TUI status bar subscription.
 */
export const CONTEXT_USAGE_STATE_PATH = 'dynamicState.contextUsage';

export interface RemoteSupervisorHooks {
  /** Terminate the server child process (graceful, then force-kill). */
  stop: () => Promise<void>;
}

export class RemoteSupervisor {
  readonly ctx: { workspaceDir: string };
  readonly controllerAgent: RemoteSubscribable & {
    abort(): void;
    performCompaction(): Promise<void>;
  };
  readonly signalQueue: RemoteSubscribable & {
    enqueue(sig: NewSignalInput): void;
  };
  readonly engine: RemoteSubscribable & {
    list(status?: TaskDetail['status']): Promise<TaskDetail[]>;
    cancel(taskId: string): Promise<void>;
    getActiveWorkers(): ActiveWorkerInfo[];
  };
  readonly sessionManager: { onUserInput(_text: string): void };

  constructor(
    private readonly rpc: RpcClient,
    store: RemoteStateStore,
    workspaceDir: string,
    private readonly hooks: RemoteSupervisorHooks,
  ) {
    this.ctx = { workspaceDir };

    this.controllerAgent = Object.assign(new RemoteSubscribable(store, 'controllerAgent'), {
      abort: () => {
        void this.rpc.request(METHOD.ABORT_CONTROLLER).catch(() => { /* best effort */ });
      },
      performCompaction: async () => {
        await this.rpc.request(METHOD.PERFORM_COMPACTION);
      },
    });

    this.signalQueue = Object.assign(new RemoteSubscribable(store, 'signalQueue'), {
      enqueue: (sig: NewSignalInput) => {
        if (sig.source !== 'user' || sig.type !== 'input') {
          throw new Error('RemoteSupervisor.signalQueue.enqueue only supports user input signals; use dedicated RPC commands');
        }
        void this.rpc.request(METHOD.SUBMIT_INPUT, { text: (sig.payload as { text: string }).text })
          .catch(() => { /* server relays errors via signals */ });
      },
    });

    this.engine = Object.assign(new RemoteSubscribable(store, 'engine'), {
      list: (status?: TaskDetail['status']) =>
        this.rpc.request<TaskDetail[]>(METHOD.LIST_TASKS, status ? { status } : {}),
      cancel: async (taskId: string) => {
        await this.rpc.request(METHOD.CANCEL_TASK, { taskId });
      },
      getActiveWorkers: () => (store.getSnapshot('engine', 'activeWorkers') as ActiveWorkerInfo[] | undefined) ?? [],
    });

    // session bookkeeping for user input happens server-side in submit_input.
    this.sessionManager = { onUserInput: () => { /* handled server-side */ } };
  }

  /**
   * Latest context usage snapshot, fetched on demand from the server via
   * GET_SNAPSHOT. Callers use this facade; the state path itself lives in the
   * shared CONTEXT_USAGE_STATE_PATH constant rather than being repeated at
   * each call site. Returns null when the server has no value yet.
   */
  async getContextUsage(): Promise<ContextUsage | null> {
    const res = await this.rpc.request<{ data: ContextUsage | null }>(
      METHOD.GET_SNAPSHOT,
      { target: 'controllerAgent', path: CONTEXT_USAGE_STATE_PATH },
    );
    return res.data ?? null;
  }

  resolveInquiry(answer: string): void {
    void this.rpc.request(METHOD.RESOLVE_INQUIRY, { answer }).catch(() => { /* best effort */ });
  }

  async shutdown(): Promise<void> {
    await this.hooks.stop();
  }
}
