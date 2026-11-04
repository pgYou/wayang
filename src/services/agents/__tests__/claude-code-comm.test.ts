import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeCodeWorker } from '@/services/agents/claude-code-worker';
import type { WorkerConfig, TaskDetail, PermissionConfig } from '@/types/index';
import { SkillRegistry } from '@/services/skills/registry';
import { SignalQueue } from '@/services/signal/signal-queue';
import { createMockCtx } from '@/__tests__/helpers';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ type: 'instance' })),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

const skills = new SkillRegistry([]);
const config: WorkerConfig = { type: 'claude-code', description: 'Test worker' };

const makeTask = (): TaskDetail & { workerId: string } => ({
  id: `t-cc-${Math.random().toString(36).slice(2, 6)}`,
  title: 'Test',
  description: 'Do the thing',
  priority: 'normal',
  status: 'pending',
  createdAt: Date.now(),
  workerId: 'cw-test',
});

function assistant(text: string) {
  return { type: 'assistant' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }], usage: { input_tokens: 1, output_tokens: 1 } } };
}
function successResult(text: string) {
  return { type: 'result' as const, subtype: 'success' as const, result: text, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, num_turns: 1, duration_ms: 1, errors: [] as string[] };
}

/** SDK query mock: yields messages, then parks on a gate we control. */
function gatedStream(messages: unknown[], gateAfter: 'before-result' | 'never') {
  const interrupt = vi.fn(async () => {});
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  const resultMessages = gateAfter === 'before-result'
    ? [...messages, successResult('done')]
    : [...messages];
  const stream = {
    interrupt,
    async *[Symbol.asyncIterator]() {
      for (const m of resultMessages) yield m as never;
      if (gateAfter === 'never') await gate;
    },
  };
  return { stream, interrupt, release: () => releaseGate?.() };
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
}

let tempDir: string;

