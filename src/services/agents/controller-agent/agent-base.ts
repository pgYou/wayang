// ControllerAgentBase: the ControllerAgent fields (original declaration
// order), constructor (incl. the beforeLLM/afterLLM logging hooks), restore,
// context-usage tracking and compaction. The turn execution and the public
// facade live in the layers above (turn-run.ts / controller-agent.ts).

import { BaseAgent } from '../base-agent';
import { ContextManager, COMPACT_MAX_RETRIES } from '../context-manager';
import type { ControllerAgentState } from '../controller-state';
import type { ToolSet } from 'ai';
import type { Logger } from '@/infra/logger';
import type { ProviderConfig, ContextUsage, ContextLastUsage } from '@/types/index';
import type { ConversationEntry } from '@/types/conversation';
import { EEntryType, ESystemSubtype } from '@/types/index';
import { generateText } from 'ai';
import { buildSummaryInput } from '../utils/summarizer-input';
import { buildLlmCallStartPayload, debugLoggingEnabled } from '../utils/llm-call-logging';
import { recordToolCalls, ToolCallRecorder } from '../utils/tool-call-recorder';

import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerPrompt,
  buildControllerSystemPrompt,
} from '../prompts/index';
import { wayangDirForSessionDir } from '@/infra/session-helpers';
import { resolveWorkspaceRef } from '@/infra/workspace-registry';
import { SystemContext } from '@/infra/system-context';

/**
 * Share of the context window (in characters) the summarizer input may use —
 * leaves room for the summarizer prompt and its output.
 */
const SUMMARIZER_INPUT_RATIO = 0.5;

export class ControllerAgentBase extends BaseAgent {
  protected readonly state: ControllerAgentState;
  protected readonly contextManager: ContextManager;
  protected readonly tools: ToolSet;
  protected readonly logger: Logger;
  protected readonly ctx: SystemContext;
  protected readonly provider: ProviderConfig;
  /** Live tool execution records — merged into entries at step finish. */
  protected readonly recorder: ToolCallRecorder;
  /** Turn id of the most recent run — used to stamp late error entries. */
  protected lastTurnId: string | null = null;
  /**
   * Registry slug of the workspace this controller executes in (the process
   * workspace). Stamped on every controller turn envelope so its entries are
   * attributable to a directory, matching worker entries. Resolved once at
   * construction; undefined only when the context carries no workspace dir.
   */
  protected readonly workspaceSlug?: string;
  /**
   * True once THIS turn's interrupt record has been persisted
   * (recordUserAbort). Step finishes landing after that point would append
   * behind the interrupt marker — the turn is closed, drop them. Checked by
   * the onStep guard INSTEAD of the abort signal: the signal flips the moment
   * the user presses ESC, but a step that was already executing completes
   * normally afterwards (ai SDK enqueues finish-step only after the step's
   * tools ran to completion), so it still carries complete toolCalls +
   * toolResults and must be persisted (design §3.5) — dropping it would lose
   * the add_task toolCall/taskId link and make the interrupted turn look
   * cancelled while its workers are still running.
   */
  protected turnInterruptRecorded = false;

  constructor(
    ctx: SystemContext,
    state: ControllerAgentState,
    provider: ProviderConfig,
    tools: ToolSet,
    skills: import('@/services/skills/registry').SkillRegistry,
    recorder: ToolCallRecorder = new ToolCallRecorder(),
    /**
     * Startup rules section (home + cwd AGENTS.md), already rendered by
     * `loadControllerRules()` in `create()`. Passed in rather than read here
     * so the files are touched exactly once per process and the prompt never
     * changes mid-session.
     */
    controllerRules?: string,
  ) {
    super(provider);
    this.ctx = ctx;
    this.state = state;
    this.provider = provider;
    this.recorder = recorder;
    this.tools = recordToolCalls(tools, recorder);
    this.logger = ctx.logger;
    // The controller runs in the process workspace; resolve its registry slug
    // once (read-only once the session's startup workspace is registered) so
    // each turn envelope can carry it.
    this.workspaceSlug = ctx.workspaceDir
      ? resolveWorkspaceRef(wayangDirForSessionDir(ctx.sessionDir), ctx.workspaceDir).slug
      : undefined;

    this.contextManager = new ContextManager(
      state,
      buildControllerSystemPrompt(this.ctx, skills, { rules: controllerRules }),
      provider.contextWindowTokens,
    );
    this.setHooks({
      beforeLLM: ({ messageCount, messages }) => {
        // Zero-cost when DEBUG is off (issue #52): the level check precedes
        // any payload work, so a disabled level never walks the messages.
        // Default payload is metadata only (model / message count / token
        // estimate); WAYANG_LOG_PROMPTS=1 adds the full sanitized messages.
        if (!debugLoggingEnabled(this.logger)) return;
        this.logger.debug(
          buildLlmCallStartPayload(messages, messageCount, this.provider.modelName),
          'LLM call start',
        );
      },
      afterLLM: ({ step, usage, durationMs }) => {
        this.logger.info({ agent: 'controller', step, usage, durationMs }, 'LLM call done');
      },
    });

  }

