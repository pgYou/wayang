import { streamText, stepCountIs, hasToolCall, type OnStepFinishEvent, type ModelMessage, type ToolSet } from 'ai';
import { createModel } from './model-factory';
import type { ProviderConfig, ToolChoice } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';

// --- Stream Loop Types ---

export interface StreamLoopResult {
  text?: string;
  reasoningText?: string;
  toolResults?: Array<{ toolCallId?: string; result: unknown; isError?: boolean }>;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  steps?: number;
}

/**
 * Extra per-step metadata handed to onStep alongside the SDK event.
 * - `startedAt` is approximate: stream creation time for the first step, the
 *   previous step's finish time for later steps.
 * - `firstTokenAt` is approximate: the time the first stream chunk after the
 *   previous step boundary arrived (tool output is not part of textStream).
 * Both are fallbacks — buildAssistantEntry prefers the SDK event's
 * response.timestamp when the provider supplies one.
 */
export interface StepMeta {
  startedAt?: string;
  firstTokenAt?: string;
}

// --- Configuration Constants ---

/**
 * Default idle watchdog: abort the call when no progress (no text chunk and
 * no step finish) for this long. Guards against proxies that accept a
 * request and then hang it silently (observed with large prompts — the
 * connection neither errors nor delivers data).
 */
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 300_000;

export interface StreamLoopOptions {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  /** Tool-choice mode forwarded to the provider. Omit for SDK default (auto). */
  toolChoice?: ToolChoice;
  maxSteps?: number;
  /** Tool names that signal the loop should stop after execution (e.g. 'done', 'fail'). */
  stopTools?: string[];
  /** LLM idle watchdog (ms): abort when no progress — no text chunk and no
   *  step finish — for this long. Paused while a tool is executing (incl.
   *  waiting for approval / user input). 0 disables. Default 5 minutes.
   *  Unrelated to the `idleTimeoutMs` config field (multi-stage worker reaping). */
  llmIdleTimeoutMs?: number;
  onStep?: (event: OnStepFinishEvent, meta: StepMeta) => void;
  /** Called when the LLM stream errors (e.g. HTTP 400/403 from the provider).
   *  Without this, textStream silently drops error parts. */
  onStreamError?: (error: unknown) => void;
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
    const idleTimeoutMs = opts.llmIdleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS;

    // Per-call abort controller: the watchdog aborts only THIS call, leaving
    // the agent's own controller intact so long-lived agents stay reusable.
    const callAbort = new AbortController();
    const forwardAbort = () => callAbort.abort();
    if (this.abortController.signal.aborted) {
      callAbort.abort();
    } else {
      this.abortController.signal.addEventListener('abort', forwardAbort);
    }

    // Idle watchdog — re-armed on every observable progress event (text
    // chunk or step finish). When it fires, the call is aborted and surfaced
    // as a timeout error instead of hanging forever.
    //
    // Paused while any tool is executing: tool execution (including waiting
    // for a permission approval or a user's inquire answer) happens between
    // steps and produces no stream progress, yet the provider is not hung.
    // Tools bound their own duration (bash timeout, permission timeout).
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let toolsInFlight = 0;
    /** Set once the call is over — late tool completions must not re-arm. */
    let finished = false;
    const clearWatchdog = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const armWatchdog = () => {
      if (idleTimeoutMs <= 0 || finished || toolsInFlight > 0) return;
      clearWatchdog();
      watchdog = setTimeout(() => {
        timedOut = true;
        callAbort.abort();
      }, idleTimeoutMs);
    };
    const tools = pauseWatchdogDuringTools(
      opts.tools,
      () => {
        toolsInFlight++;
        clearWatchdog();
      },
      () => {
        toolsInFlight--;
        if (toolsInFlight === 0) armWatchdog(); // tool finished — waiting on the LLM again
      },
    );

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
    /** Time the first text chunk of the CURRENT step arrived (approximate). */
    let firstChunkAt: string | undefined;
    /** Time the CURRENT step started (approximate: stream start / previous step end). */
    let stepStartedAt: string | undefined;
    // Wrap onStep so the timing of the step that just finished is handed over
    // and the trackers reset for the next step.
    const onStep = opts.onStep
      ? (event: OnStepFinishEvent) => {
          armWatchdog(); // Step finish is progress — re-arm the watchdog.
          const meta: StepMeta = { startedAt: stepStartedAt, firstTokenAt: firstChunkAt };
          firstChunkAt = undefined;
          stepStartedAt = nowISO();
          opts.onStep!(event, meta);
        }
      : undefined;
    try {
      this.hooks.beforeLLM?.({ messageCount: opts.messages.length, messages: opts.messages });
      startTime = Date.now();
      stepStartedAt = nowISO();
      armWatchdog();
      stream = streamText({
        model: this.model,
        system: opts.system,
        messages: opts.messages,
        tools,
        toolChoice: opts.toolChoice,
        stopWhen: stopConditions.length > 0 ? stopConditions : undefined,
        abortSignal: callAbort.signal,
        onStepFinish: onStep,
        onError: ({ error }) => {
          opts.onStreamError?.(error);
        },
        // SignalEntry entries are trusted system-generated notifications emitted
        // as `system`-role messages (in-band, order-sensitive). AI SDK v6 warns
        // on any system message inside `messages` unless this is opted in.
        allowSystemInMessages: true,
      });
    } catch (err: any) {
      finished = true;
      clearWatchdog();
      this.abortController.signal.removeEventListener('abort', forwardAbort);
      if (this.abortController.signal.aborted) {
        return { text: '', toolResults: [], usage: undefined };
      }
      throw err;
    }

    try {
      for await (const chunk of stream.textStream) {
        armWatchdog(); // A chunk is progress — re-arm the watchdog.
        if (chunk && firstChunkAt === undefined) firstChunkAt = nowISO();
        yield chunk;
      }
    } catch (err: any) {
      // Intentional abort (done/fail tool or external cancel) wins over a
      // watchdog that fired at the same moment — report a clean stop.
      if (this.abortController.signal.aborted) {
        return { text: '', toolResults: [], usage: undefined };
      }
      // Watchdog fired — surface a timeout error, never a silent hang.
      if (timedOut) {
        throw new Error(
          `LLM call idle timeout: no stream progress (text chunk or step finish) for ${idleTimeoutMs}ms`,
        );
      }
      // Abort is intentional (done/fail tool or external cancel) — return clean result
      if (this.abortController.signal.aborted) {
        return { text: '', toolResults: [], usage: undefined };
      }
      throw err;
    } finally {
      finished = true;
      clearWatchdog();
      this.abortController.signal.removeEventListener('abort', forwardAbort);
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

/**
 * Wrap a tool set so the idle watchdog is paused while any tool executes.
 * Behavior-preserving: the original execute runs with the same arguments and
 * its result/throw passes through; tools without execute are kept as-is.
 */
function pauseWatchdogDuringTools(tools: ToolSet, onStart: () => void, onEnd: () => void): ToolSet {
  const wrapped: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools ?? {})) {
    const original = (def as { execute?: unknown } | undefined)?.execute;
    if (typeof original !== 'function') {
      wrapped[name] = def;
      continue;
    }
    wrapped[name] = {
      ...def,
      execute: async (...args: unknown[]) => {
        onStart();
        try {
          return await (original as (...a: unknown[]) => unknown)(...args);
        } finally {
          onEnd();
        }
      },
    };
  }
  return wrapped as ToolSet;
}
