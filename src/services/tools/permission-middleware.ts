import type { SignalQueue } from '@/services/signal/signal-queue';
import type { SignalTurnLineage } from '@/types/index';
import { generateId } from '@/utils/id';

/** What a gated tool call needs before it may run. */
export interface PermissionVerdict {
  /** `allow` runs immediately, `ask` requests controller approval, `deny` refuses outright. */
  decision: 'allow' | 'ask' | 'deny';
  /**
   * Present on `deny`: the message returned to the caller instead of running
   * the tool. The policy layer builds it so it can control disclosure.
   */
  message?: string;
  /**
   * Present on `ask` when the policy escalated for a non-obvious reason (e.g.
   * "command substitution", "output redirection"). Appended to the approval
   * description so the controller understands why it is being asked.
   */
  reason?: string;
}

export interface PermissionMiddlewareConfig {
  /** Tool names that may require permission before execution. */
  gatedTools: string[];
  /**
   * Decide what a specific tool call needs.
   * `allow` passes through, `ask` blocks until the controller answers,
   * `deny` fails the call without ever emitting a permission_request.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- args shape is tool-specific (public config surface; policy callbacks read fields defensively)
  decide: (toolName: string, args: any) => PermissionVerdict;
  /** Generate a human-readable description of the tool call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as decide: tool-specific arg shape
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
  /** Turn lineage attached to emitted permission_request signals. */
  turnLineage?: SignalTurnLineage;
}

interface PendingPermission {
  resolve: (approved: boolean, reason?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PermissionMiddlewareResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors wrapWithPermissionMiddleware's tools param (heterogeneous tool set)
  wrappedTools: Record<string, any>;
  resolvePermission: (requestId: string, approved: boolean, reason?: string) => boolean;
  cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export function wrapWithPermissionMiddleware(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool set (zod-inferred per tool); see common.ts relaxation boundary
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
      execute: async (args: Record<string, unknown>, options?: unknown) => {
        const verdict = config.decide(toolName, args);

        // Fast path: the policy allows this specific call outright.
        if (verdict.decision === 'allow') {
          return originalExecute(args, options);
        }

        // Hard refusal (e.g. a denylisted path): never ask, never execute.
        if (verdict.decision === 'deny') {
          return verdict.message ?? `[ERROR] ${toolName}: refused by the path permission policy`;
        }

        const requestId = generateId('perm');
        const baseDescription = config.describeCall(toolName, args);
        // Surface a non-obvious escalation reason (command substitution,
        // output redirection, …) in the request so the controller can judge it.
        const description = verdict.reason
          ? `${baseDescription} [reason: ${verdict.reason}]`
          : baseDescription;

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
          ...(deps.turnLineage ?? {}),
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
