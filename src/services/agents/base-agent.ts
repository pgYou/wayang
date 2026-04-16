import { streamText, stepCountIs, hasToolCall, type OnStepFinishEvent, type ModelMessage, type ToolSet } from 'ai';
import { createModel } from './model-factory';
import type { ProviderConfig } from '@/types/index';
import { generateId } from '@/utils/id';

// --- Stream Loop Types ---

export interface StreamLoopResult {
  text?: string;
  reasoningText?: string;
  toolResults?: Array<{ toolCallId?: string; result: unknown; isError?: boolean }>;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  steps?: number;
}

export interface StreamLoopOptions {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  toolChoice?: 'required' | 'auto';
  maxSteps?: number;
  /** Tool names that signal the loop should stop after execution (e.g. 'done', 'fail'). */
  stopTools?: string[];
  onStep?: (event: OnStepFinishEvent) => void;
}

export interface AgentHooks {
  /** Called before each LLM call (step). */
  beforeLLM?: (info: { messageCount: number; messages: ModelMessage[] }) => void;
  /** Called after each LLM step completes. */
  afterLLM?: (info: { step: number; usage?: { inputTokens: number; outputTokens: number }; durationMs: number }) => void;
}

// --- BaseAgent ---

export abstract class BaseAgent {
  readonly id: string;
  readonly abortController: AbortController;
  protected readonly model: ReturnType<typeof createModel>;

  protected hooks: AgentHooks = {};

  constructor(provider: ProviderConfig) {
    this.id = generateId('agent');
    this.abortController = new AbortController();
    this.model = createModel(provider);
  }

  /** Set lifecycle hooks. */
  setHooks(hooks: AgentHooks): void {
    this.hooks = hooks;
  }

  /** Core streaming primitive — yields text chunks, returns final result.
   *  Catches abort signal internally so callers see a clean completion. */
  protected async *streamLoop(opts: StreamLoopOptions): AsyncGenerator<string, StreamLoopResult> {
    const step = 0;

    let stream: Awaited<ReturnType<typeof streamText>>;

    // Build stop conditions: maxSteps + terminal tools (done/fail)
    const stopConditions: Array<ReturnType<typeof stepCountIs>> = [];
    if (opts.maxSteps) stopConditions.push(stepCountIs(opts.maxSteps));
    if (opts.stopTools?.length) {
      for (const name of opts.stopTools) {
        stopConditions.push(hasToolCall(name));
      }
    }

    let startTime: number;
    try {
      this.hooks.beforeLLM?.({ messageCount: opts.messages.length, messages: opts.messages });
      startTime = Date.now();
      stream = streamText({
        model: this.model,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        toolChoice: opts.toolChoice,
        stopWhen: stopConditions.length > 0 ? stopConditions : undefined,
        abortSignal: this.abortController.signal,
        onStepFinish: opts.onStep,
      });
    } catch (err: any) {
      if (this.abortController.signal.aborted) {
        return { text: '', toolResults: [], usage: undefined };
      }
      throw err;
    }

    try {
      for await (const chunk of stream.textStream) {
        yield chunk;
      }
    } catch (err: any) {
      // Abort is intentional (done/fail tool or external cancel) — return clean result
      if (this.abortController.signal.aborted) {
        return { text: '', toolResults: [], usage: undefined };
      }
      throw err;
    }
    const duration = Date.now() - startTime;
    const text = await stream.text;
    const reasoningText = await stream.reasoningText;
    const toolResults = await stream.toolResults;
    const rawUsage = await stream.usage;
    const finishReason = await stream.finishReason;
    const steps = await stream.steps;

    const usage = rawUsage ? { inputTokens: rawUsage.inputTokens ?? 0, outputTokens: rawUsage.outputTokens ?? 0 } : undefined;
    this.hooks.afterLLM?.({ step, usage, durationMs: duration });

    return {
      text,
      reasoningText,
      toolResults: toolResults?.map((tr: Record<string, unknown>) => ({
        toolCallId: tr.toolCallId as string,
        result: tr.result,
        isError: tr.isError as boolean | undefined,
      })),
      usage,
      finishReason,
      steps: steps?.length,
    };
  }

  /** Batch wrapper — iterates streamLoop and returns the final result. */
  protected async collectLoop(opts: StreamLoopOptions): Promise<StreamLoopResult> {
    const gen = this.streamLoop(opts);
    let result: StreamLoopResult;
    while (true) {
      const { done, value } = await gen.next();
      if (done) {
        result = value as StreamLoopResult;
        break;
      }
    }
    return result;
  }

  abort(): void {
    this.abortController.abort();
  }
}
