import { describe, it, expect, vi } from 'vitest';
import { createInboxInjection, controllerMessageContent } from '@/services/agents/utils/inbox-injection';
import type { ModelMessage } from 'ai';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

/** Deterministic inbox the tests deliver into between steps. */
function makeInbox() {
  let queue: Array<{ content: string }> = [];
  return {
    deliver: (...contents: string[]) => {
      queue.push(...contents.map((content) => ({ content })));
    },
    drain: () => {
      const m = queue;
      queue = [];
      return m;
    },
  };
}

/**
 * Drive the hook the way the SDK's step loop does: step k's prepareStep sees
 * [initialMessages, ...responseMessages produced by steps 0..k-1] and an
 * override applies to THAT request only (the loop re-derives the base, it
 * never absorbs the override). `before` on a step is the message-arrival
 * point just ahead of that step's prepareStep call. Returns the message list
 * each step would actually send.
 */
function driveStepLoop(
  hook: (options: { messages: ModelMessage[] }) => { messages: ModelMessage[] } | undefined,
  opts: {
    initial: ModelMessage[];
    steps: Array<{ before?: () => void; responses?: ModelMessage[] }>;
  },
): ModelMessage[][] {
  const responseMessages: ModelMessage[] = [];
  const requests: ModelMessage[][] = [];
  for (const step of opts.steps) {
    step.before?.();
    const stepInputMessages = [...opts.initial, ...responseMessages];
    const result = hook({ messages: stepInputMessages });
    requests.push(result === undefined ? stepInputMessages : result.messages);
    responseMessages.push(...(step.responses ?? []));
  }
  return requests;
}

/** Count occurrences of one injected message across a messages array. */
function occurrences(messages: ModelMessage[], text: string): number {
  return messages.filter((m) => m.role === 'user' && m.content === text).length;
}

