import { ControllerAgentState } from '@/services/agents/controller-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { applyTurnEnvelope, syncStepTimestamps, type TurnEnvelope } from './utils/entry-envelope';
import { ToolCallRecorder } from './utils/tool-call-recorder';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { ControllerSignal, ProviderConfig, TaskDetail, WayangConfig } from '@/types/index';
import type { ConversationEntry, ConversationIndex, TurnView } from '@/types/conversation';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { signalToEntry } from './utils/signal-to-entry';
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
import { ControllerAgentBase } from './controller-agent/agent-base';

export class ControllerAgent extends ControllerAgentBase implements Subscribable {
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

  /** Run the controller agent — streams text chunks while updating streamingEntries in state. */
  async run(signals: ControllerSignal[]): Promise<{ text: string }> {
    // Fresh abort channel per turn: an abort (ESC / RPC) applies to
    // THIS run only. Without the reset, the agent-lifetime controller stays
    // aborted forever and every later turn would silently return empty.
    this.resetAbortController();
    this.state.set('dynamicState.busy', true);
    try {
      return await this._run(signals);
    } finally {
      this.state.set('dynamicState.busy', false);
    }
  }

  private async _run(signals: ControllerSignal[]): Promise<{ text: string }> {
    const ts = nowISO();

    // --- Turn identity: one controller activation = one turn ---
    // User input starts a new chain (rootTurnId = this turn); a signal-triggered
    // run inherits the signal's rootTurnId (the user turn that started the
    // chain) and records the triggering signal as its cause.
    const turnId = generateId('turn');
    const hasUserInput = signals.some(s => s.type === 'input');
    const rootTurnId = hasUserInput
      ? turnId
      : signals.find(s => s.rootTurnId !== undefined)?.rootTurnId;
    const causationId = signals[0]?.id;
    const turnEnv: TurnEnvelope = {
      turnId,
      ...(rootTurnId !== undefined && { rootTurnId }),
      ...(causationId !== undefined && { causationId }),
      actor: { kind: 'controller', id: this.id },
      // Controller entries carry the process workspace's slug so they are
      // attributable to a directory just like worker entries. Undefined only
      // when the context carries no workspace directory.
      ...(this.workspaceSlug !== undefined && { workspaceSlug: this.workspaceSlug }),
    };
    this.state.set('dynamicState.currentTurn', turnEnv);
    this.lastTurnId = turnId;
    this.recorder.beginTurn();
    this.turnInterruptRecorded = false;

    // Append incoming signals to conversation. Signal entries keep their own
    // lineage (rootTurnId / causationId / actor from the originating worker)
    // and join the consuming turn via turnId.
    for (const sig of signals) {
      const entry = signalToEntry(sig, ts, this.ctx.sessionId);
      applyTurnEnvelope(entry, turnEnv);
      this.state.append('conversation', entry);
    }

    // Clear stale streaming entries from previous run
    this.state.set('dynamicState.streamingEntries', []);

    // Build a mutable streaming entry to accumulate text chunks
    let streamingEntry = this.createStreamingEntry();

    const gen = this.streamLoop({
      system: this.contextManager.getSystemPrompt(),
      messages: this.contextManager.getMessages(),
      tools: this.tools,
      maxSteps: 50,
      stopTools: ['skip_reply'],
      onStreamError: (err) => {
        // An aborted turn reports AbortError through onError — expected user
        // action, not a provider failure. Keep it out of the error log.
        if (this.abortController.signal.aborted) {
          this.logger.debug({ agent: 'controller', err }, 'LLM stream aborted by user');
          return;
        }
        this.logger.error({ agent: 'controller', err }, 'LLM stream error');
      },
      onStep: (event, meta) => {
        // A late step-finish that lands after this turn's interrupt record
        // was persisted would append a complete step BEHIND the interrupt
        // marker — the turn is over, drop it. Steps landing between the abort
        // and that record are complete (their tools ran to finish) and are
        // persisted below; recordUserAbort's uuid dedup guard reconciles them
        // with any in-flight partial text.
        if (this.turnInterruptRecorded) return;
        const streamingEntries = this.state.get<ConversationEntry[]>('dynamicState.streamingEntries');
        const streamingUuid = streamingEntries?.[0]?.uuid;
        const entry = buildAssistantEntry(event, this.ctx.sessionId, streamingUuid, {
          startedAt: meta?.startedAt,
          firstTokenAt: meta?.firstTokenAt,
          temperature: this.provider.temperature,
          maxOutputTokens: this.provider.maxOutputTokens,
          recordedToolCalls: (toolCallId) => this.recorder.lookup(toolCallId),
        });
        applyTurnEnvelope(entry, turnEnv);
        syncStepTimestamps(entry);
        this.state.append('conversation', entry);
        // Clear streaming for this step; next chunk will start a fresh entry
        this.state.set('dynamicState.streamingEntries', []);
        // Refresh the status bar's context usage from this step's real usage
        this.updateContextUsage({ inputTokens: event.usage?.inputTokens });
      },
    });

    let fullText = '';
    for await (const chunk of gen) {
      if (chunk) {
        // When streamingEntries was cleared by onStep, start a fresh streaming entry
        const current = this.state.get<ConversationEntry[]>('dynamicState.streamingEntries');
        if (!current || current.length === 0) {
          streamingEntry = this.createStreamingEntry();
        }
        streamingEntry.message.content += chunk;
        fullText += chunk;
        this.state.set('dynamicState.streamingEntries', [streamingEntry]);
      }
    }

    // streamLoop returns cleanly on abort (base-agent catch checks the agent
    // signal), so an aborted turn lands here: record the interrupt before the
    // run unwinds.
    if (this.abortController.signal.aborted) {
      this.recordUserAbort(turnEnv);
    }

    // Don't clear streamingEntries here — let the next run clear them
    // to avoid a blank frame between streaming disappearing and conversation appearing
    return { text: fullText };
  }

