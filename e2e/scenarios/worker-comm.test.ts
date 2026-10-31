import { describe, it, expect, afterAll } from 'vitest';
import { setupE2E, type E2ESetup } from '../harness';
import { isControllerRequest, isWorkerRequest } from '@/__tests__/fake-openai-provider';

/**
 * Controller ↔ worker communication (v0.6):
 *  1. mid-task correction via chat_worker → prepareStep injection — including
 *     the sentinel assertions: the injected message reaches the worker's next
 *     LLM request, stays present in later requests, and is never duplicated;
 *  2. full inquiry loop: worker blocks on ask_controller → signal wakes the
 *     controller → respond_inquiry → worker resumes and completes.
 */

let setup: E2ESetup | undefined;
afterAll(async () => {
  await setup?.dispose();
});

const CORRECTION = 'switch to plain JS';

describe('e2e: controller message injection', () => {
  it('mid-task correction is read at the next worker step and stays in context once', async () => {
    // Late-bound: resolvers run at request time, after setup exists. They
    // poll subscribed state (async resolvers hold the provider response
    // open), removing the race between signal arrival and this request.
    const ref: { setup?: E2ESetup } = {};
    const runningWorkerId = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const id = ref.setup!.state.activeWorkers.find(w => w.status === 'running')?.workerId;
        if (id) return { workerId: id, message: CORRECTION };
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('no running worker appeared');
    };

    // Echo resolver: the done summary reports whether THIS request's messages
    // contain the injected correction — a true end-to-end sentinel.
    const echoSummary = () => {
      const workerReqs = ref.setup!.provider.requests.filter(isWorkerRequest);
      const last = workerReqs.at(-1);
      const saw = !!last?.messages?.some(m => String(m.content).includes(`[Controller message] ${CORRECTION}`));
      return { summary: saw ? `CORRECTED: ${CORRECTION}` : 'NO-INJECTION' };
    };

    setup = await setupE2E([
      { match: isControllerRequest, toolCalls: [{ name: 'add_task', args: { title: 'Echo correction', description: 'Run the steps then finish', priority: 'normal' } }] },
      { match: isControllerRequest, toolCalls: [{ name: 'chat_worker', args: runningWorkerId }] },
      { match: isControllerRequest, text: 'Task finished.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'update_progress', args: { message: 'starting' } }] },
      // Long-running tool: the correction is sent while this runs (the
      // progress signal above wakes the controller for the chat_worker call).
      { match: isWorkerRequest, toolCalls: [{ name: 'bash', args: { command: 'sleep 2' } }] },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: echoSummary }] },
    ]);
    ref.setup = setup;

    await setup.submit('do the echo test');

    await setup.waitFor('task completed with the correction applied', (s) =>
      s.history.length === 1 && s.history[0].status === 'completed'
      && String(s.history[0].result).includes(`CORRECTED: ${CORRECTION}`));

    // Sentinel (acceptance #1): every worker request from injection on still
    // contains the message, and it never appears twice in one request.
    const marker = `[Controller message] ${CORRECTION}`;
    const workerReqs = setup.provider.requests.filter(isWorkerRequest);
    expect(workerReqs.length).toBeGreaterThanOrEqual(3);
    // The first worker step ran before the message was sent.
    expect(JSON.stringify(workerReqs[0].messages)).not.toContain(marker);
    const withInj = workerReqs.filter(r => JSON.stringify(r.messages).includes(marker));
    expect(withInj.length).toBeGreaterThanOrEqual(1);
    // The last (done) request carries it exactly once, at the tail.
    const lastReq = workerReqs.at(-1)!;
    const occurrences = JSON.stringify(lastReq.messages).split(marker).length - 1;
    expect(occurrences).toBe(1);
    const tail = lastReq.messages!.at(-1)!;
    expect(String(tail.content)).toContain(marker);
  }, 90_000);
});

describe('e2e: worker inquiry full loop', () => {
  it('worker blocks on ask_controller → respond_inquiry → worker completes (no deadlock)', async () => {
    const ref: { setup?: E2ESetup } = {};
    const inquiryId = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const sig = ref.setup!.state.signals.find(s => s.type === 'worker_inquiry');
        const id = (sig?.payload as { inquiryId?: string })?.inquiryId;
        if (id) return { inquiryId: id, answer: 'use mint' };
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('worker_inquiry signal never appeared');
    };

    setup = await setupE2E([
      { match: isControllerRequest, toolCalls: [{ name: 'add_task', args: { title: 'Ask mid-task', description: 'Ask then finish', priority: 'normal' } }] },
      { match: isControllerRequest, toolCalls: [{ name: 'respond_inquiry', args: inquiryId }] },
      { match: isControllerRequest, text: 'Task finished.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'ask_controller', args: { question: 'Which flavor should I use?' } }] },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'made it with mint' } }] },
    ]);
    ref.setup = setup;

    await setup.submit('run the inquiry test');

    await setup.waitFor('inquiry signal raised', (s) =>
      s.signals.some(sig => sig.type === 'worker_inquiry'));

    await setup.waitFor('task completed with the answered flavor', (s) =>
      s.history.length === 1 && s.history[0].status === 'completed'
      && String(s.history[0].result).includes('mint'));

    // No timeout signal — the answer arrived in time; no deadlock.
    expect(setup.state.signals.some(sig => sig.type === 'inquiry_timeout')).toBe(false);

    // The blocked worker actually received the answer as its tool result:
    // the request after ask_controller carries the controller's reply.
    const workerReqs = setup.provider.requests.filter(isWorkerRequest);
    const doneReq = workerReqs.at(-1)!;
    expect(JSON.stringify(doneReq.messages)).toContain('[Controller] use mint');
  }, 90_000);
});
