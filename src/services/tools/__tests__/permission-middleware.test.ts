import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wrapWithPermissionMiddleware } from '@/services/tools/permission-middleware';
import type { SignalQueue } from '@/services/signal/signal-queue';
import { createMockLogger } from '@/__tests__/helpers';

function mockSignalQueue() {
  const enqueued: any[] = [];
  return {
    enqueue: vi.fn((sig: any) => enqueued.push(sig)),
    enqueued,
  };
}

function mockTool(name: string, returnValue: string) {
  return {
    [name]: {
      description: name,
      parameters: {},
      execute: vi.fn(async () => returnValue),
    },
  };
}

/** Verdict that always asks the controller (for tests that need blocking behavior). */
const alwaysBlock = () => ({ decision: 'ask' as const });
/** Verdict that never asks (for passthrough tests). */
const neverBlock = () => ({ decision: 'allow' as const });
/** Verdict that refuses without asking (sensitive-write semantics). */
const policyDeny = () => ({ decision: 'deny' as const, message: '[ERROR] bash: refused by the path permission policy' });
/** Verdict that asks only for dangerous bash keywords. */
const dangerousBashCheck = (toolName: string, args: any) =>
  toolName === 'bash' && /\b(rm\s|sudo\b|chmod\b|chown\b)/.test(args.command ?? '')
    ? { decision: 'ask' as const }
    : { decision: 'allow' as const };