  /**
   * Persist a user interrupt (ESC while busy) of the current turn:
   *  - the in-flight partial text, if any, becomes a truncated assistant
   *    entry (`interrupted: true`). Empty/whitespace partials are dropped —
   *    an empty assistant message risks provider rejection on replay and
   *    carries no information;
   *  - an `interrupted` system marker is always appended (the zero-output
   *    case leaves only this marker), replayed to the next turn as an
   *    explicit [USER INTERRUPT] system message;
   *  - streaming entries are cleared so the live region stops rendering.
   *
   * Dedup guard: a partial whose uuid is already in the conversation was
   * recorded by onStep (abort landed just after step finish) — never append
   * it twice.
   */
  private recordUserAbort(turnEnv: TurnEnvelope): void {
    // From here the turn is closed: any step finish racing in after this
    // point would land behind the interrupt marker and is dropped by the
    // onStep guard. Set BEFORE the appends so nothing interleaves.
    this.turnInterruptRecorded = true;
    const ts = nowISO();
    const streaming = this.state.get<ConversationEntry[]>('dynamicState.streamingEntries') ?? [];
    const inFlight = streaming[0];
    const partialText = inFlight?.type === EEntryType.Assistant ? inFlight.message.content : '';
    const recordedUuids = new Set(
      (this.state.get<ConversationEntry[]>('conversation') ?? []).map(e => e.uuid),
    );

    if (inFlight && inFlight.type === EEntryType.Assistant && partialText.trim() && !recordedUuids.has(inFlight.uuid)) {
      const truncated: ConversationEntry = {
        ...inFlight,
        interrupted: true,
        timing: { startedAt: inFlight.timestamp, endedAt: ts },
        startedAt: inFlight.timestamp,
        endedAt: ts,
      };
      applyTurnEnvelope(truncated, turnEnv);
      this.state.append('conversation', truncated);
    }

    const marker: ConversationEntry = {
      type: EEntryType.System,
      uuid: generateId('sys-abort'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: ts,
      subtype: ESystemSubtype.Interrupted,
      content: 'Response interrupted by user.',
      startedAt: ts,
      endedAt: ts,
      actor: { kind: 'user', id: 'user' },
    };
    applyTurnEnvelope(marker, turnEnv);
    this.state.append('conversation', marker);

    this.state.set('dynamicState.streamingEntries', []);
  }

  /** Create a fresh streaming entry placeholder. */
  private createStreamingEntry() {
    return {
      type: EEntryType.Assistant as const,
      uuid: generateId('s'),
      parentUuid: null,
      sessionId: this.ctx.sessionId,
      timestamp: nowISO(),
      message: { role: 'assistant' as const, content: '' },
    };
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
