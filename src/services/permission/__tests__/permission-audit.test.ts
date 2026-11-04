/**
 * Permission audit trail: approvals, refusals and hard refusals all produce one
 * structured record on the session logger, carrying path/entry/task/operation/
 * decision metadata — and NEVER file content, tool output or token values.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockLogger } from '@/__tests__/helpers';
import {
  auditAccessFor,
  operationForTool,
  recordPermissionAudit,
  verdictDetailSuffix,
} from '@/services/permission/permission-audit';

/** The single field object the logger received on its first call. */
function firstRecord(logger: ReturnType<typeof createMockLogger>): Record<string, unknown> {
  const call = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call).toBeDefined();
  return call[0] as Record<string, unknown>;
}

describe('recordPermissionAudit', () => {
  it('records an approval with every required field', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, {
      decision: 'approved',
      operation: 'read',
      resolvedPath: '/home/u/.ssh/id_rsa',
      requestedPath: '~/.ssh/id_rsa',
      matchedEntry: '.ssh',
      matchedSource: 'segment',
      matchedRule: 'sensitive-list',
      taskId: 't-1',
      workerId: 'w-1',
      toolName: 'read_file',
    });

    const record = firstRecord(logger);
    expect(record.audit).toBe('permission');
    expect(record.decision).toBe('approved');
    expect(record.operation).toBe('read');
    expect(record.resolvedPath).toBe('/home/u/.ssh/id_rsa');
    expect(record.requestedPath).toBe('~/.ssh/id_rsa');
    expect(record.matchedEntry).toBe('.ssh');
    expect(record.matchedSource).toBe('segment');
    expect(record.matchedRule).toBe('sensitive-list');
    expect(record.taskId).toBe('t-1');
    expect(record.workerId).toBe('w-1');
    expect(record.toolName).toBe('read_file');
    // Timestamp is written by the audit record itself (pino also stamps time).
    expect(typeof record.ts).toBe('string');
    expect(Number.isNaN(Date.parse(record.ts as string))).toBe(false);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('records a controller refusal, with the source that ended the request', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, {
      decision: 'denied',
      operation: 'read',
      resolvedPath: '/home/u/.ssh/id_rsa',
      matchedRule: 'sensitive-list',
      taskId: 't-1',
      workerId: 'w-1',
      toolName: 'read_file',
      source: 'controller',
    });
    const record = firstRecord(logger);
    expect(record.decision).toBe('denied');
    expect(record.source).toBe('controller');
  });

  it('records a timeout as a denial', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, {
      decision: 'denied',
      operation: 'exec',
      resolvedPath: '/home/u/.ssh/id_rsa',
      taskId: 't-1',
      toolName: 'bash',
      source: 'timeout',
    });
    expect(firstRecord(logger).source).toBe('timeout');
  });

  it('records a hard refusal (sensitive hit under sensitiveMode: deny)', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, {
      decision: 'hard-denied',
      operation: 'write',
      resolvedPath: '/home/u/.ssh/authorized_keys',
      requestedPath: '~/.ssh/authorized_keys',
      matchedEntry: '.ssh',
      matchedSource: 'segment',
      matchedRule: 'sensitive-list',
      taskId: 't-2',
      workerId: 'w-9',
      toolName: 'write_file',
    });
    const record = firstRecord(logger);
    expect(record.decision).toBe('hard-denied');
    expect(record.matchedRule).toBe('sensitive-list');
    expect(record.operation).toBe('write');
  });

  /**
   * #43: the judged DIRECTION is its own field. `operation` stays the tool
   * category, so a bash command that ran as a read is still `exec` — without
   * `access` the two cases below would be indistinguishable in the trail.
   */
  it('records the judged direction next to the tool-category operation (#43)', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, {
      decision: 'approved',
      operation: 'exec',
      access: 'read',
      resolvedPath: '/home/u/.ssh/id_rsa',
      taskId: 't-1',
      toolName: 'bash',
    });
    const record = firstRecord(logger);
    expect(record.operation).toBe('exec');
    expect(record.access).toBe('read');
  });

  it('omits access when the caller has none (older call sites stay lean)', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, { decision: 'approved', operation: 'exec', toolName: 'bash' });
    expect(firstRecord(logger)).not.toHaveProperty('access');
  });

  it('never emits content-like fields: only the metadata allowlist is written', () => {
    const logger = createMockLogger();
    // A caller passing extra fields (by cast) cannot smuggle content into the
    // record — the recorder builds the object from its own field list.
    recordPermissionAudit(logger, {
      decision: 'approved',
      operation: 'read',
      access: 'read',
      resolvedPath: '/home/u/.ssh/id_rsa',
      taskId: 't-1',
      toolName: 'read_file',
      ...({ content: 'PRIVATE-KEY-MATERIAL', toolOutput: 'PRIVATE-KEY-MATERIAL', token: 'sk-live-123' } as object),
    });

    const record = firstRecord(logger);
    expect(Object.keys(record).sort()).toEqual(
      ['access', 'audit', 'decision', 'operation', 'resolvedPath', 'taskId', 'toolName', 'ts'].sort(),
    );
    expect(JSON.stringify(record)).not.toContain('PRIVATE-KEY-MATERIAL');
    expect(JSON.stringify(record)).not.toContain('sk-live-123');
  });

  /**
   * #46: a call let through by the task approval memory is not an approval —
   * it is a REUSE of an earlier one, and the trail has to say which. The
   * granted-by-memory record therefore carries `grantId` (and nothing about
   * what was read).
   */
  it('records granted-by-memory with the grantId that covered the call (#46)', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, {
      decision: 'granted-by-memory',
      grantId: 'grant-1-abc',
      operation: 'read',
      access: 'read',
      resolvedPath: '/home/u/.zshrc',
      matchedRule: 'read-within-home',
      taskId: 't-1',
      workerId: 'w-1',
      toolName: 'read_file',
    });

    const record = firstRecord(logger);
    expect(record).toMatchObject({
      decision: 'granted-by-memory',
      grantId: 'grant-1-abc',
      operation: 'read',
      access: 'read',
      resolvedPath: '/home/u/.zshrc',
      matchedRule: 'read-within-home',
      taskId: 't-1',
      workerId: 'w-1',
      toolName: 'read_file',
    });
  });

  it('omits grantId on every other decision (only a reuse has one to name)', () => {
    const logger = createMockLogger();
    recordPermissionAudit(logger, { decision: 'approved', operation: 'read', toolName: 'read_file' });
    expect(firstRecord(logger)).not.toHaveProperty('grantId');
  });

  it('is a no-op without a logger (auditing never breaks the tool path)', () => {
    expect(() =>
      recordPermissionAudit(undefined, { decision: 'approved', operation: 'read', toolName: 'read_file' }),
    ).not.toThrow();
  });
});

