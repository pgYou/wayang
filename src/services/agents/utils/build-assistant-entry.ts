import type { OnStepFinishEvent } from 'ai';
import type { AssistantEntry, ToolCallRecord, ToolResultRecord } from '@/types/index';
import { EEntryType } from '@/types/index';
import { generateId } from '@/utils/id';
import { nowISO } from '@/utils/time';

/**
 * Build a single AssistantEntry from a streamText onStepFinish event.
 * One event = one LLM step = one AssistantEntry.
 */
export function buildAssistantEntry(
  event: OnStepFinishEvent,
  sessionId: string,
  uuid?: string,
): AssistantEntry {
  const ts = nowISO();
  const text = event.text ?? '';
  const reasoning =
    event.reasoningText &&
    event.reasoningText !== '[]' &&
    event.reasoningText.length > 0
      ? event.reasoningText
      : undefined;

  // Extract tool call records
  const toolCalls: ToolCallRecord[] | undefined =
    event.toolCalls?.length
      ? event.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments:
            // SDK OnStepFinishEvent type incomplete
            typeof (tc as any).args === 'string'
              ? (tc as any).args
              : JSON.stringify((tc as any).args ?? (tc as any).input ?? {}),
        }))
      : [];

  // Extract tool result records (includes tool-error from SDK validation failures)
  const results: ToolResultRecord[] = [];

  // Normal tool results
  if (event.toolResults?.length) {
    results.push(
      ...event.toolResults.map((tr) => ({
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
        results.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? 'unknown',
          output: {
            type: 'text' as const,
            value: part.error?.message ?? part.error ?? 'Tool input validation failed',
          },
          isError: true,
        });
      }
    }
  }

  const toolResults: ToolResultRecord[] | undefined = results;

  const usage = event.usage
    ? { inputTokens: event.usage.inputTokens ?? 0, outputTokens: event.usage.outputTokens ?? 0 }
    : undefined;

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
  };
}
