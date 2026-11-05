// WorkerWiringEngine: wires Wayang tools, the permission middleware and the
// ask_controller inquiry channel onto one worker run. Extends
// WorkerTrackingEngine.

import type { IWorkerInstance, TaskDetail } from '@/types/index';
import type { SignalTurnLineage } from '@/types/index';
import type { ApprovalMemoryMode } from '@/types/config';
import type { SignalQueue } from '@/services/signal/signal-queue';
import type { PermissionMiddlewareResult } from '@/services/tools/permission-middleware';
import type { ApprovalMemory } from '@/services/permission/approval-memory';
import { getWorkerMeta } from '@/services/agents/worker-defaults';
import { createWorkerTools } from '@/services/tools/index';
import { askControllerTool } from '@/services/tools/ask-controller';
import { wrapWithPermissionMiddleware } from '@/services/tools/permission-middleware';
import {
  FILE_TOOL_NAMES,
  decideToolAccess,
  expandHome,
  type WorkerAccessScope,
} from '@/services/tools/permission-rules';
import { resolveApprovalMemory } from '@/infra/permission/permission-config';
import { BlockingRequestMap } from '@/infra/blocking-requests';
import { generateId } from '@/utils/id';
import { resolve } from 'node:path';
import { WorkerTrackingEngine } from './worker-tracking';
import { PUPPET_WORKER_TYPE } from './engine-base';
import type { WorkerInquiryResolution } from './types';

/** How long a worker waits for a controller answer before continuing on its own. */
const INQUIRY_TIMEOUT_MS = 300_000;

/**
 * Engine-side view of the optional worker members `wireWorker` drives (freeze
 * §7 ②). Detected by MEMBER PRESENCE, not instanceof: every worker type that
 * implements the surface (ClaudeCodeWorker, the ACP skeleton) gets wired the
 * same way, and the engine stays free of concrete worker imports. Workers
 * without a member are simply skipped — e.g. ACP workers have no inquiry
 * channel (02 §6 `inquiry: false`), so `setInquirySupport` never fires there.
 */
type InquiryCapableWorker = IWorkerInstance & {
  setInquirySupport?: (ask: (question: string, context?: string) => Promise<string>) => void;
};

/** `setSignalContext` deps as the engine builds them (freeze §7 ② / 04 §3). */
interface SignalContextDeps {
  signalQueue: SignalQueue;
  workerId: string;
  taskId: string;
  taskTitle: string;
  workerType?: string;
  emoji?: string;
  turnLineage?: SignalTurnLineage;
  accessScope?: WorkerAccessScope;
  /** Task-scoped approval-memory store (#46) — reaches the worker's own permission path. */
  grants?: ApprovalMemory;
  /** Whether grants are remembered at all (`permission.approvalMemory`). */
  approvalMemory?: ApprovalMemoryMode;
}

type SignalContextCapableWorker = IWorkerInstance & {
  setSignalContext?: (deps: SignalContextDeps) => void;
  /** Resolve controller answers for this worker's permission requests. */
  permissionHandler?: PermissionMiddlewareResult;
};