describe('ClaudeCodeWorker controller messaging', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(`${tmpdir()}/wayang-cc-`);
    mockQuery.mockReset();
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  function makeWorker(cfg: WorkerConfig = config): ClaudeCodeWorker {
    const ctx = createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir });
    return new ClaudeCodeWorker(cfg, tempDir, tempDir, ctx, skills);
  }

  it('uses permissionMode default (gate live) only when signal context is wired', async () => {
    // Without signal context: bypass — canUseTool would never fire anyway.
    const bare = makeWorker();
    const { stream: s1, release: r1 } = gatedStream([assistant('working')], 'before-result');
    let opts1: Record<string, any> | null = null;
    mockQuery.mockImplementationOnce((({ options }: never) => { opts1 = options; return s1; }) as never);
    const run1 = bare.run(makeTask(), {});
    await settle();
    expect(opts1!.permissionMode).toBe('bypassPermissions');
    expect(opts1!.canUseTool).toBeUndefined();
    r1();
    await run1;

    // With signal context: default — the dangerous-command gate is live
    // (bypassPermissions makes the CLI skip canUseTool entirely; verified
    // against the real CLI via scripts/poc-interrupt-permission.mjs).
    const gated = makeWorker();
    const ctx = createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir });
    gated.setSignalContext({ signalQueue: new SignalQueue(ctx), workerId: 'cw-test', taskId: 't-1', taskTitle: 'Test' });
    const { stream: s2, release: r2 } = gatedStream([assistant('working')], 'before-result');
    let opts2: Record<string, any> | null = null;
    mockQuery.mockImplementationOnce((({ options }: never) => { opts2 = options; return s2; }) as never);
    const run2 = gated.run(makeTask(), {});
    await settle();
    expect(opts2!.permissionMode).toBe('default');
    expect(typeof opts2!.canUseTool).toBe('function');
    r2();
    await run2;
  });

  it('never interrupts the SDK when a message arrives mid-turn (boundary delivery)', async () => {
    // Regression for the interrupt-delivery bug: a chat_worker message sent
    // while claude was mid-tool_use called stream.interrupt(), which aborted
    // the turn with an orphaned tool_use and failed the task with
    // "[ede_diagnostic] result_type=user ... stop_reason=tool_use".
    // Messages must now be delivered ONLY through the prompt iterator — the
    // CLI queues pulled prompts and processes them between turns.
    const worker = makeWorker();
    const interrupt = vi.fn(async () => {});
    let pendingPull: Promise<IteratorResult<any>> | null = null;
    let secondPull: Promise<IteratorResult<any>> | null = null;

    mockQuery.mockImplementationOnce(((args: any) => {
      const promptIter = (args.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
      async function* sdkStream() {
        await promptIter.next();                     // initial task prompt
        pendingPull = promptIter.next();             // CLI parks on the next input (eager pull)
        yield assistant('running a long tool call'); // mid-turn: tool_use in flight
        // Message handed over mid-turn — safe: the CLI queues it internally
        // and gives it its own turn AFTER the current one finishes.
        const handed = await (pendingPull as Promise<IteratorResult<any>>);
        expect(handed.done).toBe(false);
        expect(handed.value.message.content).toBe('[Controller message] change of plans');
        secondPull = promptIter.next();              // CLI re-parks after the hand-over
        yield assistant('turn continues after the tool call');
        yield successResult('stage one done');       // result for the initial prompt
        yield successResult('handled controller message'); // result for the message's turn
      }
      return Object.assign(sdkStream(), { interrupt });
    }) as never);

    const runP = worker.run(makeTask(), {});
    await settle();

    // Mid-tool_use: the message is accepted, the run keeps going, and the SDK
    // is never interrupted.
    expect(worker.acceptMessage('change of plans')).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();

    const result = await runP;
    // The follow-up turn was actually processed: the LAST result is the
    // result of record, not the first one.
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('handled controller message');
    // The message was handed over exactly once — the re-pull must have been
    // closed by the result wake (done), not re-delivered.
    const second = await (secondPull as unknown as Promise<IteratorResult<any>>);
    expect(second.done).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('accepts a message while a permission is pending; the permission settles independently', async () => {
    const worker = makeWorker();
    const ctx = createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir });
    const signalQueue = new SignalQueue(ctx);
    worker.setSignalContext({ signalQueue, workerId: 'cw-test', taskId: 't-1', taskTitle: 'Test' });

    const { stream, interrupt, release } = gatedStream([assistant('working')], 'never');
    mockQuery.mockImplementationOnce((({ options }: never) => {
      // fire the captured canUseTool so a permission hangs pending
      Promise.resolve().then(() => (options as any).canUseTool('Bash', { command: 'sudo rm -rf /tmp/x' }));
      return stream;
    }) as never);
    const runP = worker.run(makeTask(), {});
    await settle();

    // A dangerous Bash call is parked in permissionHandler — a message
    // arriving now is accepted (queued for the prompt iterator) and does
    // not disturb the permission flow.
    expect(worker.acceptMessage('hold on')).toBe(true);

    const signals = signalQueue.query({ type: 'permission_request' });
    expect(signals).toHaveLength(1);
    const requestId = (signals[0].payload as any).requestId;

    expect(worker.permissionHandler.resolvePermission(requestId, true)).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();

    worker.abort();
    release();
    await runP;
  });

  it('keeps a message accepted during a pending permission when the permission TIMES OUT', async () => {
    vi.useFakeTimers();
    try {
      const worker = makeWorker();
      const ctx = createMockCtx({ sessionDir: tempDir, workspaceDir: tempDir });
      const signalQueue = new SignalQueue(ctx);
      worker.setSignalContext({ signalQueue, workerId: 'cw-test', taskId: 't-1', taskTitle: 'Test' });

      const { stream, release } = gatedStream([assistant('working')], 'never');
      mockQuery.mockImplementationOnce((({ options }: never) => {
        Promise.resolve().then(() => (options as any).canUseTool('Bash', { command: 'sudo rm -rf /tmp/x' }));
        return stream;
      }) as never);
      const runP = worker.run(makeTask(), {});
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(worker.acceptMessage('held back by permission')).toBe(true);

      // 5-minute permission timeout → deny. The accepted message survives
      // (still queued for the prompt iterator).
      vi.advanceTimersByTime(300_000 + 10);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(worker.pendingMessages()).toEqual(['held back by permission']);

      worker.abort();
      release();
      await vi.waitUntil(() => runP.then(() => true), { timeout: 1000 }).catch(() => true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects messages once the run\'s input has closed (result received)', async () => {
    const worker = makeWorker();
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    mockQuery.mockImplementationOnce(((args: any) => {
      const promptIter = (args.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
      // Models the real CLI: input is pulled eagerly; the stream stays open
      // after a result (e.g. a follow-up turn is still running).
      async function* sdkStream() {
        await promptIter.next();
        const parked = promptIter.next();
        yield assistant('working');
        yield successResult('done');
        await gate;
        await parked;
      }
      return sdkStream();
    }) as never);

    const runP = worker.run(makeTask(), {});
    await settle();

    // Result processed → prompt iterator returned done → input closed. The
    // stream is still open (worker "running"), but no input can be delivered
    // anymore: explicit failure, no fake queue.
    expect(worker.acceptMessage('arrived too late')).toBe(false);
    expect(worker.pendingMessages()).toEqual([]);

    releaseGate!();
    const result = await runP;
    expect(result.status).toBe('completed');
  });

  it('rejects messages after abort', async () => {
    const worker = makeWorker();
    const { stream, release } = gatedStream([assistant('working')], 'never');
    mockQuery.mockReturnValueOnce(stream as never);
    const runP = worker.run(makeTask(), {});
    await settle();

    worker.abort();
    expect(worker.acceptMessage('too late')).toBe(false);

    release();
    await runP;
  });

  it('accepts messages again between stages (folded into the next prompt)', async () => {
    const worker = makeWorker();
    const { stream } = gatedStream([assistant('working')], 'before-result');
    mockQuery.mockReturnValueOnce(stream as never);
    const runP = worker.run(makeTask(), {});
    const result = await runP;
    expect(result.status).toBe('completed');

    // Idle (multi-stage) worker: accept and fold into the next stage's prompt.
    expect(worker.acceptMessage('for the next stage')).toBe(true);

    let capturedPrompt: AsyncIterable<any> | null = null;
    const { stream: s2, release: r2 } = gatedStream([assistant('working')], 'before-result');
    mockQuery.mockImplementationOnce((({ prompt }: never) => {
      capturedPrompt = prompt;
      return s2;
    }) as never);
    const run2 = worker.run(makeTask(), {});
    const iterator = capturedPrompt![Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.message.content).toContain('[Controller message] for the next stage');

    r2();
    await run2;
  });

  it('folds idle-period messages into the next stage\'s initial prompt', async () => {
    const worker = makeWorker();
    worker.acceptMessage('from idle period');

    let capturedPrompt: AsyncIterable<any> | null = null;
    const { stream, release } = gatedStream([assistant('working')], 'before-result');
    mockQuery.mockImplementationOnce((({ prompt }: never) => {
      capturedPrompt = prompt;
      return stream;
    }) as never);
    const runP = worker.run(makeTask(), {});

    const iterator = capturedPrompt![Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.message.content).toContain('Do the thing');
    expect(first.value.message.content).toContain('[Controller message] from idle period');

    release();
    await runP;
  });

  it('passes a raised stream-close timeout so a blocking ask_controller survives', async () => {
    const worker = makeWorker();
    worker.setInquirySupport(async (q) => `[Controller] ${q}`);
    const { stream, release } = gatedStream([assistant('working')], 'before-result');
    let capturedOptions: Record<string, any> | null = null;
    mockQuery.mockImplementationOnce((({ options }: never) => {
      capturedOptions = options;
      return stream;
    }) as never);
    const runP = worker.run(makeTask(), {});

    await settle();
    // The override is present AND the child env is a spread of process.env —
    // the SDK REPLACES the env with this object, so a bare override would
    // strip PATH/HOME from the claude child (review: blocking finding).
    expect(capturedOptions!.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('360000');
    expect(capturedOptions!.env.PATH).toBe(process.env.PATH);
    expect(capturedOptions!.mcpServers.wayang).toBeDefined();

    release();
    await runP;
  });

  it('writes an ask_controller Q&A audit entry into the worker conversation', async () => {
    const worker = makeWorker();
    worker.setInquirySupport(async (q) => `[Controller] answer-to:${q}`);
    const { stream, release } = gatedStream([assistant('working')], 'before-result');
    mockQuery.mockReturnValueOnce(stream as never);
    const runP = worker.run(makeTask(), {});

    await settle();
    // Drive the MCP tool handler directly — the mock SDK never calls it.
    const mcpServer = (mockQuery.mock.calls[0]?.[0] as any)?.options?.mcpServers?.wayang;
    expect(mcpServer).toBeDefined();
    release();
    await runP;

    // The handler is built at run(); invoke it for the audit assertion.
    const tool = (worker as any).buildAskControllerMcpTool.call(worker);
    const out = await tool.handler({ question: 'which db?' });
    expect(out.content[0].text).toBe('[Controller] answer-to:which db?');
    const audit = worker.getConversation().find((e: any) => e.subtype === 'inquiry');
    expect(audit).toBeDefined();
    expect((audit as any).content).toContain('ask_controller: which db?');
    expect((audit as any).content).toContain('controller: [Controller] answer-to:which db?');
  });
});

/**
 * canUseTool routes through the SAME shared permission policy as puppet
 * workers (`decideToolAccess`): a sensitive hit — READ or WRITE — asks for
 * approval (naming the matched entry and the direction), a refusal only happens
 * under `sensitiveMode: 'deny'`, a path inside the task workspace runs
 * immediately, and a path inside home but outside the workspace asks the
 * controller. Requests and audits use the same fields as the puppet middleware.
 */
describe('ClaudeCodeWorker permission policy (canUseTool)', () => {
  let userHome: string;
  let workspace: string;

  beforeEach(() => {
    userHome = mkdtempSync(join(tmpdir(), 'wayang-cc-perm-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'wayang-cc-perm-ws-'));
    mockQuery.mockReset();
  });
  afterEach(() => {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * Instantiate a worker wired with an explicit access scope + signal queue.
   * `permission` is the user-config section the engine would inject.
   */
  function makeWiredWorker(permission?: PermissionConfig) {
    const ctx = createMockCtx({ sessionDir: userHome, workspaceDir: workspace });
    const worker = new ClaudeCodeWorker(config, userHome, workspace, ctx, skills);
    const signalQueue = new SignalQueue(createMockCtx({ sessionDir: userHome, workspaceDir: workspace }));
    worker.setSignalContext({
      signalQueue,
      workerId: 'cw-perm',
      taskId: 't-perm',
      taskTitle: 'perm',
      accessScope: { userHome, workspace, permission },
    });
    return { worker, signalQueue };
  }

  /**
   * Run a no-op query to capture the wired canUseTool, then hand it back. The
   * callback stays bound to the worker after run() settles, so tests drive it
   * directly (the mock SDK never calls it).
   */
  async function captureCanUseTool(worker: ClaudeCodeWorker) {
    let options: Record<string, any> | null = null;
    const { stream, release } = gatedStream([], 'before-result');
    mockQuery.mockImplementationOnce((({ options: o }: any) => { options = o; return stream; }) as never);
    const runP = worker.run(makeTask(), {});
    await settle();
    release();
    await runP;
    expect(typeof options!.canUseTool).toBe('function');
    return options!.canUseTool as (t: string, i: Record<string, unknown>) => Promise<any>;
  }

  const permissionRequests = (sq: SignalQueue) => sq.query({ type: 'permission_request' });

  it('asks once for a sensitive read, naming the matched entry', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Read', { file_path: join(userHome, '.ssh', 'id_rsa') });
    await settle();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    const payload = requests[0].payload as any;
    // Same explainability fields as the puppet middleware.
    expect(payload.matchedEntry).toBe('.ssh');
    expect(payload.matchedRule).toBe('sensitive-list');
    expect(payload.sensitive).toBe(true);
    expect(payload.operation).toBe('read');
    expect(payload.description).toContain('hit: .ssh');
    expect(payload.description).not.toContain('PRIVATE');

    expect(worker.permissionHandler.resolvePermission(payload.requestId, true)).toBe(true);
    expect((await pending).behavior).toBe('allow');
  });

  it('asks once for a sensitive write, naming the entry and the direction', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Write', { file_path: join(userHome, '.aws', 'credentials') });
    await settle();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    const payload = requests[0].payload as any;
    expect(payload.matchedEntry).toBe('.aws');
    expect(payload.matchedRule).toBe('sensitive-list');
    expect(payload.sensitive).toBe(true);
    // A write to a credential file is described as a write.
    expect(payload.access).toBe('write');
    expect(payload.operation).toBe('write');
    expect(payload.description).toContain('hit: .aws');
    expect(payload.description).toContain('op: write');

    expect(worker.permissionHandler.resolvePermission(payload.requestId, true)).toBe(true);
    expect((await pending).behavior).toBe('allow');
  });

  it('denies a sensitive write without asking under sensitiveMode: deny', async () => {
    const { worker, signalQueue } = makeWiredWorker({ sensitiveMode: 'deny' });
    const canUseTool = await captureCanUseTool(worker);

    const verdict = await canUseTool('Write', { file_path: join(userHome, '.aws', 'credentials') });
    expect(verdict.behavior).toBe('deny');
    expect(String((verdict as any).message)).toContain('sensitive list');
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('records an audit entry for the approval it routed', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Read', { file_path: join(userHome, '.ssh', 'id_rsa') });
    await settle();
    const payload = permissionRequests(signalQueue)[0].payload as any;
    worker.permissionHandler.resolvePermission(payload.requestId, true);
    await pending;

    const audit = (worker as any).logger.info.mock.calls
      .map((call: any[]) => call[0])
      .filter((record: any) => record && record.audit === 'permission');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decision: 'approved',
      operation: 'read',
      // #43: the judged direction is its own field.
      access: 'read',
      matchedEntry: '.ssh',
      taskId: 't-perm',
      workerId: 'cw-perm',
      toolName: 'Read',
    });
  });

  it('allows a path inside the task workspace (read and write)', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    expect((await canUseTool('Read', { file_path: join(workspace, 'a.txt') })).behavior).toBe('allow');
    expect((await canUseTool('Write', { file_path: join(workspace, 'b.txt') })).behavior).toBe('allow');
    // A path-less search tool defaults to the workspace (its cwd) → allow.
    expect((await canUseTool('Glob', { pattern: '**/*.ts' })).behavior).toBe('allow');
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('asks the controller for a read inside home but outside the workspace', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Read', { file_path: join(userHome, 'notes', 'other-project.txt') });
    await settle();

    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    const payload = requests[0].payload as any;
    expect(payload.toolName).toBe('Read');
    expect(payload.description).toContain('other-project.txt');

    // Approved by the controller → allow.
    expect(worker.permissionHandler.resolvePermission(payload.requestId, true)).toBe(true);
    expect((await pending).behavior).toBe('allow');
  });

  it('asks for a bash command that only READS a sensitive path', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Bash', { command: `cat ${join(userHome, '.ssh', 'id_rsa')}` });
    await settle();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    expect((requests[0].payload as any).matchedEntry).toBe('.ssh');
    expect((requests[0].payload as any).operation).toBe('exec');

    worker.permissionHandler.resolvePermission((requests[0].payload as any).requestId, false, 'no');
    expect((await pending).behavior).toBe('deny');
  });

  it('asks for a bash command that WRITES a sensitive path (0.8.4)', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Bash', { command: `tee ${join(userHome, '.ssh', 'authorized_keys')} x` });
    await settle();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    const payload = requests[0].payload as any;
    expect(payload.matchedRule).toBe('sensitive-list');
    expect(payload.matchedEntry).toBe('.ssh');
    expect(payload.access).toBe('write');
    // `operation` stays the tool category (`exec` for bash).
    expect(payload.operation).toBe('exec');

    worker.permissionHandler.resolvePermission(payload.requestId, false, 'no');
    expect((await pending).behavior).toBe('deny');
  });

  it('denies a bash command that writes a sensitive path under sensitiveMode: deny', async () => {
    const { worker, signalQueue } = makeWiredWorker({ sensitiveMode: 'deny' });
    const canUseTool = await captureCanUseTool(worker);

    const verdict = await canUseTool('Bash', { command: `tee ${join(userHome, '.ssh', 'authorized_keys')} x` });
    expect(verdict.behavior).toBe('deny');
    expect(String((verdict as any).message)).toContain('sensitive list');
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });

  it('asks for a dangerous bash command even with no path candidate', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Bash', { command: 'sudo systemctl restart nginx' });
    await settle();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    const payload = requests[0].payload as any;
    expect(payload.toolName).toBe('Bash');
    worker.permissionHandler.resolvePermission(payload.requestId, false, 'no');
    expect((await pending).behavior).toBe('deny');
  });

  /**
   * #42 + #43: a dangerous command that also hits the sensitive list keeps both
   * details in the approval, and the audit separates the tool category from the
   * judged direction.
   */
  it('keeps the sensitive hit of a dangerous bash ask, and audits exec + access', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('Bash', { command: `sudo cat ${join(userHome, '.ssh', 'id_rsa')}` });
    await settle();
    const payload = permissionRequests(signalQueue)[0].payload as any;
    expect(payload.matchedRule).toBe('dangerous-bash');
    expect(payload.matchedEntry).toBe('.ssh');
    expect(payload.description).toContain('dangerous-bash');
    expect(payload.description).toContain('hit: .ssh');

    worker.permissionHandler.resolvePermission(payload.requestId, false, 'no');
    expect((await pending).behavior).toBe('deny');

    const audit = (worker as any).logger.info.mock.calls
      .map((call: any[]) => call[0])
      .filter((record: any) => record && record.audit === 'permission');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decision: 'denied',
      operation: 'exec',
      // #47: the prefix is stripped before the read-only lookup, so the audit
      // names the direction (`cat` reads) while the danger rule still asks.
      access: 'read',
      matchedRule: 'dangerous-bash',
      matchedEntry: '.ssh',
      toolName: 'Bash',
    });
    expect(JSON.stringify(audit[0])).not.toContain('PRIVATE');
  });

  it('stays conservative: an unknown tool asks instead of silently allowing', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    const pending = canUseTool('SomeFutureTool', { secret: true });
    await settle();
    const requests = permissionRequests(signalQueue);
    expect(requests).toHaveLength(1);
    const payload = requests[0].payload as any;
    expect(payload.toolName).toBe('SomeFutureTool');
    worker.permissionHandler.resolvePermission(payload.requestId, true);
    expect((await pending).behavior).toBe('allow');
  });

  it('allows a known non-path tool without asking (todo list, web, mcp resources)', async () => {
    const { worker, signalQueue } = makeWiredWorker();
    const canUseTool = await captureCanUseTool(worker);

    expect((await canUseTool('TodoWrite', { todos: [] })).behavior).toBe('allow');
    expect((await canUseTool('WebSearch', { query: 'x' })).behavior).toBe('allow');
    expect(permissionRequests(signalQueue)).toHaveLength(0);
  });
});