  /** Restore persisted state (conversation, runtime). Called by Supervisor. */
  async restore(): Promise<void> {
    await this.state.restore();
    // Backfill the restored summary into the context manager so getMessages()
    // prepends it and the verbatim zone covers the sliced window.
    const summary = this.state.get<string>('compactSummary');
    if (summary) {
      this.contextManager.restoreCompact(summary);
    }
    // Seed the compaction check with the last real prompt size, so the cold
    // start check (supervisor) sees real usage instead of only the estimate.
    // Skipped when a compaction happened after that step — its usage
    // describes the pre-compaction prompt and would re-trigger compaction.
    const seeded = this.lastUsageSinceCompaction();
    if (seeded) this.contextManager.reportRealUsage(seeded.inputTokens);
    // Seed the status bar's context usage from the restored history.
    this.updateContextUsage(seeded ? { inputTokens: seeded.inputTokens } : undefined);
  }

  /**
   * Provider usage of the newest assistant step that comes after the last
   * compaction marker, if any.
   */
  private lastUsageSinceCompaction(): ContextLastUsage | undefined {
    const conversation = this.state.get<ConversationEntry[]>('conversation') ?? [];
    for (let i = conversation.length - 1; i >= 0; i--) {
      const entry = conversation[i]!;
      if (entry.type === EEntryType.System && entry.subtype === ESystemSubtype.Compact && entry.compactMeta) {
        return undefined;
      }
      if (entry.type !== EEntryType.Assistant) continue;
      const usage = this.toLastUsage(entry.message.usage);
      if (usage) return usage;
    }
    return undefined;
  }

  /**
   * Refresh dynamicState.contextUsage for the status bar.
   *
   * Prefers the real prompt size reported by the provider (inputTokens of the
   * step that just finished); falls back to the local estimate when usage is
   * unavailable. Ratio stays raw (not clamped to 1) so over-budget states
   * remain visible. dynamicState is never persisted.
   */
  protected updateContextUsage(stepUsage?: { inputTokens?: number }): void {
    const contextWindowTokens = this.contextManager.getContextWindowTokens();
    const reported = stepUsage?.inputTokens;
    const hasReported = typeof reported === 'number' && Number.isFinite(reported) && reported > 0;
    if (hasReported) {
      // Feed the real prompt size to the context manager so compaction
      // triggers on real usage, not the (under)estimator.
      this.contextManager.reportRealUsage(reported);
    }
    const usedTokens = hasReported ? reported : this.contextManager.getEstimatedTokens();
    // Last provider usage: prefer the newest assistant entry in the conversation
    // (which already covers the step that just finished AND restore), falling
    // back to the step usage handed in when the entry has no usage yet.
    const lastUsage = this.findLastStepUsage() ?? this.toLastUsage(stepUsage);
    const usage: ContextUsage = {
      usedTokens,
      contextWindowTokens,
      ratio: contextWindowTokens > 0 ? usedTokens / contextWindowTokens : 0,
      source: hasReported ? 'usage' : 'estimate',
      breakdown: this.contextManager.getContextBreakdown(),
      ...(lastUsage && { lastUsage }),
    };
    this.state.set('dynamicState.contextUsage', usage);
  }

  /** Newest provider-reported usage in the conversation, if any. */
  private findLastStepUsage(): ContextLastUsage | undefined {
    const conversation = this.state.get<ConversationEntry[]>('conversation') ?? [];
    for (let i = conversation.length - 1; i >= 0; i--) {
      const entry = conversation[i]!;
      if (entry.type !== EEntryType.Assistant) continue;
      const usage = this.toLastUsage(entry.message.usage);
      if (usage) return usage;
    }
    return undefined;
  }

  /** Normalize a step usage payload, or undefined when the provider gave none. */
  private toLastUsage(usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  }): ContextLastUsage | undefined {
    if (!usage) return undefined;
    const { inputTokens, outputTokens, cachedInputTokens } = usage;
    if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) {
      return undefined;
    }
    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cachedInputTokens: cachedInputTokens ?? 0,
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
      // Capture the previous summary before compact() replaces it — the
      // summarizer folds it in so repeated compactions stay incremental.
      const previousSummary = this.contextManager.getCompactSummary();
      const entryCount = this.state.get<ConversationEntry[]>('conversation').length;

      await this.contextManager.compact(
        async (entries) => {
          // Budget the summarizer input in characters against the model
          // window: CJK text runs close to one token per character, so a
          // character budget never underestimates the request size.
          const budget = Math.floor(this.contextManager.getContextWindowTokens() * SUMMARIZER_INPUT_RATIO)
            - (previousSummary?.length ?? 0);
          const entryTexts = buildSummaryInput(entries, Math.max(budget, 0));
          if (previousSummary) {
            entryTexts.unshift(`[Previous Summary]\n${previousSummary}`);
          }

          let lastError: unknown;
          for (let attempt = 0; attempt <= COMPACT_MAX_RETRIES; attempt++) {
            try {
              const { text } = await generateText({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WayangModel (custom provider wrapper) deliberately crossing into the SDK's LanguageModel type here; opaque boundary
                model: this.model as any,
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
        },
        { model: this.provider.modelName },
      );
      this.logger.info(
        { model: this.provider.modelName, summarizedEntries: entryCount },
        'Compaction done',
      );
    } catch (err) {
      // All retries failed — fallback: truncate half of history in memory only.
      // Truncation goes through the context manager so its verbatim-zone index
      // and real-usage mark stay consistent with the shortened array.
      this.logger.warn({ error: String(err) }, 'Compaction failed, falling back to half-truncation');
      const total = this.state.get<ConversationEntry[]>('conversation').length;
      if (total > 4) {
        const half = Math.floor(total / 2);
        this.contextManager.truncateHistory(half);
        this.logger.info({ kept: half, total }, 'History truncated (half) as compaction fallback');
      }
    }
    // Refresh the status bar / `/context` right away instead of waiting for
    // the next LLM step to report usage.
    this.updateContextUsage();
  }
}
