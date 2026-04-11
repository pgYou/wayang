import type { ModelMessage } from 'ai';
import type { ConversationEntry } from '@/types/index';
import { EEntryType } from '@/types/index';
import type { SignalEntry } from '@/types/index';

/**
 * Convert ConversationEntry[] to Vercel AI SDK ModelMessage[].
 *
 * Each AssistantEntry maps directly to 1-2 ModelMessages — no merging needed.
 */
export function conversationToSdkMessages(entries: ConversationEntry[]): ModelMessage[] {
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
          { type: 'text'; text: string } |
          { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
        > = [];

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
        // Compact markers injected by ContextManager.getMessages() — skip
        break;

      case EEntryType.Signal: {
        const sig = entry as SignalEntry;
        const label = sig.subtype.replace('worker_', '').toUpperCase();
        const taskTag = sig.taskId ? ` task=${sig.taskId}` : '';
        messages.push({
          role: 'system' as const,
          content: `[WORKER PROGRESS SIGNAL: ${label}${taskTag}] ${sig.content}`,
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
