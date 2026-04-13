import { BaseAgent } from './base-agent';
import { ContextManager, COMPACT_MAX_RETRIES } from './context-manager';
import { ControllerAgentState } from '@/services/agents/controller-state';
import { buildAssistantEntry } from './utils/build-assistant-entry';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { ControllerSignal, ProviderConfig } from '@/types/index';
import { EEntryType, ESignalSubtype } from '@/types/index';
import type { Logger } from '@/infra/logger';
import { generateText } from 'ai';
import type { ToolSet } from 'ai';
import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerPrompt,
  buildControllerSystemPrompt,
} from './prompts/index';
import { SystemContext } from '@/infra/system-context';

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
      if (sig.type === 'input') {
        const text = sig.payload.text;
        this.state.append('conversation', {
          type: EEntryType.User,
          uuid: generateId('u'),
          parentUuid: null,
          sessionId: 'controller',
          timestamp: ts,
          message: { role: 'user', content: text },
        });
      } else if (sig.type === 'completed') {
        this.state.append('conversation', {
          type: EEntryType.Signal,
          uuid: generateId('sig'),
          parentUuid: null,
          sessionId: 'controller',
          timestamp: ts,
          subtype: ESignalSubtype.WorkerCompleted,
          workerId: sig.payload.workerId,
          workerType: sig.payload.workerType,
          emoji: sig.payload.emoji,
          taskId: sig.payload.taskId,
          taskTitle: sig.payload.taskTitle,
          content: sig.payload.summary ?? JSON.stringify(sig.payload),
        });
      } else if (sig.type === 'failed') {
        this.state.append('conversation', {
          type: EEntryType.Signal,
          uuid: generateId('sig'),
          parentUuid: null,
          sessionId: 'controller',
          timestamp: ts,
          subtype: ESignalSubtype.WorkerFailed,
          workerId: sig.payload.workerId,
          workerType: sig.payload.workerType,
          emoji: sig.payload.emoji,
          taskId: sig.payload.taskId,
          taskTitle: sig.payload.taskTitle,
          content: sig.payload.error,
        });
      } else if (sig.type === 'progress') {
        this.state.append('conversation', {
          type: EEntryType.Signal,
          uuid: generateId('sig'),
          parentUuid: null,
          sessionId: 'controller',
          timestamp: ts,
          subtype: ESignalSubtype.WorkerProgress,
          workerId: sig.payload.workerId,
          workerType: sig.payload.workerType,
          emoji: sig.payload.emoji,
          taskId: sig.payload.taskId,
          taskTitle: sig.payload.taskTitle,
          content: sig.payload.message,
        });
      } else {
        // cancelled or unknown — generic entry
        this.state.append('conversation', {
          type: EEntryType.Signal,
          uuid: generateId('sig'),
          parentUuid: null,
          sessionId: 'controller',
          timestamp: ts,
          subtype: ESignalSubtype.WorkerFailed,
          workerId: sig.payload.workerId,
          workerType: sig.payload.workerType,
          emoji: sig.payload.emoji,
          taskId: sig.payload.taskId,
          content: JSON.stringify(sig.payload),
        });
      }
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
        const streamingEntries = this.state.get<any[]>('dynamicState.streamingEntries');
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
        const current = this.state.get<any[]>('dynamicState.streamingEntries');
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
      const conversation = this.state.get<any[]>('conversation');
      if (conversation.length > 4) {
        const half = Math.floor(conversation.length / 2);
        this.state.set('conversation', conversation.slice(-half));
        this.logger.info({ kept: half, total: conversation.length }, 'History truncated (half) as compaction fallback');
      }
    }
  }
}