export abstract class WorkerWiringEngine extends WorkerTrackingEngine {
  /**
   * Wire Wayang tools + permission middleware + signal context onto a worker.
   * Shared between fresh-spawn and idle-reuse paths.
   * Returns the tool set ready for `worker.run()`.
   */
  protected wireWorker(
    worker: IWorkerInstance,
    task: TaskDetail,
    workerId: string,
    workerType: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous zod-inferred tool set feeding IWorkerInstance.run (see common.ts relaxation boundary)
  ): Record<string, any> {
    const workerMeta = getWorkerMeta(workerType, this.workerConfigs);
    // Single source of truth for this run's filesystem boundary: the task's
    // own workspace (canonical), falling back to the process workspace only
    // for tasks without an identity. Derived once so the tool cwd, the
    // permission gate and the call descriptions cannot drift apart.
    const workspace = this.taskWorkspaceDir(task);

    // Everything the shared access policy needs for this run, assembled once:
    // the task's workspace is the cwd and the writable boundary, the user's
    // home anchors the sensitive list / read scope, the task's allowedDirs are
    // the per-task grant and the config section supplies user allow/sensitive
    // roots.
    const accessScope: WorkerAccessScope = {
      userHome: this.userHome,
      workspace,
      taskAllowedDirs: task.taskAllowedDirs,
      permission: this.permission,
    };

    // Blocking-request registry for this worker run's ask_controller calls.
    const inquiryRegistry = new BlockingRequestMap<WorkerInquiryResolution>();
    this.inquiryRegistries.set(workerId, inquiryRegistry);
    const askAndWait = async (question: string, context?: string): Promise<string> => {
      const inquiryId = generateId('inq');
      this.enqueueWorkerSignal(workerId, {
        source: 'worker',
        type: 'worker_inquiry',
        payload: {
          inquiryId, workerId,
          taskId: task.id, taskTitle: task.title,
          workerType, emoji: workerMeta.emoji,
          question,
          ...(context !== undefined && { context }),
        },
      });
      const resolution = await inquiryRegistry.wait(inquiryId, INQUIRY_TIMEOUT_MS, () => {
        // Timed out — the worker continues on its own; tell the controller.
        this.enqueueWorkerSignal(workerId, {
          source: 'system',
          type: 'inquiry_timeout',
          payload: { inquiryId, workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: workerMeta.emoji, question },
        });
        return { kind: 'timeout' as const };
      });
      if (resolution.kind === 'answer') return `[Controller] ${resolution.answer}`;
      if (resolution.kind === 'timeout') {
        return '[TIMEOUT] No answer from the controller within 5 minutes. Use your best judgment to continue and report the decision via update_progress or done.';
      }
      return '[ABORTED] Worker is shutting down.';
    };

    // Puppet workers need Wayang tools; third-party workers don't use them
    let tools = workerType === PUPPET_WORKER_TYPE
      ? {
          ...createWorkerTools({
          listTasks: (status?: TaskDetail['status']) => this.list(status),
          cwd: workspace,
          // `~` expansion in the tools anchors on the PROCESS home
          // (`expandHome`), the same anchor the permission gate below
          // (accessScope) judges expanded paths with — no injection needed.
          tavilyApiKey: this.ctx.config.tavilyApiKey,
          registry: this.skills,
          reportProgress: (msg: string, _percent?: number) => {
            const activity = this.getWorkerActivity(workerId);
            this.enqueueWorkerSignal(workerId, {
              source: 'worker',
              type: 'progress',
              payload: {
                workerId, taskId: task.id, taskTitle: task.title, workerType, emoji: workerMeta.emoji, message: msg,
                lastActivityAt: activity.lastActivityAt,
                currentTool: activity.currentTool,
              },
            });
          },
          onComplete: (summary: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WorkerAgent's terminal methods are not on the IWorkerInstance interface; dispatch by concrete worker type
            (worker as any).complete(summary);
          },
          onFail: (error: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see onComplete above
            (worker as any).fail(error);
          },
        }),
          ask_controller: askControllerTool({ ask: askAndWait }),
        }
      : {};

    // Third-party workers get ask_controller through their own channel when
    // they expose one (ClaudeCodeWorker: in-process SDK MCP tool; ACP workers
    // expose none — 02 §6 — and are skipped by the probe).
    const inquiryCapable = worker as InquiryCapableWorker;
    if (typeof inquiryCapable.setInquirySupport === 'function') {
      inquiryCapable.setInquirySupport(askAndWait);
    }

    // Apply permission middleware for puppet workers
    if (workerType === PUPPET_WORKER_TYPE) {
      const middleware = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['bash', ...FILE_TOOL_NAMES],
        // Single decision source: the shared access policy (sensitive list →
        // config roots → task allowedDirs → task workspace → read-in-home →
        // ask). `deny` refuses here without ever emitting a permission_request;
        // both `deny` and every answered `ask` are audited (see the middleware).
        decide: (toolName, args) => decideToolAccess(accessScope, toolName, args),
        describeCall: (toolName, args, verdict) => {
          if (toolName === 'bash') return `Execute shell command: ${args.command}`;
          if ((FILE_TOOL_NAMES as readonly string[]).includes(toolName)) {
            const rawPath = typeof args.path === 'string' ? args.path : '';
            if (!rawPath) return `${toolName}: (workspace root) (resolved: ${workspace})`;
            // The description must name the path the gate actually JUDGED, not
            // one re-derived here: `resolve()` alone left `~` / `$HOME`
            // unexpanded, so `read_file ~/.wayang.config.json` reached the
            // controller (and the TUI) as `<workspace>/~/.wayang.config.json` —
            // a path that does not exist and that nobody recognizes as their
            // own config. Expansion goes through the SAME `expandHome` the gate
            // uses, and the canonical target the policy resolved wins when the
            // verdict carries one (it also normalizes symlinks).
            const expanded = expandHome(rawPath);
            if (expanded.unresolvable) {
              // `~user` names another user's home and is deliberately NOT
              // expanded (see `HomeExpansion`) — show what was asked for.
              return `${toolName}: ${rawPath} (unresolved: another user's home cannot be expanded)`;
            }
            const target = verdict?.resolvedPath ?? resolve(workspace, expanded.path);
            return `${toolName}: ${rawPath} (resolved: ${target})`;
          }
          return `${toolName}: ${JSON.stringify(args)}`;
        },
      }, {
        workerId,
        taskId: task.id,
        taskTitle: task.title,
        workerType,
        emoji: workerMeta.emoji,
        signalQueue: this.signalQueue,
        turnLineage: this.workerLineage(workerId),
        // Permission audit trail (metadata only) shares the session logger.
        logger: this.ctx.logger,
        // Task-scoped approval memory (#46): the switch comes from
        // `permission.approvalMemory`, the store is this engine's per-session
        // one, cleared per task on the terminal transitions (see
        // `clearApprovalGrants`).
        approvalMemory: resolveApprovalMemory(this.permission),
        grants: this.approvalGrants,
      });
      tools = middleware.wrappedTools;
      this.permissionResolvers.set(workerId, middleware);
    }

    // Wire signal context for workers that expose it (ClaudeCodeWorker's
    // canUseTool + acceptMessage, the ACP skeleton's permission bridge).
    // The SAME access scope used for puppet workers is handed over, so both
    // reach identical allow/ask/deny verdicts.
    const signalCapable = worker as SignalContextCapableWorker;
    if (typeof signalCapable.setSignalContext === 'function') {
      signalCapable.setSignalContext({
        signalQueue: this.signalQueue,
        workerId,
        taskId: task.id,
        taskTitle: task.title,
        workerType,
        emoji: workerMeta.emoji,
        turnLineage: this.workerLineage(workerId),
        accessScope,
        // Task-scoped approval memory (#46), same store/mode the puppet
        // middleware above gets — the ACP permission bridge consumes them
        // (04 §3); ClaudeCodeWorker currently ignores the two extras.
        grants: this.approvalGrants,
        approvalMemory: resolveApprovalMemory(this.permission),
      });
    }
    // Controller answers flow back through the worker's own resolver
    // (respond_permission → resolvePermission) — registered for ACP workers
    // exactly like it was for ClaudeCodeWorker.
    if (signalCapable.permissionHandler) {
      this.permissionResolvers.set(workerId, signalCapable.permissionHandler);
    }

    return tools;
  }
}
