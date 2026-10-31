/**
 * Controller-message injection via the AI SDK's prepareStep hook.
 *
 * The SDK derives each step's message base as [initial ... model responses] —
 * a prepareStep override applies to THAT request only. So this factory keeps
 * every injected `[Controller message]` in a closure list and re-appends the
 * whole list on every step: an instruction stays in context ("latest at the
 * bottom") until the run ends. Persisting the message into the conversation
 * (so it survives compaction rebuilds and future stages) is the caller's
 * `onInject` callback's job.
 */
import type { ModelMessage } from 'ai';

/** Uniform text of an injected controller message, in-model and in-record. */
export function controllerMessageContent(content: string): string {
  return `[Controller message] ${content}`;
}

export interface InboxInjection {
  /** prepareStep hook — pass straight through to streamText options. */
  prepareStep: (options: { messages: ModelMessage[] }) => { messages: ModelMessage[] } | undefined;
  /** Messages injected so far (copy) — for tests and debugging. */
  injectedMessages: () => ModelMessage[];
}

export function createInboxInjection(deps: {
  /** Drain unread inbox messages (destructive). */
  drainInbox: () => Array<{ content: string }>;
  /** Persist one message (conversation entry etc.) at injection time. */
  onInject: (content: string) => void;
}): InboxInjection {
  const injected: ModelMessage[] = [];
  return {
    prepareStep({ messages }: { messages: ModelMessage[] }) {
      const fresh = deps.drainInbox();
      // Nothing new AND nothing previously injected — zero-overhead fast path
      // (the request goes out byte-identical to not enabling the hook).
      if (fresh.length === 0 && injected.length === 0) return undefined;
      for (const m of fresh) {
        injected.push({ role: 'user', content: controllerMessageContent(m.content) });
        deps.onInject(m.content);
      }
      return { messages: [...messages, ...injected] };
    },
    injectedMessages: () => [...injected],
  };
}
