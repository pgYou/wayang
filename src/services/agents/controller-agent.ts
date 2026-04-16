import { BaseAgent } from './base-agent';
import { ContextManager, COMPACT_MAX_RETRIES } from './context-manager';
import { ControllerAgentState } from '@/services/agents/controller-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { ControllerSignal, ProviderConfig, TaskDetail, WayangConfig, InputSignalPayload, CompletedSignalPayload, FailedSignalPayload, ProgressSignalPayload, HeartbeatSignalPayload } from '@/types/index';
import type { ConversationEntry, SignalEntry } from '@/types/conversation';
import { EEntryType, ESignalSubtype } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { generateText } from 'ai';
import type { ToolSet } from 'ai';
import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerPrompt,
  buildControllerSystemPrompt,
} from './prompts/index';
import { createControllerTools } from '@/services/tools/index';
import { SystemContext } from '@/infra/system-context';
import type { TaskExecuteEngine } from '@/services/task-execute-engine';
import type { SignalQueue } from '@/services/signal/signal-queue';

export class ControllerAgent extends BaseAgent {
  readonly state: ControllerAgentState;
  private readonly contextManager: ContextManager;
  private readonly tools: ToolSet;
  private readonly logger: Logger;
  private readonly ctx: SystemContext;

  constructor(
    ctx: SystemContext,
    state: ControllerAgentState,
    provider: ProviderConfig,
    tools: ToolSet,
  ) {
    super(provider);
    this.ctx = ctx;
    this.state = state;
    this.tools = tools;
    this.logger = ctx.logger;

    this.contextManager = new ContextManager(
      state,
      buildControllerSystemPrompt(this.ctx),
    );
    this.setHooks({
      beforeLLM: ({ messages }) => {
        this.logger.debug({ messages }, 'LLM call start');
      },
      afterLLM: ({ step, usage, durationMs }) => {
        this.logger.info({ agent: 'controller', step, usage, durationMs }, 'LLM call done');
      },
    });

  }

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
  }): ControllerAgent {
    const { ctx, provider, config, engine, signalQueue } = opts;
    const state = new ControllerAgentState(ctx);

    const tools = createControllerTools({
      addTask: (task: TaskDetail) => engine.add(task),
      validateWorkerType: (type: string) => engine.validateWorkerType(type),
      listTasks: (status?: TaskDetail['status']) => engine.list(status),
      getTask: (taskId: string) => engine.get(taskId),
      getWorkerConversation: (taskId: string) => engine.getWorkerConversation(taskId),
      cancelTask: (taskId: string) => engine.cancel(taskId),
      abortWorker: (taskId: string) => engine.abortByTaskId(taskId),
      updateTask: (taskId, updates) => engine.updatePending(taskId, updates),
      queryMessages: (filter) => signalQueue.query(filter),
      cwd: ctx.workspaceDir,
      getNotebook: () => state.get<string>('runtimeState.notebook') ?? '',
      setNotebook: (content, mode) => {
        const current = state.get<string>('runtimeState.notebook') ?? '';
        state.set('runtimeState.notebook', mode === 'append' ? (current ? current + '\n' + content : content) : content);
      },
      inquire: (question) => state.askInquiry(question),
    });

    return new ControllerAgent(ctx, state, provider, tools);
  }

  /** Run the controller agent — streams text chunks while updating streamingEntries in state. */
  async run(signals: ControllerSignal[]): Promise<{ text: string }> {
    this.state.set('dynamicState.busy', true);
    try {
      return await this._run(signals);
    } finally {
      this.state.set('dynamicState.busy', false);
    }
  }

  private async _run(signals: ControllerSignal[]): Promise<{ text: string }> {
    const ts = nowISO();

    // Append incoming signals to conversation
    for (const sig of signals) {
      this.state.append('conversation', signalToEntry(sig, ts));
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
      onStep: (event) => {
        const streamingEntries = this.state.get<ConversationEntry[]>('dynamicState.streamingEntries');
        const streamingUuid = streamingEntries?.[0]?.uuid;
        const entry = buildAssistantEntry(event, this.id, streamingUuid);
        this.state.append('conversation', entry);
        // Clear streaming for this step; next chunk will start a fresh entry
        this.state.set('dynamicState.streamingEntries', []);
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

    // Don't clear streamingEntries here — let the next run clear them
    // to avoid a blank frame between streaming disappearing and conversation appearing
    return { text: fullText };
  }

  /** Create a fresh streaming entry placeholder. */
  private createStreamingEntry() {
    return {
      type: EEntryType.Assistant as const,
      uuid: generateId('s'),
      parentUuid: null,
      sessionId: 'controller',
      timestamp: nowISO(),
      message: { role: 'assistant' as const, content: '' },
    };
  }

  /** Check if context needs compaction. */
  needsCompaction(): boolean {
    return this.contextManager.isFull();
  }

  /**
   * Run compaction — uses the LLM to summarize conversation entries.
   *
   * Retries up to COMPACT_MAX_RETRIES times on failure.
   * Falls back to truncating half of the history in memory (file preserved).
   */
  async performCompaction(): Promise<void> {
    try {
      await this.contextManager.compact(async (entries) => {
        const entryTexts = entries.map((e, i) => {
          const content = e.message?.content ?? e.content ?? '';
          return `[${i}] (${e.type}) ${String(content).slice(0, 300)}`;
        });

        let lastError: unknown;
        for (let attempt = 0; attempt <= COMPACT_MAX_RETRIES; attempt++) {
          try {
            const { text } = await generateText({
              model: this.model as any, // WayangModel opaque boundary
              system: SUMMARIZER_SYSTEM_PROMPT,
              prompt: buildSummarizerPrompt(entryTexts),
            });
            return text;
          } catch (err) {
            lastError = err;
            this.logger.warn({ attempt: attempt + 1, error: String(err) }, 'Compaction summarizer failed');
          }
        }
        throw lastError;
      });
    } catch (err) {
      // All retries failed — fallback: truncate half of history in memory only
      this.logger.warn({ error: String(err) }, 'Compaction failed, falling back to half-truncation');
      const conversation = this.state.get<ConversationEntry[]>('conversation');
      if (conversation.length > 4) {
        const half = Math.floor(conversation.length / 2);
        this.state.set('conversation', conversation.slice(-half));
        this.logger.info({ kept: half, total: conversation.length }, 'History truncated (half) as compaction fallback');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signal → ConversationEntry converters
// ---------------------------------------------------------------------------

/** Common fields for all SignalEntry variants. */
function signalBase(ts: string): Omit<SignalEntry, 'subtype' | 'content' | 'taskTitle'> {
  return {
    type: EEntryType.Signal,
    uuid: generateId('sig'),
    parentUuid: null,
    sessionId: 'controller',
    timestamp: ts,
  };
}

type SignalConverter = (sig: ControllerSignal, ts: string) => ConversationEntry;

const signalConverters: Record<string, SignalConverter> = {
  input: (sig, ts) => ({
    type: EEntryType.User,
    uuid: generateId('u'),
    parentUuid: null,
    sessionId: 'controller',
    timestamp: ts,
    message: { role: 'user' as const, content: (sig.payload as InputSignalPayload).text },
  }),

  completed: (sig, ts) => {
    const p = sig.payload as CompletedSignalPayload;
    return {
      ...signalBase(ts),
      subtype: ESignalSubtype.WorkerCompleted,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.summary ?? JSON.stringify(sig.payload),
    };
  },

  failed: (sig, ts) => {
    const p = sig.payload as FailedSignalPayload;
    return {
      ...signalBase(ts),
      subtype: ESignalSubtype.WorkerFailed,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.error,
    };
  },

  progress: (sig, ts) => {
    const p = sig.payload as ProgressSignalPayload;
    return {
      ...signalBase(ts),
      subtype: ESignalSubtype.WorkerProgress,
      workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
      taskId: p.taskId, taskTitle: p.taskTitle,
      content: p.message,
    };
  },

  heartbeat: (sig, ts) => {
    const p = sig.payload as HeartbeatSignalPayload;
    const workerSummary = p.workers
      .map((w) => `${w.taskTitle} (${w.workerType}, running ${Math.round(w.runningForMs / 1000)}s)`)
      .join(', ');
    return {
      ...signalBase(ts),
      subtype: ESignalSubtype.Heartbeat,
      taskTitle: 'heartbeat',
      content: `[HEARTBEAT] ${p.reason}\nIdle: ${Math.round(p.idleSinceMs / 1000)}s\nWorkers: ${workerSummary}\nPending tasks: ${p.pendingTaskCount}`,
    };
  },
};

/** Convert a ControllerSignal to a ConversationEntry. */
function signalToEntry(sig: ControllerSignal, ts: string): ConversationEntry {
  const converter = signalConverters[sig.type];
  if (converter) return converter(sig, ts);

  // Fallback for unknown/cancelled signals
  const p = sig.payload as FailedSignalPayload;
  return {
    ...signalBase(ts),
    subtype: ESignalSubtype.WorkerFailed,
    workerId: p.workerId, workerType: p.workerType, emoji: p.emoji,
    taskId: p.taskId, taskTitle: p.taskTitle ?? sig.type,
    content: JSON.stringify(sig.payload),
  } as SignalEntry;
}