describe('wrapWithPermissionMiddleware', () => {
  let queue: ReturnType<typeof mockSignalQueue>;

  beforeEach(() => {
    queue = mockSignalQueue();
  });

  it('should pass through non-gated tools unchanged', async () => {
    const tools = mockTool('read_file', 'file content');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: (name, args) => `${name}: ${JSON.stringify(args)}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    const output = await result.wrappedTools.read_file.execute({ path: 'a.txt' });
    expect(output).toBe('file content');
  });

  it('should pass through gated tool when the verdict is allow', async () => {
    const tools = mockTool('bash', 'output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: neverBlock,
      describeCall: () => '',
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    const output = await result.wrappedTools.bash.execute({ command: 'ls' });
    expect(output).toBe('output');
    // No signal should be enqueued
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('should block gated tool until permission approved', async () => {
    const tools = mockTool('bash', 'command output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: (name, args) => `Execute: ${args.command}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    const executePromise = result.wrappedTools.bash.execute({ command: 'rm file.txt' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue.mock.calls[0][0].type).toBe('permission_request');
    const requestId = queue.enqueue.mock.calls[0][0].payload.requestId;

    const resolved = result.resolvePermission(requestId, true);
    expect(resolved).toBe('resolved');

    const output = await executePromise;
    expect(output).toBe('command output');
  });

  it('should deny gated tool when permission rejected', async () => {
    const tools = mockTool('bash', 'should not run');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: (name, args) => `Execute: ${args.command}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    const executePromise = result.wrappedTools.bash.execute({ command: 'rm file.txt' });
    const requestId = queue.enqueue.mock.calls[0][0].payload.requestId;

    result.resolvePermission(requestId, false, 'dangerous command');

    const output = await executePromise;
    expect(output).toContain('[ERROR]');
    expect(output).toContain('Permission denied');
    expect(tools.bash.execute).not.toHaveBeenCalled();
  });

  // Regression guard for the ACP deny-continue fix: on the puppet path a
  // controller denial stays a normal tool error — only THAT call is refused
  // and the worker loop keeps going (the next call proceeds as usual).
  it('should keep the loop running after a controller denial: tool error, then the next call proceeds', async () => {
    const tools = mockTool('bash', 'second output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: (name, args) => `Execute: ${args.command}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    // First call: the controller denies → refusal text is the tool RESULT.
    const deniedPromise = result.wrappedTools.bash.execute({ command: 'rm file.txt' });
    const deniedId = queue.enqueue.mock.calls[0][0].payload.requestId;
    result.resolvePermission(deniedId, false, 'dangerous command');
    const deniedOutput = await deniedPromise;
    expect(deniedOutput).toContain('[ERROR]');
    expect(deniedOutput).toContain('Permission denied');
    expect(tools.bash.execute).not.toHaveBeenCalled();

    // Second call (a different command): the worker is still running — the
    // denial did not fail the task; the new call is gated again and runs once
    // approved.
    const retryPromise = result.wrappedTools.bash.execute({ command: 'ls' });
    const retryId = queue.enqueue.mock.calls[1][0].payload.requestId;
    result.resolvePermission(retryId, true);
    expect(await retryPromise).toBe('second output');
    expect(tools.bash.execute).toHaveBeenCalledTimes(1);
  });

  it('should selectively block based on the decide callback', async () => {
    const tools = mockTool('bash', 'ls output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: dangerousBashCheck,
      describeCall: (name, args) => `Shell: ${args.command}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    // Safe command: should pass through immediately
    const safeOutput = await result.wrappedTools.bash.execute({ command: 'ls -la' });
    expect(safeOutput).toBe('ls output');
    expect(queue.enqueue).not.toHaveBeenCalled();

    // Dangerous command: should block
    const dangerPromise = result.wrappedTools.bash.execute({ command: 'rm -rf /tmp/old' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const requestId = queue.enqueue.mock.calls[0][0].payload.requestId;
    result.resolvePermission(requestId, true);
    await dangerPromise;
  });

  it('should return false for unknown requestId', () => {
    const tools = mockTool('bash', 'output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: () => '',
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    expect(result.resolvePermission('nonexistent', true)).toBe('not-found');
  });

  it('should handle multiple concurrent requests', async () => {
    const tools = {
      bash: { description: 'bash', parameters: {}, execute: vi.fn(async () => 'bash output') },
      write_file: { description: 'write_file', parameters: {}, execute: vi.fn(async () => 'written') },
    };
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash', 'write_file'],
      decide: alwaysBlock,
      describeCall: (name) => `${name}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    const p1 = result.wrappedTools.bash.execute({ command: 'ls' });
    const p2 = result.wrappedTools.write_file.execute({ path: 'a.txt' });

    const req1 = queue.enqueue.mock.calls[0][0].payload.requestId;
    const req2 = queue.enqueue.mock.calls[1][0].payload.requestId;
    expect(req1).not.toBe(req2);

    result.resolvePermission(req1, true);
    result.resolvePermission(req2, true);

    const [out1, out2] = await Promise.all([p1, p2]);
    expect(out1).toBe('bash output');
    expect(out2).toBe('written');
  });

  it('should cleanup all pending requests', async () => {
    const tools = mockTool('bash', 'output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: () => '',
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      timeoutMs: 5000,
      signalQueue: queue as unknown as SignalQueue,
    });

    const p = result.wrappedTools.bash.execute({ command: 'ls' });
    result.cleanup();

    const output = await p;
    expect(output).toContain('[ERROR]');
    expect(output).toContain('worker shutting down');
  });

  it('should timeout if no response received', async () => {
    vi.useFakeTimers();
    const tools = mockTool('bash', 'output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: () => '',
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      timeoutMs: 1000,
      signalQueue: queue as unknown as SignalQueue,
    });

    const p = result.wrappedTools.bash.execute({ command: 'ls' });
    vi.advanceTimersByTime(1100);

    const output = await p;
    expect(output).toContain('[ERROR]');
    expect(output).toContain('timed out');
    vi.useRealTimers();
  });

  it('should include correct metadata in permission_request signal', () => {
    const tools = mockTool('bash', 'output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: alwaysBlock,
      describeCall: (name, args) => `Shell: ${args.command}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'My Task',
      workerType: 'puppet',
      emoji: '🧸',
      signalQueue: queue as unknown as SignalQueue,
    });

    result.wrappedTools.bash.execute({ command: 'rm file' });

    const signal = queue.enqueue.mock.calls[0][0];
    expect(signal.source).toBe('worker');
    expect(signal.type).toBe('permission_request');
    expect(signal.payload.workerId).toBe('w1');
    expect(signal.payload.taskId).toBe('t1');
    expect(signal.payload.taskTitle).toBe('My Task');
    expect(signal.payload.toolName).toBe('bash');
    expect(signal.payload.description).toBe('Shell: rm file');
    expect(signal.payload.requestId).toMatch(/^perm-/);
  });

  it('should surface an ask reason in the permission request description', async () => {
    const tools = mockTool('bash', 'output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: () => ({ decision: 'ask' as const, reason: 'output redirection' }),
      describeCall: (name, args) => `Execute shell command: ${args.command}`,
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    const pending = result.wrappedTools.bash.execute({ command: 'echo x > f.txt' });
    const payload = queue.enqueue.mock.calls[0][0].payload;
    expect(payload.description).toContain('output redirection');
    result.resolvePermission(payload.requestId, true);
    await pending;
  });

  it('should refuse a denied call without asking or executing', async () => {
    const tools = mockTool('bash', 'should not run');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      decide: policyDeny,
      describeCall: () => 'Shell',
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    const output = await result.wrappedTools.bash.execute({ command: 'rm -rf ~/.ssh' });

    // The policy message is returned verbatim (it controls disclosure) ...
    expect(output).toBe('[ERROR] bash: refused by the path permission policy');
    // ... no approval is requested ...
    expect(queue.enqueue).not.toHaveBeenCalled();
    // ... and the tool never runs.
    expect(tools.bash.execute).not.toHaveBeenCalled();
  });

  describe('permission audit trail', () => {
    /** Sensitive-read verdict: the shape `decideToolAccess` produces on a hit. */
    const sensitiveAsk = () => ({
      decision: 'ask' as const,
      matchedRule: 'sensitive-list',
      matchedEntry: '.ssh',
      matchedSource: 'segment' as const,
      resolvedPath: '/home/u/.ssh/id_rsa',
      sensitive: true,
      access: 'read' as const,
    });

    function auditCalls(logger: ReturnType<typeof createMockLogger>): Record<string, any>[] {
      return (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0] as Record<string, any>)
        .filter((record) => record && record.audit === 'permission');
    }

    it('records an APPROVED request (with the hit) before running the tool', async () => {
      const logger = createMockLogger();
      const tools = mockTool('read_file', 'PRIVATE-KEY');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['read_file'],
        decide: sensitiveAsk,
        describeCall: (name, args) => `read_file: ${args.path}`,
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      const pending = result.wrappedTools.read_file.execute({ path: '~/.ssh/id_rsa' });
      const payload = queue.enqueue.mock.calls[0][0].payload;
      // The request itself explains the hit, and carries the structured fields.
      expect(payload.description).toContain('hit: .ssh (segment)');
      expect(payload.description).toContain('rule: sensitive-list');
      expect(payload.description).toContain('op: read');
      expect(payload.matchedEntry).toBe('.ssh');
      expect(payload.matchedSource).toBe('segment');
      expect(payload.resolvedPath).toBe('/home/u/.ssh/id_rsa');
      expect(payload.operation).toBe('read');
      expect(payload.sensitive).toBe(true);

      result.resolvePermission(payload.requestId, true);
      await pending;

      const audits = auditCalls(logger);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        audit: 'permission',
        decision: 'approved',
        operation: 'read',
        // #43: the judged direction travels as its own field.
        access: 'read',
        resolvedPath: '/home/u/.ssh/id_rsa',
        requestedPath: '~/.ssh/id_rsa',
        matchedEntry: '.ssh',
        matchedSource: 'segment',
        matchedRule: 'sensitive-list',
        taskId: 't1',
        workerId: 'w1',
        toolName: 'read_file',
      });
      // The audit never quotes the file it protected.
      expect(JSON.stringify(audits[0])).not.toContain('PRIVATE-KEY');
    });

    it('records a DENIED request with its source', async () => {
      const logger = createMockLogger();
      const tools = mockTool('read_file', 'PRIVATE-KEY');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['read_file'],
        decide: sensitiveAsk,
        describeCall: (name, args) => `read_file: ${args.path}`,
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      const pending = result.wrappedTools.read_file.execute({ path: '~/.ssh/id_rsa' });
      const payload = queue.enqueue.mock.calls[0][0].payload;
      result.resolvePermission(payload.requestId, false, 'not needed');
      expect(await pending).toContain('Permission denied');

      const audits = auditCalls(logger);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ decision: 'denied', source: 'controller', taskId: 't1' });
      expect(tools.read_file.execute).not.toHaveBeenCalled();
    });

    it('records a timeout as a denial', async () => {
      vi.useFakeTimers();
      const logger = createMockLogger();
      const tools = mockTool('read_file', 'PRIVATE-KEY');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['read_file'],
        decide: sensitiveAsk,
        describeCall: () => 'read_file',
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
        timeoutMs: 10,
      });

      const pending = result.wrappedTools.read_file.execute({ path: '~/.ssh/id_rsa' });
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toContain('timed out');
      expect(auditCalls(logger)[0]).toMatchObject({ decision: 'denied', source: 'timeout' });
      vi.useRealTimers();
    });

    it('records an APPROVED sensitive WRITE as operation write + access write', async () => {
      const logger = createMockLogger();
      const tools = mockTool('write_file', 'written');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['write_file'],
        // 0.8.4: a sensitive write is an ordinary `ask` now — the shape
        // `decideToolAccess` produces for `write_file` on `~/.ssh/authorized_keys`.
        decide: () => ({
          decision: 'ask' as const,
          matchedRule: 'sensitive-list',
          matchedEntry: '.ssh',
          matchedSource: 'segment' as const,
          resolvedPath: '/home/u/.ssh/authorized_keys',
          sensitive: true,
          access: 'write' as const,
        }),
        describeCall: (name, args) => `write_file: ${args.path}`,
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      const pending = result.wrappedTools.write_file.execute({
        path: '~/.ssh/authorized_keys',
        content: 'SECRET-CONTENT',
      });
      const payload = queue.enqueue.mock.calls[0][0].payload;
      // The approval request names the entry and the direction.
      expect(payload.description).toContain('hit: .ssh (segment)');
      expect(payload.description).toContain('rule: sensitive-list');
      expect(payload.description).toContain('op: write');
      expect(payload.matchedEntry).toBe('.ssh');
      expect(payload.access).toBe('write');
      expect(payload.operation).toBe('write');

      result.resolvePermission(payload.requestId, true);
      expect(await pending).toBe('written');

      const audits = auditCalls(logger);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        decision: 'approved',
        // `operation` stays the tool category, `access` is the direction.
        operation: 'write',
        access: 'write',
        resolvedPath: '/home/u/.ssh/authorized_keys',
        requestedPath: '~/.ssh/authorized_keys',
        matchedEntry: '.ssh',
        matchedSource: 'segment',
        matchedRule: 'sensitive-list',
        taskId: 't1',
        workerId: 'w1',
        toolName: 'write_file',
      });
      expect(JSON.stringify(audits[0])).not.toContain('SECRET-CONTENT');
    });

    it('records a HARD DENIAL without asking (sensitiveMode: deny)', async () => {
      const logger = createMockLogger();
      const tools = mockTool('write_file', 'should not run');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['write_file'],
        decide: () => ({
          decision: 'deny' as const,
          message: '[ERROR] write_file: refused',
          matchedRule: 'sensitive-list',
          matchedEntry: '.ssh',
          matchedSource: 'segment' as const,
          resolvedPath: '/home/u/.ssh/authorized_keys',
          sensitive: true,
          access: 'write' as const,
        }),
        describeCall: () => 'write_file',
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      const output = await result.wrappedTools.write_file.execute({
        path: '~/.ssh/authorized_keys',
        content: 'SECRET-CONTENT',
      });
      expect(output).toBe('[ERROR] write_file: refused');
      expect(queue.enqueue).not.toHaveBeenCalled();

      const audits = auditCalls(logger);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        decision: 'hard-denied',
        operation: 'write',
        access: 'write',
        matchedEntry: '.ssh',
        matchedRule: 'sensitive-list',
        resolvedPath: '/home/u/.ssh/authorized_keys',
        taskId: 't1',
        workerId: 'w1',
      });
      // No file content ever reaches the audit record.
      expect(JSON.stringify(audits[0])).not.toContain('SECRET-CONTENT');
    });

    /**
     * #42 + #43 together: a dangerous bash command that hits the sensitive list
     * keeps BOTH the hit and the danger in the approval description, and the
     * audit says `exec` (tool category) with its own `access` direction.
     */
    it('keeps the sensitive hit of a dangerous bash ask, and audits exec + access', async () => {
      const logger = createMockLogger();
      const tools = mockTool('bash', 'ran');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['bash'],
        // The shape `evaluateBashAccess` produces for `sudo cat ~/.ssh/id_rsa`.
        decide: () => ({
          decision: 'ask' as const,
          matchedRule: 'dangerous-bash',
          matchedEntry: '.ssh',
          matchedSource: 'segment' as const,
          resolvedPath: '/home/u/.ssh/id_rsa',
          sensitive: true,
          access: 'unknown' as const,
        }),
        describeCall: (_name, args) => `Execute shell command: ${args.command}`,
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      const pending = result.wrappedTools.bash.execute({ command: 'sudo cat ~/.ssh/id_rsa' });
      const payload = queue.enqueue.mock.calls[0][0].payload;

      // The approval names the danger AND the entry it hit.
      expect(payload.description).toContain('rule: dangerous-bash');
      expect(payload.description).toContain('hit: .ssh (segment)');
      expect(payload.matchedRule).toBe('dangerous-bash');
      expect(payload.matchedEntry).toBe('.ssh');

      result.resolvePermission(payload.requestId, false, 'no');
      await pending;

      const audits = auditCalls(logger);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        decision: 'denied',
        // Tool category stays exec; the direction is its own field.
        operation: 'exec',
        access: 'unknown',
        matchedRule: 'dangerous-bash',
        matchedEntry: '.ssh',
        resolvedPath: '/home/u/.ssh/id_rsa',
        toolName: 'bash',
      });
    });

    it('records access: unknown when the verdict judged no direction', async () => {
      const logger = createMockLogger();
      const tools = mockTool('bash', 'ran');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['bash'],
        decide: () => ({ decision: 'ask' as const, matchedRule: 'dynamic-shell', reason: 'could not parse' }),
        describeCall: () => 'Execute shell command',
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      const pending = result.wrappedTools.bash.execute({ command: 'echo $((' });
      const payload = queue.enqueue.mock.calls[0][0].payload;
      result.resolvePermission(payload.requestId, false, 'no');
      await pending;

      const audit = auditCalls(logger)[0];
      expect(audit).toMatchObject({ operation: 'exec', access: 'unknown', decision: 'denied' });
    });

    /**
     * 0.8.4: the allow fast path runs the tool without asking, and it now
     * writes one `allowed` record first — otherwise the trail reads as if the
     * gate never saw the calls it allowed.
     */
    it('records an ALLOWED call (no request, tool still runs)', async () => {
      const logger = createMockLogger();
      const tools = mockTool('bash', 'ran');
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['bash'],
        decide: () => ({ decision: 'allow' as const, matchedRule: 'no-path', access: 'read' as const }),
        describeCall: () => 'Execute shell command',
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      await expect(result.wrappedTools.bash.execute({ command: 'ls -la' })).resolves.toBe('ran');
      // Nothing was asked of the controller…
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(tools.bash.execute).toHaveBeenCalledTimes(1);
      // …and exactly one decision was recorded.
      const audits = auditCalls(logger);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        decision: 'allowed',
        operation: 'exec',
        access: 'read',
        matchedRule: 'no-path',
        taskId: 't1',
        workerId: 'w1',
        toolName: 'bash',
      });
      expect(typeof audits[0].ts).toBe('string');
      // The stance of this module holds on the allow path too: the decision is
      // observable, the CONTENT (here: the command line) is not recorded.
      expect(JSON.stringify(audits[0])).not.toContain('ls -la');
      expect(audits[0]).not.toHaveProperty('requestedPath');
    });

    it('records one ALLOWED decision per call, without touching the ask records', async () => {
      const logger = createMockLogger();
      const tools = { ...mockTool('bash', 'ran'), ...mockTool('read_file', 'content') };
      const result = wrapWithPermissionMiddleware(tools, {
        gatedTools: ['bash', 'read_file'],
        decide: (toolName) =>
          toolName === 'bash'
            ? { decision: 'allow' as const, matchedRule: 'no-path', access: 'read' as const }
            : sensitiveAsk(),
        describeCall: () => 'call',
      }, {
        workerId: 'w1',
        taskId: 't1',
        taskTitle: 'Test',
        signalQueue: queue as unknown as SignalQueue,
        logger,
      });

      await result.wrappedTools.bash.execute({ command: 'ls' });
      const pending = result.wrappedTools.read_file.execute({ path: '/home/u/.ssh/id_rsa' });
      const payload = queue.enqueue.mock.calls[0][0].payload;
      result.resolvePermission(payload.requestId, false, 'no');
      await pending;

      expect(auditCalls(logger).map((record) => record.decision)).toEqual(['allowed', 'denied']);
    });
  });
});