describe('createInboxInjection (prepareStep hook)', () => {
  const initial: ModelMessage[] = [user('task description')];

  it('returns undefined on every step when nothing is ever delivered (zero-overhead fast path)', () => {
    const inbox = makeInbox();
    const onInject = vi.fn();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject });

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [{ responses: [assistant('r0')] }, { responses: [assistant('r1')] }, {}],
    });

    // Byte-identical to not enabling the hook: the SDK's own arrays pass through.
    expect(requests).toEqual([
      [user('task description')],
      [user('task description'), assistant('r0')],
      [user('task description'), assistant('r0'), assistant('r1')],
    ]);
    expect(onInject).not.toHaveBeenCalled();
  });

  it('appends a first-step message to the step messages and persists it via onInject', () => {
    const inbox = makeInbox();
    const onInject = vi.fn();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject });

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [
        { before: () => inbox.deliver('use approach B'), responses: [assistant('r0')] },
        { responses: [assistant('r1')] },
      ],
    });

    const text = controllerMessageContent('use approach B');
    // Step 0: injected at the tail of the conversation the model sees so far.
    expect(requests[0]).toEqual([user('task description'), user(text)]);
    // Step 1: still exactly once, before r0 (the reply it preceded).
    expect(requests[1]).toEqual([user('task description'), user(text), assistant('r0')]);
    expect(onInject).toHaveBeenCalledTimes(1);
    expect(onInject).toHaveBeenCalledWith('use approach B');
  });

  it('a message arriving at step 2 appears once, before step 2’s reply — never as the tail of later steps', () => {
    const inbox = makeInbox();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject: () => {} });

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [
        { responses: [assistant('r0')] },                                                     // step 0
        { responses: [assistant('r1')] },                                                     // step 1
        { before: () => inbox.deliver('switch to plan B'), responses: [assistant('r2')] },    // step 2 — arrival
        { responses: [assistant('r3')] },                                                     // step 3
        { responses: [assistant('r4')] },                                                     // step 4
      ],
    });

    const text = controllerMessageContent('switch to plan B');

    // Step 2 request: the message is the tail of the conversation as it stood
    // when it arrived (the model replies to it in this step).
    expect(requests[2]).toEqual([user('task description'), assistant('r0'), assistant('r1'), user(text)]);

    // Step 3: exactly once, positioned before r2 — the reply of the step the
    // message arrived in — and NOT at the request tail (the old bug had it
    // after every reply, reading like a freshly re-sent message).
    expect(occurrences(requests[3], text)).toBe(1);
    expect(requests[3]).toEqual([
      user('task description'), assistant('r0'), assistant('r1'),
      user(text), assistant('r2'),
    ]);
    expect(requests[3][requests[3].length - 1]).toEqual(assistant('r2'));

    // Step 4: still exactly once, still before r2, stable relative position.
    expect(occurrences(requests[4], text)).toBe(1);
    expect(requests[4]).toEqual([
      user('task description'), assistant('r0'), assistant('r1'),
      user(text), assistant('r2'), assistant('r3'),
    ]);
    expect(requests[4][requests[4].length - 1]).toEqual(assistant('r3'));
  });

  it('messages arriving in the same step appear once each, in arrival order', () => {
    const inbox = makeInbox();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject: () => {} });

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [
        { responses: [assistant('r0')] },
        { before: () => inbox.deliver('first note', 'second note'), responses: [assistant('r1')] },
        { responses: [assistant('r2')] },
      ],
    });

    const t1 = controllerMessageContent('first note');
    const t2 = controllerMessageContent('second note');
    // Step 1: both at the tail, arrival order preserved.
    expect(requests[1]).toEqual([
      user('task description'), assistant('r0'), user(t1), user(t2),
    ]);
    // Step 2: both once, before r1, order preserved.
    expect(requests[2]).toEqual([
      user('task description'), assistant('r0'), user(t1), user(t2), assistant('r1'),
    ]);
    expect(occurrences(requests[2], t1)).toBe(1);
    expect(occurrences(requests[2], t2)).toBe(1);
  });

  it('total message count grows only with new responses and injections, not with steps (regression)', () => {
    const inbox = makeInbox();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject: () => {} });

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [
        { responses: [assistant('r0')] },
        { before: () => inbox.deliver('only directive'), responses: [assistant('r1')] },
        { responses: [assistant('r2')] },
        { responses: [assistant('r3')] },
        { responses: [assistant('r4')] },
        { responses: [assistant('r5')] },
      ],
    });

    const text = controllerMessageContent('only directive');
    // length = initial(1) + responses(0..k-1) + injected(1 from step 1 on) —
    // one response per step, no per-step re-append growth.
    expect(requests.map((r) => r.length)).toEqual([1, 3, 4, 5, 6, 7]);
    for (let k = 1; k < requests.length; k++) {
      expect(occurrences(requests[k]!, text)).toBe(1);
    }
  });

  it('several instructions arriving in different steps keep a stable interleaved order, each exactly once', () => {
    const inbox = makeInbox();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject: () => {} });

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [
        { before: () => inbox.deliver('directive-1'), responses: [assistant('r0')] },
        { responses: [assistant('r1')] },
        { before: () => inbox.deliver('directive-2'), responses: [assistant('r2')] },
        { responses: [assistant('r3')] },
      ],
    });

    const d1 = controllerMessageContent('directive-1');
    const d2 = controllerMessageContent('directive-2');
    expect(occurrences(requests[3]!, d1)).toBe(1);
    expect(occurrences(requests[3]!, d2)).toBe(1);
    expect(requests[3]).toEqual([
      user('task description'),
      user(d1),
      assistant('r0'), assistant('r1'),
      user(d2),
      assistant('r2'),
    ]);
  });

  it('handles steps whose response spans assistant + tool messages (cursor counts messages, not steps)', () => {
    const inbox = makeInbox();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject: () => {} });

    const toolCallStep: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc-1', toolName: 'bash', output: { type: 'json', value: { stdout: 'ok' } } }] },
    ];

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [
        { responses: toolCallStep },
        { before: () => inbox.deliver('check the output'), responses: [assistant('r1')] },
        { responses: [assistant('r2')] },
      ],
    });

    const text = controllerMessageContent('check the output');
    // Step 1: after both response messages of step 0 (assistant + tool).
    expect(requests[1]).toEqual([...initial, ...toolCallStep, user(text)]);
    // Step 2: before r1, after the tool result — once.
    expect(requests[2]).toEqual([...initial, ...toolCallStep, user(text), assistant('r1')]);
    expect(occurrences(requests[2]!, text)).toBe(1);
  });

  it('a message that arrives after a step’s reply becomes the next step’s newest user message', () => {
    const inbox = makeInbox();
    const { prepareStep } = createInboxInjection({ drainInbox: inbox.drain, onInject: () => {} });

    const requests = driveStepLoop(prepareStep, {
      initial,
      steps: [
        { responses: [assistant('r0')] },
        // Message lands only AFTER step 1 produced its reply (e.g. it arrived
        // while step 1's tool was executing) — so step 2 drains it.
        { responses: [assistant('r1')] },
        { before: () => inbox.deliver('late arrival'), responses: [assistant('r2')] },
        { responses: [assistant('r3')] },
      ],
    });

    const text = controllerMessageContent('late arrival');
    // Step 2 sees it as its newest user message (tail at delivery time)…
    expect(requests[2]).toEqual([user('task description'), assistant('r0'), assistant('r1'), user(text)]);
    // …and step 3 keeps it after r1, before r2 — once.
    expect(requests[3]).toEqual([
      user('task description'), assistant('r0'), assistant('r1'), user(text), assistant('r2'),
    ]);
    expect(occurrences(requests[3]!, text)).toBe(1);
  });
});
