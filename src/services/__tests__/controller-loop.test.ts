import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mainControllerLoop } from '@/services/controller-loop';
import type { Supervisor } from '@/services/supervisor';

function createMockSupervisor(): any {
  return {
    signalQueue: {
      dequeueUnread: vi.fn().mockReturnValue([]),
      waitForSignal: vi.fn().mockResolvedValue(undefined),
    },
    controllerAgent: {
      run: vi.fn().mockImplementation(() => (async function* () {
        yield 'ok';
        return { text: 'ok' };
      })()),
      needsCompaction: vi.fn().mockReturnValue(false),
      state: {
        set: vi.fn(),
        append: vi.fn(),
      },
    },
    ctx: {
      abortController: new AbortController(),
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    },
  };
}

describe('mainControllerLoop', () => {
  it('should dequeue signals and execute them', async () => {
    const supervisor = createMockSupervisor();
    const signals = [{ id: '1', source: 'user', type: 'input', payload: { text: 'hello' } }];
    let callCount = 0;
    supervisor.signalQueue.dequeueUnread.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return signals;
      // Abort after first successful process
      supervisor.ctx.abortController.abort();
      return [];
    });

    await mainControllerLoop(supervisor as unknown as Supervisor);

    expect(supervisor.controllerAgent.run).toHaveBeenCalledWith(signals);
  });

  it('should wait for signals when queue is empty', async () => {
    const supervisor = createMockSupervisor();
    let waitCount = 0;
    supervisor.signalQueue.waitForSignal.mockImplementation(async () => {
      waitCount++;
      if (waitCount >= 2) {
        supervisor.ctx.abortController.abort();
      }
    });

    await mainControllerLoop(supervisor as unknown as Supervisor);

    expect(supervisor.signalQueue.waitForSignal).toHaveBeenCalled();
  });

  it('should stop when aborted during waitForSignal', async () => {
    const supervisor = createMockSupervisor();
    supervisor.signalQueue.waitForSignal.mockImplementation(async () => {
      supervisor.ctx.abortController.abort();
    });

    await mainControllerLoop(supervisor as unknown as Supervisor);

    expect(supervisor.ctx.abortController.signal.aborted).toBe(true);
  });

  it('should handle errors and continue loop', async () => {
    const supervisor = createMockSupervisor();
    let dequeueCount = 0;
    supervisor.signalQueue.dequeueUnread.mockImplementation(() => {
      dequeueCount++;
      if (dequeueCount === 1) throw new Error('test error');
      supervisor.ctx.abortController.abort();
      return [];
    });

    await mainControllerLoop(supervisor as unknown as Supervisor);

    expect(supervisor.ctx.logger.error).toHaveBeenCalled();
  });

  it('should break on error if aborted', async () => {
    const supervisor = createMockSupervisor();
    supervisor.signalQueue.dequeueUnread.mockImplementation(() => {
      supervisor.ctx.abortController.abort();
      throw new Error('test error');
    });

    await mainControllerLoop(supervisor as unknown as Supervisor);

    // Should not log error because it breaks immediately
    expect(supervisor.ctx.logger.error).not.toHaveBeenCalled();
  });
});
