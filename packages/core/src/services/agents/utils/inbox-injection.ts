/**
 * Controller-message injection via the AI SDK's prepareStep hook.
 *
 * The SDK derives each step's message base as [initial ... model responses] —
 * a prepareStep override applies to THAT request only. So this hook has to
 * re-merge every injected `[Controller message]` into each later step's
 * request itself. It does so at the message's ARRIVAL POSITION, not the tail:
 * each drained message records a cursor (how many response messages existed
 * when it arrived), and the merge inserts it exactly at that boundary — right
 * before the assistant reply of the step it arrived in. A message therefore
 * appears exactly once per request, in conversation order, instead of being
 * re-appended as the "latest" user message on every later step.
 * Persisting the message into the conversation (so it survives compaction
 * rebuilds and future stages) is the caller's `onInject` callback's job.
 */
import type { ModelMessage } from 'ai';

/** Uniform text of an injected controller message, in-model and in-record. */
export function controllerMessageContent(content: string): string {
  return `[Controller message] ${content}`;
}

export interface InboxInjection {
  /** prepareStep hook — pass straight through to streamText options. */
  prepareStep: (options: { messages: ModelMessage[] }) => { messages: ModelMessage[] } | undefined;
  /** Messages injected so far (copy, arrival order) — for tests and debugging. */
  injectedMessages: () => ModelMessage[];
}

export function createInboxInjection(deps: {
  /** Drain unread inbox messages (destructive). */
  drainInbox: () => Array<{ content: string }>;
  /** Persist one message (conversation entry etc.) at injection time. */
  onInject: (content: string) => void;
}): InboxInjection {
  /**
   * Message-count boundary of the run, captured at the first hook invocation
   * that actually injects (or re-merges): everything below this index in a
   * step's `messages` is the fixed prefix (initial prompt + whatever
   * responses already existed); everything above it is a response message
   * produced during THIS run. The SDK appends response messages and never
   * removes any, so the split stays valid for the whole run.
   */
  let baseLength: number | null = null;
  /** Injected messages in arrival order, each with its insertion cursor. */
  const injected: Array<{ message: ModelMessage; insertAfter: number }> = [];

  return {
    prepareStep({ messages }: { messages: ModelMessage[] }) {
      const fresh = deps.drainInbox();
      // Nothing new AND nothing previously injected — zero-overhead fast path
      // (the request goes out byte-identical to not enabling the hook).
      if (fresh.length === 0 && injected.length === 0) return undefined;
      if (baseLength === null) baseLength = messages.length;
      // Defensive clamp: responseMessages is append-only in the SDK, but a
      // short array must never read past its end.
      const responseCount = Math.max(0, messages.length - baseLength);
      for (const m of fresh) {
        injected.push({
          message: { role: 'user', content: controllerMessageContent(m.content) },
          // After the response messages that exist NOW — i.e. at the tail of
          // the conversation as this step sees it, before this step's reply.
          insertAfter: responseCount,
        });
        deps.onInject(m.content);
      }
      // Re-merge: prefix + response messages with the injections slotted at
      // their arrival boundaries. `injected` is in arrival order and its
      // cursors are non-decreasing (response messages only accumulate), so a
      // single forward walk preserves the full ordering.
      const merged: ModelMessage[] = messages.slice(0, baseLength);
      let cursor = 0;
      for (const inj of injected) {
        while (cursor < Math.min(inj.insertAfter, responseCount)) {
          merged.push(messages[baseLength + cursor]!);
          cursor++;
        }
        merged.push(inj.message);
      }
      while (cursor < responseCount) {
        merged.push(messages[baseLength + cursor]!);
        cursor++;
      }
      return { messages: merged };
    },
    injectedMessages: () => injected.map((i) => i.message),
  };
}
