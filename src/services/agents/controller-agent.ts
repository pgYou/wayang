/**
 * ControllerAgent — the controller LLM agent.
 *
 * The implementation lives in the `./controller-agent/` layer classes
 * (agent-base -> turn-run); this file is the stable import surface, the
 * public class name, the `create()` factory and the session/inquiry/UI API.
 */
import { ControllerAgentState } from '@/services/agents/controller-state';
import { applyTurnEnvelope, type TurnEnvelope } from './utils/entry-envelope';
import { ToolCallRecorder } from './utils/tool-call-recorder';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { ProviderConfig, TaskDetail, WayangConfig } from '@/types/index';
import type { ConversationEntry, ConversationIndex, TurnView } from '@/types/conversation';
import { EEntryType, ESystemSubtype } from '@/types/index';
import type { StateEvent } from '@/infra/state/base-state';
import type { Subscribable } from '@/infra/state/subscribable';

import { loadControllerRules } from './prompts/index';
import { createControllerTools } from '@/services/tools/index';
import { readWorkerTranscript, readWorkerTranscriptWindow } from '@/services/worker-transcript';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { ensureGeneralWorkspace, resolveGeneralWorkspace } from '@/infra/general-workspace';
import { homedir } from 'node:os';
import { SystemContext } from '@/infra/system-context';
import type { TaskExecuteEngine } from '@/services/task-execute-engine';
import type { SignalQueue } from '@/services/signal/signal-queue';
import { ControllerTurnRun } from './controller-agent/turn-run';

export class ControllerAgent extends ControllerTurnRun implements Subscribable {
  /**
   * Factory — create a ControllerAgent wired to the given services.
   *
   * The agent creates its own ControllerAgentState internally.
   */
  static create(opts: {
    ctx: SystemContext;
    provider: ProviderConfig;
    config: WayangConfig;
    engine: TaskExecuteEngine;
    signalQueue: SignalQueue;
    skills: import('@/services/skills/registry').SkillRegistry;
  }): ControllerAgent {
    const { ctx, provider, engine, signalQueue, skills } = opts;
    const state = new ControllerAgentState(ctx);
    // Recorder gets the logger so attachTask misses (no live tool-call
    // record) surface as debug logs instead of silent no-ops.
    const recorder = new ToolCallRecorder(ctx.logger);

    // The read scope for controller file access: the user's home the policy
    // anchors on. ALWAYS the process home — never derived from the session
    // layout (where wayang keeps its data, `--wayang-root`, has nothing to do
    // with whose home the policy protects). ~/.wayang itself is not sensitive
    // (0.8.3): it is wayang's own runtime data directory (sessions, audit
    // logs, worker temp files), and the sensitive list covers third-party
    // credentials only.
    const userHome = homedir();
    // The wayang DATA dir this session belongs to (workspace-registry lookups
    // key on it). Derived from the session layout — a data-dir concern, kept
    // separate from the user home above.
    const wayangDir = wayangDirForSessionDir(ctx.sessionDir);

    // Where tasks with no codebase of their own (research, collecting material,
    // drafting) run. Advertised by absolute path in add_task's description, so
    // create it once here — `mkdir -p`, idempotent. A failure is not fatal:
    // add_task reports it per call and the controller can pick another
    // workspace.
    const generalWorkspaceDir = resolveGeneralWorkspace(ctx);
    try {
      ensureGeneralWorkspace(ctx);
    } catch {
      ctx.logger.warn(`could not create the general workspace at ${generalWorkspaceDir}`);
    }

    // Startup rules (issue #38): the home AGENTS.md as baseline, the cwd one as
    // supplement, read once here — the prompt is built from this string and
    // never re-read between turns. Missing files yield an empty string, so the
    // prompt is unchanged when neither exists.
    const controllerRules = loadControllerRules({
      userHome,
      cwd: ctx.workspaceDir || process.cwd(),
    });

    const tools = createControllerTools({
      addTask: (task: TaskDetail) => engine.add(task),
      validateWorkerType: (type: string) => engine.validateWorkerType(type),
      assignToWorker: (workerId: string, task: TaskDetail) => engine.assignToExistingWorker(workerId, task),
      validateIdleWorker: (workerId: string) => engine.validateIdleWorker(workerId),
      validateWorkerWorkspace: (workerId: string, workspacePath: string) => engine.validateWorkerWorkspace(workerId, workspacePath),
      listTasks: (status?: TaskDetail['status']) => engine.list(status),
      getTask: (taskId: string) => engine.get(taskId),
      getWorkerConversation: (taskId: string) => engine.getWorkerConversation(taskId),
      // On-disk transcript access (issue #16): survives worker disposal, so a
      // finished/cancelled worker's scene stays readable by the controller.
      readTranscript: (workerId: string) => readWorkerTranscript(ctx.sessionDir, workerId),
      // Layered transcript access (issue #16 review): while the engine tracks
      // the worker, its live in-memory conversation is the source; the on-disk
      // jsonl lives under the worker instance's OWN id (agent-/cw-…), which
      // the engine exposes and tasks persist as workerTranscriptId.
      getWorkerConversationByWorkerId: (workerId: string) => engine.getWorkerConversationByWorkerId(workerId),
      getWorkerTranscriptId: (workerId: string) => engine.getWorkerTranscriptId(workerId),
      readTranscriptWindow: (workerId: string, opts) => readWorkerTranscriptWindow(ctx.sessionDir, workerId, opts),
      sessionDir: ctx.sessionDir,
      getActiveWorkers: () => engine.getActiveWorkers(),
      getWorkerLiveStatus: (workerId: string) => engine.getWorkerLiveStatus(workerId),
      cancelTask: (taskId: string) => engine.cancel(taskId),
      abortWorker: (taskId: string) => engine.abortByTaskId(taskId),
      updateTask: (taskId, updates) => engine.updatePending(taskId, updates),
      queryMessages: (filter) => signalQueue.query(filter),
      cwd: ctx.workspaceDir,
      userHome,
      // User-config permission section: add_task validates a task's allowedDirs
      // against the built-in sensitive list plus these configured
      // sensitiveDirs (the deprecated deniedDirs alias is merged in).
      permissionConfig: opts.config.permission,
      getNotebook: () => state.get<string>('runtimeState.notebook') ?? '',
      setNotebook: (content, mode) => {
        const current = state.get<string>('runtimeState.notebook') ?? '';
        state.set('runtimeState.notebook', mode === 'append' ? (current ? current + '\n' + content : content) : content);
      },
      inquire: (question) => state.askInquiry(question),
      sendMessageToWorker: (workerId, message) => engine.sendMessageToWorker(workerId, message),
      resolvePermission: (requestId, approved, reason) => engine.resolvePermission(requestId, approved, reason),
      resolveInquiry: (inquiryId, answer) => engine.resolveInquiry(inquiryId, answer),
      registry: skills,
      disposeWorker: (workerId) => engine.abortByWorkerId(workerId),
      // Turn lineage for tasks created by add_task (read from dynamicState,
      // which run() sets at the start of every controller activation).
      getTurnContext: () => state.get<TurnEnvelope | null>('dynamicState.currentTurn') ?? undefined,
      // toolCall→task audit link, consumed when the step entry is built.
      onTaskDispatched: ({ toolCallId, taskId }) => {
        if (toolCallId) recorder.attachTask(toolCallId, taskId);
      },
      // Default workspace for tasks created by add_task; a declared workspace
      // is stamped instead and the engine executes the task there.
      workspaceDir: ctx.workspaceDir,
      wayangDir,
      generalWorkspaceDir,
    });

    return new ControllerAgent(ctx, state, provider, tools, skills, recorder, controllerRules);
  }

