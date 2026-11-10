/**
 * Duplicate permission-request ids must never orphan a waiter (issue #69).
 *
 * The middleware's pending map is keyed by self-generated request ids. If two
 * gated calls in the same run drew the SAME id (generateId collision — same
 * millisecond + same random suffix), the second pending.set used to silently
 * drop the first waiter's resolver: its permission promise then had no entry
 * the controller could resolve, so respond_permission answered "not found"
 * while the worker hung on the first call. The guard regenerates the id until
 * it is unique, mirroring BlockingRequestMap's duplicate-id protection.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/id', () => ({
  generateId: vi.fn(),
}));

import { wrapWithPermissionMiddleware } from '@/services/tools/permission-middleware';
import { generateId } from '@/utils/id';
import type { SignalQueue } from '@/services/signal/signal-queue';

describe('permission request id collision guard (#69)', () => {
  it('regenerates a colliding id so both concurrent waits stay resolvable', async () => {
    const enqueued: any[] = [];
    const queue = { enqueue: vi.fn((sig: any) => enqueued.push(sig)) };
    const tool = { description: 'bash', parameters: {}, execute: vi.fn(async () => 'ran') };

    const result = wrapWithPermissionMiddleware(
      { bash: tool },
      {
        gatedTools: ['bash'],
        decide: () => ({ decision: 'ask' as const }),
        describeCall: (_name: string, args: any) => `bash: ${args.command}`,
      },
      {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'T',
        signalQueue: queue as unknown as SignalQueue,
      },
    );

    // Force the collision: the first call draws 'perm-collide', the second
    // draws the same id first, then regenerates to a unique one.
    vi.mocked(generateId)
      .mockReturnValueOnce('perm-collide')
      .mockReturnValueOnce('perm-collide')
      .mockReturnValueOnce('perm-unique-b');

    const p1 = result.wrappedTools.bash.execute({ command: 'ls one' });
    const p2 = result.wrappedTools.bash.execute({ command: 'ls two' });

    // Distinct ids on the signals — the controller can answer both.
    const ids = enqueued.map((s) => s.payload.requestId);
    expect(ids).toEqual(['perm-collide', 'perm-unique-b']);

    expect(result.resolvePermission('perm-collide', true)).toBe('resolved');
    expect(result.resolvePermission('perm-unique-b', true)).toBe('resolved');

    // Both waits released — neither call hangs at the gate.
    expect(await p1).toBe('ran');
    expect(await p2).toBe('ran');
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });
});
