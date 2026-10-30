import type { OnStepFinishEvent } from 'ai';
import type { AssistantEntry, ToolCallRecord, ToolResultRecord } from '@/types/index';
import { EEntryType } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';
import type { RecordedToolCall } from './tool-call-recorder';

/** Optional inputs the entry builder cannot derive from the SDK event alone. */
export interface BuildAssistantEntryExtras {
  /** Approximate time the first stream chunk of this step arrived (streaming runs). */
  firstTokenAt?: string;
  /**
   * Start of this step, used when the SDK event carries no response timestamp.
   * When omitted, timing.startedAt / durationMs are simply not written.
   */
  startedAt?: string;
  /** End of this step, used when the caller knows it better than build time. */
  endedAt?: string;
  /**
   * Sampling temperature from ProviderConfig — recorded on AssistantEntry.model
   * when configured. Metadata-only: not fabricated when absent.
   */
  temperature?: number;
  /**
   * Max output tokens from ProviderConfig — recorded on AssistantEntry.model
   * when configured. Metadata-only: not fabricated when absent.
   */
  maxOutputTokens?: number;
  /** Distributed tracing id, when the caller has telemetry context. Never fabricated. */
  traceId?: string;
  /** Distributed tracing span id, when the caller has telemetry context. Never fabricated. */
  spanId?: string;
  /** Live tool execution records, keyed by toolCallId. */
  recordedToolCalls?: (toolCallId: string) => RecordedToolCall | undefined;
}

/**
 * Build a single AssistantEntry from a streamText onStepFinish event.
 * One event = one LLM step = one AssistantEntry.
 *
 * LLM metadata (model / usage detail / timing / requestId) is filled on a
 * best-effort basis from the event: fields the provider or SDK does not
 * supply are omitted entirely, never fabricated.
 */