  /** Initialize session metadata. Called by Supervisor at start. */
  initSession(session: { id: string; startedAt: number }): void {
    this.state.set('runtimeState.session', session);
  }

  /** Resolve a pending inquiry with the user's answer. */
  resolveInquiry(answer: string): void {
    this.state.resolveInquiry(answer);
  }

  /** Surface an error in the UI as a system conversation entry. */
  reportError(message: string): void {
    this.state.set('dynamicState.streamingEntries', []);
    const errTs = nowISO();
    const entry: ConversationEntry = {
      type: EEntryType.System,
      uuid: generateId('err'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: errTs,
      subtype: ESystemSubtype.Error,
      content: `${message}\n详情: ${this.ctx.sessionDir}/wayang.log`,
      // Point-in-time event: startedAt/endedAt share the recording moment.
      startedAt: errTs,
      endedAt: errTs,
    };
    // Attach to the most recent turn so the error is grouped with the run that
    // failed (reportError fires from the controller loop's catch path).
    applyTurnEnvelope(entry, this.lastTurnId !== null
      ? { turnId: this.lastTurnId, actor: { kind: 'controller', id: this.id } }
      : undefined);
    this.state.append('conversation', entry);
  }

  /** Read-only turn index over the controller conversation. */
  getConversationIndex(): ConversationIndex {
    return this.state.getConversationIndex();
  }

  /** Look up one turn by id. */
  getTurn(turnId: string): TurnView | undefined {
    return this.state.getTurn(turnId);
  }

  // --- Subscribable ---

  subscribe(path: string, callback: (event: StateEvent) => void): () => void {
    return this.state.on(path, callback);
  }

  getSnapshot<T>(path: string): T {
    return this.state.get(path);
  }
}
