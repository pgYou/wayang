/**
 * PermissionTransport unit tests — the shared spine of the three permission
 * gates. The settle semantics are the #69 contract: five terminal states,
 * canonical timeout / abort reasons, collision-safe request ids, one
 * reusable-grant-keys rule and one deny-text template set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/id', () => ({
  generateId: vi.fn(),
}));

import { generateId } from '@/utils/id';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  PERMISSION_ABORT_REASON,
  PERMISSION_TIMEOUT_REASON,
  PermissionTransport,
  denialSourceOf,
  permissionRefusalText,
  permissionStatusFromOutcome,
  reusableGrantKeys,
} from '@/services/permission/permission-transport';

describe('PermissionTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(generateId).mockReset();
  });

  it('a resolve settles the parked wait with the answer and reports resolved', async () => {
    const transport = new PermissionTransport();
    const pending = transport.wait('perm-1');

    expect(transport.resolve('perm-1', true)).toBe('resolved');
    await expect(pending).resolves.toEqual({ approved: true });
  });

  it('a duplicate resolve reports already-resolved and settles nothing', async () => {
    const transport = new PermissionTransport();
    const pending = transport.wait('perm-1');
    transport.resolve('perm-1', false, 'not needed');

    expect(transport.resolve('perm-1', true)).toBe('already-resolved');
    await expect(pending).resolves.toEqual({ approved: false, reason: 'not needed' });
  });

  it('a resolve for an id that was never parked reports not-found', () => {
    const transport = new PermissionTransport();
    expect(transport.resolve('perm-never-issued', true)).toBe('not-found');
  });

  it('a wait that expires settles with the canonical timeout reason and reports expired', async () => {
    const transport = new PermissionTransport();
    const pending = transport.wait('perm-1');
    const asserted = expect(pending).resolves.toEqual({ approved: false, reason: 'timeout' });

    vi.advanceTimersByTime(DEFAULT_PERMISSION_TIMEOUT_MS + 1);
    await asserted;
    expect(transport.resolve('perm-1', true)).toBe('expired');
  });

  it('the default bound is the 300s shared constant', async () => {
    const transport = new PermissionTransport();

    // One millisecond before the bound the request is still parked, so a
    // manual resolve wins with its own answer.
    const beforeBound = transport.wait('perm-before');
    vi.advanceTimersByTime(DEFAULT_PERMISSION_TIMEOUT_MS - 1);
    expect(transport.resolve('perm-before', true)).toBe('resolved');
    await expect(beforeBound).resolves.toEqual({ approved: true });

    // At the bound itself the canonical timeout settle fires.
    const atBound = transport.wait('perm-at-bound');
    const asserted = expect(atBound).resolves.toEqual({ approved: false, reason: PERMISSION_TIMEOUT_REASON });
    vi.advanceTimersByTime(DEFAULT_PERMISSION_TIMEOUT_MS);
    await asserted;
  });

  it('a caller-supplied bound overrides the default', async () => {
    const transport = new PermissionTransport();
    const pending = transport.wait('perm-1', 50);
    const asserted = expect(pending).resolves.toEqual({ approved: false, reason: 'timeout' });

    vi.advanceTimersByTime(51);
    await asserted;
  });

  it('cleanup settles every parked wait as aborted and reports worker-closed', async () => {
    const transport = new PermissionTransport();
    const first = transport.wait('perm-1');
    const second = transport.wait('perm-2');

    transport.cleanup();
    await expect(first).resolves.toEqual({ approved: false, reason: PERMISSION_ABORT_REASON });
    await expect(second).resolves.toEqual({ approved: false, reason: PERMISSION_ABORT_REASON });
    expect(transport.resolve('perm-1', true)).toBe('worker-closed');
    expect(transport.size).toBe(0);
  });

  it('newRequestId regenerates a colliding id so both waits stay resolvable', async () => {
    const mocked = vi.mocked(generateId);
    mocked.mockReturnValueOnce('perm-collide').mockReturnValueOnce('perm-collide').mockReturnValueOnce('perm-unique');

    const transport = new PermissionTransport();
    const parked = transport.wait('perm-collide'); // parked first — the collision target

    expect(transport.newRequestId()).toBe('perm-unique');
    // The caller parks the freshly drawn id before a responder can answer it.
    const fresh = transport.wait('perm-unique');
    expect(transport.resolve('perm-collide', true)).toBe('resolved');
    expect(transport.resolve('perm-unique', true)).toBe('resolved');
    await expect(parked).resolves.toEqual({ approved: true });
    await expect(fresh).resolves.toEqual({ approved: true });
  });
});

describe('permissionStatusFromOutcome (#69 five states)', () => {
  it.each([
    ['responded', 'already-resolved'],
    ['timed-out', 'expired'],
    ['cleaned', 'worker-closed'],
    [undefined, 'not-found'],
  ])('%s → %s', (outcome, status) => {
    expect(permissionStatusFromOutcome(outcome as Parameters<typeof permissionStatusFromOutcome>[0])).toBe(status);
  });
});

describe('reusableGrantKeys (issue #46 rule)', () => {
  it('an ask naming read paths opens one read grant per path', () => {
    expect(
      reusableGrantKeys({ decision: 'ask', access: 'read', askPaths: ['/a/b', '/c/d'] }),
    ).toEqual(['read:/a/b', 'read:/c/d']);
  });

  it('deduplicates paths that share a canonical spelling', () => {
    expect(
      reusableGrantKeys({ decision: 'ask', access: 'read', askPaths: ['/a/b', '/a/b'] }),
    ).toEqual(['read:/a/b']);
  });

  it.each([
    ['allow decision never reaches the memory', { decision: 'allow', access: 'read', askPaths: ['/a'] }],
    ['a write is never remembered', { decision: 'ask', access: 'write', askPaths: ['/a'] }],
    ['a sensitive hit always asks again', { decision: 'ask', access: 'read', sensitive: true, askPaths: ['/a'] }],
    ['no asking path means no grant key', { decision: 'ask', access: 'read' }],
  ])('%s → []', (_label, verdict) => {
    expect(reusableGrantKeys(verdict as Parameters<typeof reusableGrantKeys>[0])).toEqual([]);
  });
});

describe('denialSourceOf', () => {
  it.each([
    [{ approved: false, reason: 'timeout' }, 'timeout'],
    [{ approved: false, reason: 'Worker aborted' }, 'aborted'],
    [{ approved: false, reason: 'too dangerous' }, 'controller'],
    [{ approved: false }, 'controller'],
  ])('%j → %s', (answer, source) => {
    expect(denialSourceOf(answer as { approved: boolean; reason?: string })).toBe(source);
  });
});

describe('permissionRefusalText (puppet deny templates)', () => {
  it('timeout names the tool', () => {
    expect(permissionRefusalText('bash', { approved: false, reason: 'timeout' })).toBe(
      '[ERROR] Permission request timed out for bash',
    );
  });

  it('abort explains the shutdown', () => {
    expect(permissionRefusalText('bash', { approved: false, reason: 'Worker aborted' })).toBe(
      '[ERROR] Permission request cancelled: worker shutting down',
    );
  });

  it('a controller denial carries its reason, with the historic fallback', () => {
    expect(permissionRefusalText('bash', { approved: false, reason: 'nope' })).toBe(
      '[ERROR] Permission denied for bash: nope',
    );
    expect(permissionRefusalText('read_file', { approved: false })).toBe(
      '[ERROR] Permission denied for read_file: operation not approved by controller',
    );
  });
});

describe('the shared timeout constant', () => {
  it('stays the historic 300 seconds', () => {
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBe(300_000);
  });
});
