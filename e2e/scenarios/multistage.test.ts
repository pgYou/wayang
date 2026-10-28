import { describe, it, expect, afterAll } from 'vitest';
import { setupE2E, type E2ESetup } from '../harness';
import { isControllerRequest, isWorkerRequest } from '@/__tests__/fake-openai-provider';

let setup: E2ESetup | undefined;
afterAll(async () => { await setup?.dispose(); });

describe('e2e: multi-stage worker reuse', () => {
  it('multiStage task parks worker idle → follow-up assigned to same worker', async () => {
    setup = await setupE2E([
      {
        match: isControllerRequest,
        toolCalls: [{
          name: 'add_task',
          args: { title: 'Stage 1', description: 'First stage: report done.', priority: 'normal', multiStage: true },
        }],
      },
      { match: isControllerRequest, text: 'Stage 1 dispatched.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'stage 1 done' } }] },
      { match: isControllerRequest, text: 'Stage 1 finished, worker parked.' },
      {
        match: isControllerRequest,
        toolCalls: [{
          name: 'add_task',
          // Resolved at request time: the workerId only exists after stage 1.
          args: () => ({
            title: 'Stage 2',
            description: 'Second stage on the same worker.',
            priority: 'normal',
            assignToWorker: setup!.lastCompletedWorkerId(),
          }),
        }],
      },
      { match: isControllerRequest, text: 'Stage 2 dispatched.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'stage 2 done' } }] },
      { match: isControllerRequest, text: 'Stage 2 finished.' },
    ]);

    await setup.submit('start stage 1');

    // Stage 1 completes and the worker parks in idle (not disposed).
    await setup.waitFor('stage 1 completed', (s) =>
      s.history.length === 1 && s.history[0].status === 'completed' && s.history[0].result === 'stage 1 done');
    await setup.waitFor('worker parked idle', (s) =>
      s.activeWorkers.some((w) => w.status === 'idle'));

    await setup.submit('continue with stage 2');

    // Stage 2 completes on the SAME worker instance.
    await setup.waitFor('stage 2 completed', (s) => s.history.length === 2);
    expect(setup.state.history.every((t) => t.status === 'completed')).toBe(true);
    expect(setup.state.history[1].result).toBe('stage 2 done');
    const completedWorkerIds = setup.state.signals
      .filter((sig) => sig.type === 'completed')
      .map((sig) => String(sig.payload?.workerId));
    expect(completedWorkerIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(completedWorkerIds).size).toBe(1);
  }, 90_000);
});
