/**
 * The task-scoped approval store itself (issue #46).
 *
 * These cases pin the SHAPE and the lifetime rules only — `taskId → key →
 * grant`, keys made of `direction:path`, cleared per task. What may (and may
 * not) become a grant is decided in the middleware and covered by
 * `src/services/tools/__tests__/permission-approval-memory.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApprovalMemory,
  approvalKey,
  sharedApprovalMemory,
} from '@/services/permission/approval-memory';

describe('approvalKey', () => {
  it('is direction + canonical path', () => {
    expect(approvalKey('read', '/home/u/.zshrc')).toBe('read:/home/u/.zshrc');
  });

  it('separates two paths and keeps the direction inside the key', () => {
    expect(approvalKey('read', '/a')).not.toBe(approvalKey('read', '/b'));
    expect(approvalKey('read', '/a').startsWith('read:')).toBe(true);
  });
});

describe('ApprovalMemory', () => {
  let memory: ApprovalMemory;

  beforeEach(() => {
    memory = new ApprovalMemory();
  });

  it('remembers a grant for one task and path', () => {
    memory.remember('t1', approvalKey('read', '/a'), { requestId: 'perm-1' });

    expect(memory.has('t1', 'read:/a')).toBe(true);
    expect(memory.size()).toBe(1);
    const grant = memory.get('t1', 'read:/a');
    expect(grant).toMatchObject({
      taskId: 't1',
      key: 'read:/a',
      // The path is derived from the key when the caller does not spell it.
      path: '/a',
      access: 'read',
      requestId: 'perm-1',
    });
    expect(grant?.grantId).toMatch(/^grant-/);
    expect(grant?.createdAt).toBeGreaterThan(0);
  });

  it('never leaks a grant into another task', () => {
    memory.remember('t1', 'read:/a');

    expect(memory.has('t2', 'read:/a')).toBe(false);
    expect(memory.get('t2', 'read:/a')).toBeUndefined();
  });

  it('is idempotent — a second approval keeps the original grantId', () => {
    const first = memory.remember('t1', 'read:/a', { requestId: 'perm-1' });
    const second = memory.remember('t1', 'read:/a', { requestId: 'perm-2' });

    expect(second.grantId).toBe(first.grantId);
    expect(second.requestId).toBe('perm-1');
    expect(memory.size()).toBe(1);
  });

  it('clearTask drops one task and reports how many grants went with it', () => {
    memory.remember('t1', 'read:/a');
    memory.remember('t1', 'read:/b');
    memory.remember('t2', 'read:/a');

    expect(memory.clearTask('t1')).toBe(2);
    expect(memory.has('t1', 'read:/a')).toBe(false);
    expect(memory.has('t1', 'read:/b')).toBe(false);
    // Other tasks keep theirs.
    expect(memory.has('t2', 'read:/a')).toBe(true);
    expect(memory.size()).toBe(1);
  });

  it('clearing an unknown task is a no-op', () => {
    expect(memory.clearTask('nope')).toBe(0);
  });

  it('size counts every grant across tasks', () => {
    memory.remember('t1', 'read:/a');
    memory.remember('t1', 'read:/b');
    memory.remember('t2', 'read:/c');

    expect(memory.size()).toBe(3);
    memory.clear();
    expect(memory.size()).toBe(0);
  });

  it('stores metadata only — no content, no tool arguments', () => {
    memory.remember('t1', 'read:/a', { requestId: 'perm-1' });

    const serialized = JSON.stringify(memory.get('t1', 'read:/a'));
    expect(serialized).not.toContain('PRIVATE-KEY');
    expect(serialized).not.toContain('content');
  });
});

describe('sharedApprovalMemory', () => {
  it('is one process-wide store (the middleware is rebuilt per worker run)', () => {
    sharedApprovalMemory.clear();
    sharedApprovalMemory.remember('t1', 'read:/a');

    // A second import site sees the same instance.
    expect(sharedApprovalMemory.has('t1', 'read:/a')).toBe(true);
    sharedApprovalMemory.clearTask('t1');
    expect(sharedApprovalMemory.size()).toBe(0);
  });
});
