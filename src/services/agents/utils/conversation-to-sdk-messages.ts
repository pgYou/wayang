import type { ModelMessage } from 'ai';
import type { ConversationEntry, AssistantEntry } from '@/types/index';
import { EEntryType, ESystemSubtype } from '@/types/index';
import type { SignalEntry } from '@/types/index';

/**
 * Replay text for `interrupted` system markers: the next turn must know the
 * previous response was cut by the user, without inferring it from message
 * length. Mirrors the `[WORKER PROGRESS SIGNAL: …]` labeling of signal
 * entries; all other system entries remain skipped (compact markers, errors).
 */
const USER_INTERRUPT_REPLAY =
  '[USER INTERRUPT] The user aborted the previous response while it was streaming '
  + '(ESC in the TUI). Any assistant text immediately before this marker is a truncated '
  + 'partial — treat it as incomplete context, not as a finished answer or instructions.';

/**
 * Convert ConversationEntry[] to Vercel AI SDK ModelMessage[].
 *
 * Each AssistantEntry maps directly to 1-2 ModelMessages — no merging needed.
 */
export function conversationToSdkMessages(entries: ConversationEntry[]): ModelMessage[] {
  // Thinking endpoints (DeepSeek/GLM) require every replayed assistant message
  // to carry reasoning_content and reject the whole request otherwise. If any
  // entry captured reasoning, the model is a thinking model: backfill entries
  // that lack it (steps where the model skipped thinking). The placeholder must
  // be non-empty — the provider serialization drops empty-string reasoning parts.
  const isThinkingModel = entries.some(
    (e) => e.type === EEntryType.Assistant && Boolean((e as AssistantEntry).message.reasoning),
  );

  const messages: ModelMessage[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case EEntryType.User:
        messages.push({ role: 'user' as const, content: entry.message.content });
        break;

      case EEntryType.Assistant: {
        // For skip_reply entries: strip fabricated content, keep tool call intact
        const hasSkipReply = entry.toolCalls?.some(tc => tc.toolName === 'skip_reply');
        const effectiveContent = hasSkipReply ? '' : entry.message.content;

        // Build assistant content parts
        const parts: Array<
          { type: 'reasoning'; text: string } |
          { type: 'text'; text: string } |
          { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
        > = [];

        // Thinking models (DeepSeek/GLM-style) require the reasoning to be
        // passed back on assistant messages; missing reasoning on a single
        // entry gets a placeholder so the replay is not rejected.
        const reasoningText = entry.message.reasoning || (isThinkingModel ? ' ' : undefined);
        if (reasoningText) {
          parts.push({ type: 'reasoning' as const, text: reasoningText });
        }

        if (effectiveContent) {
          parts.push({ type: 'text' as const, text: effectiveContent });
        }

        if (entry.toolCalls?.length) {
          for (const tc of entry.toolCalls) {
            parts.push({
              type: 'tool-call' as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: parseJsonSafe(tc.arguments),
            });
          }
        }

        // Emit assistant message (string if pure text, array if mixed)
        if (parts.length === 1 && parts[0]!.type === 'text') {
          messages.push({ role: 'assistant' as const, content: parts[0]!.text });
        } else if (parts.length > 0) {
          messages.push({ role: 'assistant' as const, content: parts });
        }

        // Emit tool results as separate tool message
        if (entry.toolResults?.length) {
          messages.push({
            role: 'tool' as const,
            content: entry.toolResults.map((tr) => ({
              type: 'tool-result' as const,
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              output: tr.output,
            })),
          });
        }

        // Synthesize placeholder results for orphan tool calls (e.g. aborted step)
        // Without this, SDK throws MissingToolResultsError on the next streamText call.
        if (entry.toolCalls?.length) {
          const resultIds = new Set(entry.toolResults?.map(tr => tr.toolCallId) ?? []);
          const orphanCalls = entry.toolCalls.filter(tc => !resultIds.has(tc.toolCallId));
          if (orphanCalls.length > 0) {
            messages.push({
              role: 'tool' as const,
              content: orphanCalls.map((tc) => ({
                type: 'tool-result' as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                output: { type: 'text' as const, value: '[No result — step was interrupted]' },
              })),
            });
          }
        }
        break;
      }
      case EEntryType.System:
        // Interrupt markers are the one system entry the LLM must see: the
        // turn was cut by the user, and the next turn must not mistake the
        // partial before it for a finished answer. All other system entries
        // (compact markers, error records) stay skipped.
        if (entry.subtype === ESystemSubtype.Interrupted) {
          messages.push({ role: 'system' as const, content: USER_INTERRUPT_REPLAY });
        }
        break;

      case EEntryType.Signal: {
        const sig = entry as SignalEntry;
        const label = sig.subtype.replace('worker_', '').toUpperCase();
        // Identity segments (issue #30): task= when the signal concerns a
        // dispatched task, worker= when a worker is assigned. The worker id
        // lives ONLY here — body text describes what happened without
        // repeating the id in per-type templates.
        const taskTag = sig.taskId ? ` task=${sig.taskId}` : '';
        const workerTag = sig.workerId ? ` worker=${sig.workerId}` : '';
        messages.push({
          role: 'system' as const,
          content: `[WORKER PROGRESS SIGNAL: ${label}${taskTag}${workerTag}] ${sig.content}`,
        });
        break;
      }
    }
  }

  return messages;
}

/** Parse JSON string safely, returning parsed object or raw string. */
function parseJsonSafe(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