export function buildAssistantEntry(
  event: OnStepFinishEvent,
  sessionId: string,
  uuid?: string,
  extras?: BuildAssistantEntryExtras,
): AssistantEntry {
  const ts = nowISO();
  const text = event.text ?? '';
  const reasoningText =
    event.reasoningText?.trim() ||
    // Fallback: join per-part reasoning when reasoningText is not populated
    (event.reasoning ?? []).map((r) => r.text).filter(Boolean).join('\n') ||
    undefined;
  const reasoning = reasoningText && reasoningText !== '[]' ? reasoningText : undefined;

  const lookupRecord = extras?.recordedToolCalls;

  // Extract tool call records
  const toolCalls: ToolCallRecord[] | undefined =
    event.toolCalls?.length
      ? event.toolCalls.map((tc) => {
          const rec = lookupRecord?.(tc.toolCallId);
          return {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            arguments:
              // SDK OnStepFinishEvent type incomplete
              typeof (tc as any).args === 'string'
                ? (tc as any).args
                : JSON.stringify((tc as any).args ?? (tc as any).input ?? {}),
            ...(rec?.taskId !== undefined && { taskId: rec.taskId }),
            ...(rec?.status !== undefined && { status: rec.status }),
            ...(rec?.startedAt !== undefined && { startedAt: rec.startedAt }),
            ...(rec?.endedAt !== undefined && { endedAt: rec.endedAt }),
            ...(rec?.errorType !== undefined && { errorType: rec.errorType }),
          };
        })
      : [];

  // Extract tool result records (includes tool-error from SDK validation failures)
  const results: ToolResultRecord[] = [];

  /** Merge live execution record into a result record. */
  const withRecordMeta = (r: ToolResultRecord): ToolResultRecord => {
    const rec = lookupRecord?.(r.toolCallId);
    if (!rec) return r;
    return {
      ...r,
      ...(rec.status !== undefined && { status: rec.status }),
      ...(rec.errorType !== undefined && { errorType: rec.errorType }),
      ...(rec.startedAt !== undefined && { startedAt: rec.startedAt }),
      ...(rec.endedAt !== undefined && { endedAt: rec.endedAt }),
    };
  };

  // Normal tool results
  if (event.toolResults?.length) {
    results.push(
      ...event.toolResults.map((tr) => withRecordMeta({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: {
          type: 'text' as const,
          value:
            // SDK OnStepFinishEvent type incomplete
            typeof (tr as any).output === 'string'
              ? (tr as any).output
              : JSON.stringify((tr as any).output ?? ''),
        },
      })),
    );
  }

  // Tool errors from SDK input validation failures (e.g. zod schema mismatch).
  // SDK produces type: "tool-error" chunks that are NOT included in event.toolResults.
  const content = (event as any).content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'tool-error' && part.toolCallId) {
        results.push(withRecordMeta({
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? 'unknown',
          output: {
            type: 'text' as const,
            value: part.error?.message ?? part.error ?? 'Tool input validation failed',
          },
          isError: true,
          status: 'failed',
          errorType: 'ToolInputValidationError',
        }));
      }
    }
  }

  const toolResults: ToolResultRecord[] | undefined = results;

  // --- Usage (single-step values, never cumulative) ---
  const rawUsage: any = event.usage;
  const usage = rawUsage
    ? {
        inputTokens: rawUsage.inputTokens ?? 0,
        outputTokens: rawUsage.outputTokens ?? 0,
        ...(cachedInputOf(rawUsage) !== undefined && { cachedInputTokens: cachedInputOf(rawUsage) }),
        ...(reasoningTokensOf(rawUsage) !== undefined && { reasoningTokens: reasoningTokensOf(rawUsage) }),
        ...(rawUsage.totalTokens !== undefined && { totalTokens: rawUsage.totalTokens }),
      }
    : undefined;

  // --- Model metadata (best effort) ---
  // provider/model come from the SDK event; temperature/maxOutputTokens are
  // backfilled from ProviderConfig via extras. Any source missing → omitted.
  const modelInfo: any = (event as any).model;
  const model =
    (modelInfo && (modelInfo.provider !== undefined || modelInfo.modelId !== undefined))
      || extras?.temperature !== undefined
      || extras?.maxOutputTokens !== undefined
      ? {
          ...(modelInfo?.provider !== undefined && { provider: modelInfo.provider }),
          ...(modelInfo?.modelId !== undefined && { model: modelInfo.modelId }),
          ...(extras?.temperature !== undefined && { temperature: extras.temperature }),
          ...(extras?.maxOutputTokens !== undefined && { maxOutputTokens: extras.maxOutputTokens }),
        }
      : undefined;

  // --- Timing (best effort; firstTokenAt comes from the streaming loop) ---
  const stepStartedAt = toIso((event as any).response?.timestamp) ?? extras?.startedAt;
  const endedAt = extras?.endedAt ?? ts;
  const durationMs =
    stepStartedAt !== undefined
      ? Math.max(0, new Date(endedAt).getTime() - new Date(stepStartedAt).getTime())
      : undefined;
  const firstTokenAt = extras?.firstTokenAt;
  const timing =
    stepStartedAt !== undefined || firstTokenAt !== undefined
      ? {
          ...(stepStartedAt !== undefined && { startedAt: stepStartedAt }),
          ...(firstTokenAt !== undefined && { firstTokenAt }),
          endedAt,
          ...(durationMs !== undefined && { durationMs }),
        }
      : { endedAt };

  // --- Provider response id, when exposed ---
  const responseId = (event as any).response?.id;
  const requestId = typeof responseId === 'string' && responseId.length > 0 ? responseId : undefined;

  // --- Step index within the turn (SDK stepNumber is zero-based) ---
  const stepNumber = (event as any).stepNumber;

  return {
    type: EEntryType.Assistant,
    uuid: uuid ?? generateId('step'),
    parentUuid: null,
    sessionId,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: text,
      reasoning,
      usage,
    },
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    finishReason: event.finishReason as string | undefined,
    ...(typeof stepNumber === 'number' && { stepIndex: stepNumber }),
    ...(model !== undefined && { model }),
    ...(timing !== undefined && { timing }),
    ...(requestId !== undefined && { requestId }),
    ...(extras?.traceId !== undefined && { traceId: extras.traceId }),
    ...(extras?.spanId !== undefined && { spanId: extras.spanId }),
  };
}

/** Cached input tokens: deprecated top-level field or inputTokenDetails.cacheReadTokens. */
function cachedInputOf(usage: any): number | undefined {
  if (usage.cachedInputTokens !== undefined) return usage.cachedInputTokens;
  return usage.inputTokenDetails?.cacheReadTokens;
}

/** Reasoning tokens: deprecated top-level field or outputTokenDetails.reasoningTokens. */
function reasoningTokensOf(usage: any): number | undefined {
  if (usage.reasoningTokens !== undefined) return usage.reasoningTokens;
  return usage.outputTokenDetails?.reasoningTokens;
}

/** Coerce a Date / ISO string / epoch ms value into an ISO string, if possible. */
function toIso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}
