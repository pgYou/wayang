import { describe, it, expect, vi } from 'vitest';
import { createInboxInjection, controllerMessageContent } from '@/services/agents/utils/inbox-injection';
import type { ModelMessage } from 'ai';

function run(hook: (options: { messages: ModelMessage[] }) => { messages: ModelMessage[] } | undefined, base: ModelMessage[]) {
  const r = hook({ messages: base });
  return r === undefined ? base : r.messages;
}

/** Count occurrences of one injected message across a messages array. */
function occurrences(messages: ModelMessage[], text: string): number {
  return messages.filter(m => m.role === 'user' && m.content === text).length;
}

describe('createInboxInjection (prepareStep hook)', () => {
  const base: ModelMessage[] = [{ role: 'user', content: 'task description' }];

  it('returns undefined when the inbox is empty and nothing was ever injected (zero-overhead fast path)', () => {
    const onInject = vi.fn();
    const { prepareStep } = createInboxInjection({ drainInbox: () => [], onInject });
    expect(prepareStep({ messages: base })).toBeUndefined();
    expect(onInject).not.toHaveBeenCalled();
  });

  it('appends a new message to the step messages and persists it via onInject', () => {
    let inbox = [{ content: 'use approach B' }];
    const onInject = vi.fn();
    const { prepareStep } = createInboxInjection({
      drainInbox: () => { const m = inbox; inbox = []; return m; },
      onInject,
    });

    const out = run(prepareStep, base);
    const text = controllerMessageContent('use approach B');
    expect(out[out.length - 1]).toEqual({ role: 'user', content: text });
    expect(onInject).toHaveBeenCalledWith('use approach B');
  });

  it('keeps an injected instruction present at the tail of every later step, exactly once (persistence + idempotence)', () => {
    // Acceptance: after injection, every round's messages still contain the
    // instruction, and no round contains it twice.
    let inbox = [{ content: 'first directive' }];
    const { prepareStep } = createInboxInjection({
      drainInbox: () => { const m = inbox; inbox = []; return m; },
      onInject: () => {},
    });

    // Step N: injection happens.
    const stepN = run(prepareStep, base);
    expect(occurrences(stepN, controllerMessageContent('first directive'))).toBe(1);

    // Steps N+1, N+2: nothing new — the instruction must STILL be in context.
    const stepN1 = run(prepareStep, [...base, { role: 'assistant', content: 'partial work' }]);
    expect(occurrences(stepN1, controllerMessageContent('first directive'))).toBe(1);
    const stepN2 = run(prepareStep, [...base, { role: 'assistant', content: 'more work' }]);
    expect(occurrences(stepN2, controllerMessageContent('first directive'))).toBe(1);
  });

  it('accumulates multiple instructions in stable order, each exactly once', () => {
    let inbox = [{ content: 'directive-1' }];
    const { prepareStep } = createInboxInjection({
      drainInbox: () => { const m = inbox; inbox = []; return m; },
      onInject: () => {},
    });

    run(prepareStep, base); // injects directive-1
    inbox = [{ content: 'directive-2' }];
    const out = run(prepareStep, base); // injects directive-2

    const d1 = controllerMessageContent('directive-1');
    const d2 = controllerMessageContent('directive-2');
    expect(occurrences(out, d1)).toBe(1);
    expect(occurrences(out, d2)).toBe(1);
    expect(out[out.length - 2].content).toBe(d1);
    expect(out[out.length - 1].content).toBe(d2);
  });
});
