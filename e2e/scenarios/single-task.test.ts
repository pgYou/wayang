import { describe, it, expect, afterAll } from 'vitest';
import { setupE2E, type E2ESetup } from '../harness';
import { isControllerRequest, isWorkerRequest } from '@/__tests__/fake-openai-provider';

let setup: E2ESetup | undefined;
afterAll(async () => { await setup?.dispose(); });

// Every worker signal (progress/completed) wakes the controller for another
// LLM run — the script must account for each wake, in content-matched order.
describe('e2e: single task full chain', () => {
  it('user input → controller add_task → worker progress/done → completed → controller reply', async () => {
    setup = await setupE2E([
      {
        match: isControllerRequest,
        toolCalls: [{
          name: 'add_task',
          args: { title: 'Report hi', description: 'Think briefly, then report done.', priority: 'normal' },
        }],
      },
      { match: isControllerRequest, text: 'Dispatched the task.' },
      {
        match: isWorkerRequest,
        toolCalls: [{ name: 'update_progress', args: { message: 'thinking hard' } }],
      },
      { match: isControllerRequest, text: 'Progress noted.' },
      {
        match: isWorkerRequest,
        toolCalls: [{ name: 'done', args: { summary: 'Finished thinking' } }],
      },
      { match: isControllerRequest, text: 'Task finished successfully.' },
    ]);

    await setup.submit('please run the hi task');

    // Task lands in history as completed with the done() summary.
    await setup.waitFor('task completed in history', (s) =>
      s.history.length === 1 && s.history[0].status === 'completed');
    expect(setup.state.history[0].result).toBe('Finished thinking');

    // A completed signal reached the controller.
    await setup.waitFor('completed signal', (s) =>
      s.signals.some((sig) => sig.type === 'completed' && sig.payload?.taskId === setup!.state.history[0].id));

    // The controller produced a final assistant reply (wait for it — the
    // completed signal arrives before the controller's own response run).
    await setup.waitFor('controller final reply', (s) =>
      JSON.stringify(s.conversation).includes('Task finished successfully.'));

    const snapshot = await setup.client.request<{ data: unknown }>('get_snapshot', {
      target: 'controllerAgent',
      path: 'conversation',
    });
    const serialized = JSON.stringify(snapshot.data);
    expect(serialized).toContain('Task finished successfully.');
    expect(serialized).toContain('please run the hi task');
  }, 90_000);
});
