import type { SignalQueue } from '@/services/signal/signal-queue';
import { generateId } from '@/utils/id';

export interface PermissionMiddlewareConfig {
  /** Tool names that may require permission before execution. */
  gatedTools: string[];
  /**
   * Determine whether a specific tool call needs permission.
   * Return true to block and request approval; false to pass through immediately.
   */
  needsPermission: (toolName: string, args: any) => boolean;
  /** Generate a human-readable description of the tool call. */
  describeCall: (toolName: string, args: any) => string;
}

export interface PermissionMiddlewareDeps {
  workerId: string;
  taskId: string;
  taskTitle: string;
  workerType?: string;
  emoji?: string;
  signalQueue: SignalQueue;
  timeoutMs?: number;
}

interface PendingPermission {
  resolve: (approved: boolean, reason?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PermissionMiddlewareResult {
  wrappedTools: Record<string, any>;
  resolvePermission: (requestId: string, approved: boolean, reason?: string) => boolean;
  cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export function wrapWithPermissionMiddleware(
  tools: Record<string, any>,
  config: PermissionMiddlewareConfig,
  deps: PermissionMiddlewareDeps,
): PermissionMiddlewareResult {
  const pending = new Map<string, PendingPermission>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gatedSet = new Set(config.gatedTools);

  const wrappedTools = { ...tools };

  for (const toolName of Object.keys(tools)) {
    if (!gatedSet.has(toolName)) continue;

    const originalExecute = tools[toolName].execute;
    wrappedTools[toolName] = {
      ...tools[toolName],
      execute: async (args: any, options?: any) => {
        // Fast path: this specific call doesn't need permission
        if (!config.needsPermission(toolName, args)) {
          return originalExecute(args, options);
        }

        const requestId = generateId('perm');
        const description = config.describeCall(toolName, args);

        deps.signalQueue.enqueue({
          source: 'worker',
          type: 'permission_request',
          payload: {
            requestId,
            workerId: deps.workerId,
            taskId: deps.taskId,
            taskTitle: deps.taskTitle,
            workerType: deps.workerType,
            emoji: deps.emoji,
            toolName,
            toolArgs: args,
            description,
          },
        });

        interface PermissionResult {
          approved: boolean;
          reason?: string;
        }

        const result = await new Promise<PermissionResult>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve({ approved: false, reason: 'timeout' });
          }, timeoutMs);

          pending.set(requestId, {
            resolve: (ok: boolean, reason?: string) => {
              clearTimeout(timer);
              pending.delete(requestId);
              resolve({ approved: ok, reason });
            },
            timer,
          });
        });

        if (!result.approved) {
          if (result.reason === 'timeout') {
            return `[ERROR] Permission request timed out for ${toolName}`;
          }
          if (result.reason === 'Worker aborted') {
            return `[ERROR] Permission request cancelled: worker shutting down`;
          }
          return `[ERROR] Permission denied for ${toolName}: ${result.reason ?? 'operation not approved by controller'}`;
        }

        return originalExecute(args, options);
      },
    };
  }

  return {
    wrappedTools,
    resolvePermission(requestId: string, approved: boolean, reason?: string): boolean {
      const entry = pending.get(requestId);
      if (!entry) return false;
      entry.resolve(approved, reason);
      return true;
    },
    cleanup(): void {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve(false, 'Worker aborted');
        pending.delete(id);
      }
    },
  };
}