describe('operationForTool', () => {
  it('maps tools to their operation', () => {
    expect(operationForTool('read_file')).toBe('read');
    expect(operationForTool('search_files')).toBe('read');
    expect(operationForTool('search_content')).toBe('read');
    expect(operationForTool('write_file')).toBe('write');
    expect(operationForTool('edit_file')).toBe('write');
    expect(operationForTool('bash')).toBe('exec');
  });
});

describe('auditAccessFor', () => {
  it('passes a judged direction through unchanged', () => {
    expect(auditAccessFor('read')).toBe('read');
    expect(auditAccessFor('write')).toBe('write');
  });

  it('falls back to unknown when the policy never judged a candidate', () => {
    // No path candidate, an unparsable command, an unrecognized tool.
    expect(auditAccessFor(undefined)).toBe('unknown');
    expect(auditAccessFor('unknown')).toBe('unknown');
  });
});

describe('verdictDetailSuffix', () => {
  it('names the hit, the rule and the operation', () => {
    expect(
      verdictDetailSuffix({
        matchedRule: 'sensitive-list',
        matchedEntry: '.ssh',
        matchedSource: 'segment',
        operation: 'read',
      }),
    ).toBe(' [hit: .ssh (segment) ; rule: sensitive-list ; op: read]');
  });

  it('omits unknown parts and is empty without any detail', () => {
    expect(verdictDetailSuffix({ matchedRule: 'outside-all', operation: 'write' })).toBe(
      ' [rule: outside-all ; op: write]',
    );
    expect(verdictDetailSuffix({})).toBe('');
  });
});
