import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wrapWithPermissionMiddleware } from '@/services/tools/permission-middleware';
import type { SignalQueue } from '@/services/signal/signal-queue';

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

/** Config that always requires permission (for tests that need blocking behavior). */
const alwaysBlock = () => true;
/** Config that never requires permission (for passthrough tests). */
const neverBlock = () => false;
/** Config that checks for dangerous bash keywords. */
const dangerousBashCheck = (toolName: string, args: any) => {
  if (toolName === 'bash') return /\b(rm\s|sudo\b|chmod\b|chown\b)/.test(args.command ?? '');
  return false;
};

describe('wrapWithPermissionMiddleware', () => {
  let queue: ReturnType<typeof mockSignalQueue>;

  beforeEach(() => {
    queue = mockSignalQueue();
  });

  it('should pass through non-gated tools unchanged', async () => {
    const tools = mockTool('read_file', 'file content');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      needsPermission: alwaysBlock,
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

  it('should pass through gated tool when needsPermission returns false', async () => {
    const tools = mockTool('bash', 'output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      needsPermission: neverBlock,
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
      needsPermission: alwaysBlock,
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
    expect(resolved).toBe(true);

    const output = await executePromise;
    expect(output).toBe('command output');
  });

  it('should deny gated tool when permission rejected', async () => {
    const tools = mockTool('bash', 'should not run');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      needsPermission: alwaysBlock,
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

  it('should selectively block based on needsPermission', async () => {
    const tools = mockTool('bash', 'ls output');
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash'],
      needsPermission: dangerousBashCheck,
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
      needsPermission: alwaysBlock,
      describeCall: () => '',
    }, {
      workerId: 'w1',
      taskId: 't1',
      taskTitle: 'Test',
      signalQueue: queue as unknown as SignalQueue,
    });

    expect(result.resolvePermission('nonexistent', true)).toBe(false);
  });

  it('should handle multiple concurrent requests', async () => {
    const tools = {
      bash: { description: 'bash', parameters: {}, execute: vi.fn(async () => 'bash output') },
      write_file: { description: 'write_file', parameters: {}, execute: vi.fn(async () => 'written') },
    };
    const result = wrapWithPermissionMiddleware(tools, {
      gatedTools: ['bash', 'write_file'],
      needsPermission: alwaysBlock,
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
      needsPermission: alwaysBlock,
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
      needsPermission: alwaysBlock,
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
      needsPermission: alwaysBlock,
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
});
