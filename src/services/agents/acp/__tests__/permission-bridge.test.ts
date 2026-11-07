/**
 * permission-bridge tests (frozen §5 / 04 booklet).
 *
 * Scenarios:
 * - allow fast path (policy allow → allow option, audit 'allowed');
 * - ask path: signal payload → controller approve / deny (audit approved /
 *   denied source 'controller');
 * - approval memory hit (granted-by-memory + grantId, NO signal) and the
 *   sensitive-never-remembered rule;
 * - sensitive hit defaults to ASK (0.8.4 semantics — not a hard deny);
 * - optionId selection is by KIND, never by array order (measured:
 *   allow_always sits FIRST; optionIds are arbitrary strings);
 * - unknown kind fail-closed: shape inference failure asks directly and never
 *   feeds decideToolAccess (which allows every unknown tool name);
 * - timeout fail-closed (denied source 'timeout');
 * - onDenial emits a source-tagged event: controller deny → 'controller',
 *   timeout → 'timeout', policy hard-deny → 'policy'; an abort-cleanup settle
 *   ('aborted') emits none (#56 deny-source mapping);
 * - option set with neither allow nor reject → cancelled + hard-denied audit;
 * - verdicts are always based on the MERGED snapshot (request toolCall +
 *   previously accumulated events).
 */

import { describe, it, expect } from 'vitest';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SignalQueue } from '@/services/signal/signal-queue';
import { BlockingRequestMap } from '@/infra/blocking-requests';
import { ApprovalMemory } from '@/services/permission/approval-memory';
import type { Logger } from '@/infra/logger';
import { createMockLogger } from '@/__tests__/helpers';
import {
  ACP_PERMISSION_TIMEOUT_MS,
  classifyAcpToolCall,
  createAcpPermissionBridge,
  type AcpPermissionAnswer,
  type AcpPermissionBridgeDeps,
} from '@/services/agents/acp/permission-bridge';
import { createAcpToolAccumulator } from '@/services/agents/acp/event-mapper';
import type { AcpPermissionOption, AcpPermissionRequest, AcpToolCall, AcpToolCallUpdate } from '@/services/acp/types';
import type { WorkerAccessScope } from '@/services/tools/permission-rules';

const SCOPE: WorkerAccessScope = { userHome: '/home/test-user', workspace: '/tmp/test-ws' };

/**
 * Canonical spelling of a path, mirroring the policy's `normalizePath`
 * semantics WITHOUT importing it (the tests must not borrow the code under
 * test to compute their own expectations).
 *
 * The bridge keys grants on the `resolvedPath` the policy judged, and that is
 * `realpath`-normalized — on macOS `/etc` is a symlink to `/private/etc`, so a
 * raw `/etc/passwd` and the granted `/private/etc/passwd` name the same file
 * but are not the same string. Resolve the deepest EXISTING ancestor with
 * `realpathSync` and glue the missing tail back on:
 *
 *   /tmp/link/new_key   (/tmp/link -> /home/u)  =>  /home/u/new_key
 */
function canonical(p: string): string {
  const lexical = resolve(p);
  const peeled: string[] = [];
  let candidate = lexical;

  for (let depth = 0; depth <= 32; depth += 1) {
    try {
      const resolved = realpathSync(candidate);
      return peeled.length === 0 ? resolved : resolve(join(resolved, ...peeled));
    } catch {
      // Missing or unreadable — peel one segment and retry on the parent.
    }
    const parent = dirname(candidate);
    if (parent === candidate) break; // hit the filesystem root
    peeled.unshift(basename(candidate));
    candidate = parent;
  }

  return lexical;
}

/** Measured codebuddy option set shape: allow_always FIRST, optionIds arbitrary. */
const MEASURED_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
];

interface BridgeHarness {
  handler: (req: AcpPermissionRequest) => Promise<{ outcome: string; optionId?: string }>;
  accumulator: ReturnType<typeof createAcpToolAccumulator>;
  signals: Array<Record<string, any>>;
  grants: ApprovalMemory;
  pending: BlockingRequestMap<AcpPermissionAnswer>;
  logger: Logger & { info: { mock: { calls: any[] } }; warn: { mock: { calls: any[] } } };
}

function makeBridge(overrides: Partial<AcpPermissionBridgeDeps> = {}): BridgeHarness {
  const accumulator = createAcpToolAccumulator();
  const signals: Array<Record<string, any>> = [];
  const signalQueue = {
    enqueue: (sig: Record<string, any>) => {
      signals.push(sig);
    },
  } as unknown as SignalQueue;
  const grants = new ApprovalMemory();
  const pending = new BlockingRequestMap<AcpPermissionAnswer>();
  const logger = createMockLogger() as BridgeHarness['logger'];
  const deps: AcpPermissionBridgeDeps = {
    accumulator,
    scope: SCOPE,
    signalQueue,
    runContext: { workerId: 'w-1', taskId: 'task-1', taskTitle: 'Test task', workerType: 'codebuddy-acp' },
    grants,
    approvalMemory: 'task',
    logger,
    provider: 'codebuddy-acp',
    permissionMs: ACP_PERMISSION_TIMEOUT_MS,
    ...overrides,
  };
  return { handler: createAcpPermissionBridge(deps, pending), accumulator, signals, grants, pending, logger };
}

function permissionRequest(toolCall: AcpToolCall | AcpToolCallUpdate, options = MEASURED_OPTIONS): AcpPermissionRequest {
  return { sessionId: 's-1', toolCall: toolCall as AcpToolCallUpdate, options };
}

/** All permission audit records the logger received. */
function auditRecords(logger: BridgeHarness['logger']): any[] {
  return logger.info.mock.calls.filter((call) => call[0]?.audit === 'permission').map((call) => call[0]);
}

describe('classifyAcpToolCall: kind → policy tool mapping (frozen §5 table)', () => {
  it('execute → bash with command from rawInput.command (string[] cmd joined)', () => {
    const direct = classifyAcpToolCall({
      toolCallId: 't',
      title: 'Bash',
      kind: 'execute',
      rawInput: { command: 'echo hi' },
    });
    expect(direct).toMatchObject({ type: 'policy', toolName: 'bash', args: { command: 'echo hi' } });

    const joined = classifyAcpToolCall({
      toolCallId: 't',
      title: 'Bash',
      kind: 'execute',
      rawInput: { cmd: ['echo', 'hi'] },
    });
    expect(joined).toMatchObject({ type: 'policy', args: { command: 'echo hi' } });
  });

  it('read/edit → read_file/edit_file; delete/move → write_file; path from locations or rawInput', () => {
    expect(
      classifyAcpToolCall({ toolCallId: 't', title: 'R', kind: 'read', locations: [{ path: '/tmp/a' }] }),
    ).toMatchObject({ type: 'policy', toolName: 'read_file', args: { path: '/tmp/a' } });
    expect(
      classifyAcpToolCall({ toolCallId: 't', title: 'E', kind: 'edit', rawInput: { file_path: '/tmp/a' } }),
    ).toMatchObject({ type: 'policy', toolName: 'edit_file' });
    expect(
      classifyAcpToolCall({ toolCallId: 't', title: 'D', kind: 'delete', rawInput: { path: '/tmp/a' } }),
    ).toMatchObject({ type: 'policy', toolName: 'write_file' });
  });

  it('search without a path → direct-allow (cwd-scoped, pathRequired:false parity)', () => {
    expect(classifyAcpToolCall({ toolCallId: 't', title: 'S', kind: 'search' })).toMatchObject({
      type: 'direct-allow',
    });
  });

  it('fetch/think/switch_mode → direct-allow (non-path kinds)', () => {
    for (const kind of ['fetch', 'think', 'switch_mode'] as const) {
      expect(classifyAcpToolCall({ toolCallId: 't', title: 'X', kind })).toMatchObject({ type: 'direct-allow' });
    }
  });

  it('other/missing kind: command → bash; path + name read/grep → read_file; else write_file', () => {
    expect(
      classifyAcpToolCall({ toolCallId: 't', title: '?', kind: 'other', rawInput: { command: 'ls' } }),
    ).toMatchObject({ type: 'policy', toolName: 'bash' });
    expect(
      classifyAcpToolCall({ toolCallId: 't', title: '?', name: 'grep_files', rawInput: { path: '/tmp/a' } }),
    ).toMatchObject({ type: 'policy', toolName: 'read_file' });
    expect(
      classifyAcpToolCall({ toolCallId: 't', title: '?', rawInput: { path: '/tmp/a' } }),
    ).toMatchObject({ type: 'policy', toolName: 'write_file' });
  });

  it('inference failure → direct-ask (never fed to decideToolAccess)', () => {
    expect(classifyAcpToolCall({ toolCallId: 't', title: '?', kind: 'other', rawInput: {} })).toMatchObject({
      type: 'direct-ask',
    });
    expect(classifyAcpToolCall({ toolCallId: 't', title: '?', rawInput: { mystery: true } })).toMatchObject({
      type: 'direct-ask',
    });
  });
});

describe('bridge: verdict → outcome', () => {
  it('policy allow → allow option selected by KIND (allow_once beats allow_always despite order), audit allowed', async () => {
    const { handler, logger } = makeBridge();
    const outcome = await handler(
      permissionRequest({ toolCallId: 'tc', title: 'Bash', kind: 'execute', rawInput: { command: 'echo hi' } }),
    );
    // optionId 'allow' is the allow_once entry; 'allow_always' sits FIRST in the array.
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(auditRecords(logger)).toEqual([
      expect.objectContaining({ decision: 'allowed', toolName: 'execute', transport: 'acp', provider: 'codebuddy-acp' }),
    ]);
  });

  it('ask (outside-scope read) → permission_request signal → approve → allow + grant remembered', async () => {
    const { handler, signals, grants, pending } = makeBridge();
    const promise = handler(
      permissionRequest({
        toolCallId: 'tc',
        title: 'Read',
        kind: 'read',
        rawInput: { file_path: '/etc/passwd' },
      }),
    );
    expect(signals).toHaveLength(1);
    const payload = signals[0].payload;
    expect(payload.toolName).toBe('read');
    expect(payload.toolArgs).toEqual({ file_path: '/etc/passwd' });
    expect(payload.description).toContain('/etc/passwd');
    expect(payload.requestId).toBeDefined();

    pending.resolve(payload.requestId, { approved: true });
    await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
    // The read approval opened a grant for the asking path.
    expect(grants.has('task-1', `read:${canonical('/etc/passwd')}`)).toBe(true);
  });

  it('ask → controller deny → reject option, audit denied source controller', async () => {
    const { handler, signals, pending, logger, grants } = makeBridge();
    const promise = handler(
      permissionRequest({ toolCallId: 'tc', title: 'Read', kind: 'read', rawInput: { file_path: '/etc/passwd' } }),
    );
    const requestId = signals[0].payload.requestId;
    pending.resolve(requestId, { approved: false });
    await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(auditRecords(logger)).toEqual([expect.objectContaining({ decision: 'denied', source: 'controller' })]);
    // A refusal is a decision about THIS request — nothing is remembered.
    expect(grants.has('task-1', 'read:/etc/passwd')).toBe(false);
  });

  it('controller deny fires onDenial(controller); an abort-cleanup settle fires none (#56)', async () => {
    const denials: string[] = [];
    const { handler, signals, pending } = makeBridge({
      onDenial: (info) => denials.push(`${info.source}:${info.toolName}`),
    });
    const read = () =>
      permissionRequest({ toolCallId: 'tc', title: 'Read', kind: 'read', rawInput: { file_path: '/etc/passwd' } });

    // A controller denial is a user rejection — recorded with source + tool name.
    const denied = handler(read());
    pending.resolve(signals[0].payload.requestId, { approved: false });
    await denied;
    expect(denials).toEqual(['controller:read']);

    // The abort cleanup ('Worker aborted') also settles unapproved, but it is
    // the run being torn down, not a refusal — it emits no denial event.
    const aborted = handler(read());
    pending.resolve(signals[1].payload.requestId, { approved: false, reason: 'Worker aborted' });
    await aborted;
    expect(denials).toEqual(['controller:read']);
  });

  it('a timeout fires onDenial(timeout) (#56)', async () => {
    const denials: string[] = [];
    const { handler } = makeBridge({
      permissionMs: 15,
      onDenial: (info) => denials.push(`${info.source}:${info.toolName}`),
    });
    await handler(
      permissionRequest({ toolCallId: 'tc', title: 'Read', kind: 'read', rawInput: { file_path: '/etc/passwd' } }),
    );
    expect(denials).toEqual(['timeout:read']);
  });

  it('a policy hard-deny fires onDenial(policy) with no controller prompt (#56)', async () => {
    const denials: string[] = [];
    const { handler, signals, logger } = makeBridge({
      scope: { ...SCOPE, permission: { sensitiveMode: 'deny' } },
      onDenial: (info) => denials.push(`${info.source}:${info.toolName}`),
    });
    const outcome = await handler(
      permissionRequest({ toolCallId: 'tc', title: 'Read', kind: 'read', rawInput: { file_path: '/home/test-user/.ssh/id_rsa' } }),
    );
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(signals).toHaveLength(0); // policy refused locally — no permission_request signal
    expect(denials).toEqual(['policy:read']);
    expect(auditRecords(logger).some((record) => record.decision === 'hard-denied')).toBe(true);
  });

  it('approval memory hit → allow WITHOUT a signal, audit granted-by-memory + grantId', async () => {
    const { handler, accumulator, signals, pending, logger } = makeBridge();
    const req = () =>
      permissionRequest({ toolCallId: 'tc', title: 'Read', kind: 'read', rawInput: { file_path: '/etc/passwd' } });

    // First read: asks and is approved.
    const first = handler(req());
    pending.resolve(signals[0].payload.requestId, { approved: true });
    await first;

    // Second read of the SAME path in the SAME task: no signal, memory grant.
    const second = handler(req());
    await expect(second).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(signals).toHaveLength(1); // no second permission_request
    const records = auditRecords(logger);
    expect(records[records.length - 1]).toMatchObject({ decision: 'granted-by-memory' });
    expect(records[records.length - 1].grantId).toBeDefined();
    // Sanity: the accumulator merged both requests under one toolCallId.
    expect(accumulator.peek('tc')).toBeDefined();
  });

  it('sensitive hit defaults to ASK (0.8.4) and is NEVER remembered even when approved', async () => {
    const { handler, signals, pending, grants, logger } = makeBridge();
    const sensitiveRead = () =>
      permissionRequest({
        toolCallId: 'tc',
        title: 'Read',
        kind: 'read',
        rawInput: { file_path: '/home/test-user/.ssh/id_rsa' },
      });

    const first = handler(sensitiveRead());
    expect(signals).toHaveLength(1);
    expect(signals[0].payload.sensitive).toBe(true);
    expect(signals[0].payload.matchedRule).toBe('sensitive-list');
    pending.resolve(signals[0].payload.requestId, { approved: true });
    await first;
    expect(grants.has('task-1', 'read:/home/test-user/.ssh/id_rsa')).toBe(false);

    // Second sensitive read asks AGAIN (sensitive hits never reuse a grant).
    const second = handler(sensitiveRead());
    expect(signals).toHaveLength(2);
    pending.resolve(signals[1].payload.requestId, { approved: true });
    await second;
    expect(auditRecords(logger).some((record) => record.decision === 'hard-denied')).toBe(false);
  });

  it('timeout fail-closed → reject option, audit denied source timeout', async () => {
    const { handler, signals, logger } = makeBridge({ permissionMs: 15 });
    const outcome = await handler(
      permissionRequest({ toolCallId: 'tc', title: 'Read', kind: 'read', rawInput: { file_path: '/etc/passwd' } }),
    );
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(auditRecords(logger)).toEqual([expect.objectContaining({ decision: 'denied', source: 'timeout' })]);
    expect(signals).toHaveLength(1);
  });

  it('option set with neither allow nor reject → cancelled + hard-denied audit + warn log', async () => {
    const { handler, logger } = makeBridge();
    const outcome = await handler(permissionRequest(
      { toolCallId: 'tc', title: 'Bash', kind: 'execute', rawInput: { command: 'echo hi' } },
      [],
    ));
    expect(outcome).toEqual({ outcome: 'cancelled' });
    // Two records tell the whole story: the POLICY allowed the call, but the
    // agent's option set could not express it (fail-closed rule 2).
    const decisions = auditRecords(logger).map((record) => record.decision);
    expect(decisions).toEqual(['allowed', 'hard-denied']);
    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
  });

  it('unknown kind with no inference input → asks DIRECTLY (never silently allowed, no policy call)', async () => {
    const { handler, signals, pending } = makeBridge();
    const promise = handler(permissionRequest({ toolCallId: 'tc', title: '?', kind: 'other', rawInput: {} }));
    // The request went to the controller — and the outcome waits on it.
    expect(signals).toHaveLength(1);
    expect(signals[0].payload.toolName).toBe('other');
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve(signals[0].payload.requestId, { approved: true });
    await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('execute without a usable command → direct ask (fail-closed rule 1)', async () => {
    const { handler, signals } = makeBridge();
    const promise = handler(permissionRequest({ toolCallId: 'tc', title: 'Bash', kind: 'execute', rawInput: {} }));
    expect(signals).toHaveLength(1);
    expect(signals[0].payload.description).toContain('command could not be determined');
    void promise; // left pending intentionally — the request awaits the controller
  });

  it('non-path kinds (fetch) select the allow option without any signal', async () => {
    const { handler, signals } = makeBridge();
    const outcome = await handler(
      permissionRequest({ toolCallId: 'tc', title: 'Fetch', kind: 'fetch', rawInput: { url: 'https://x' } }),
    );
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(signals).toHaveLength(0);
  });
});

describe('bridge: merged-snapshot judging (frozen §5 input merge)', () => {
  it('the request is judged on the MERGED snapshot, never on the bare request fields', async () => {
    const { handler, accumulator, signals, pending } = makeBridge();
    // The agent already streamed: kind execute, empty rawInput (first event).
    accumulator.upsert({ toolCallId: 'tc', title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: {} });
    // The permission request carries NO kind — only the rawInput command
    // pointing at a sensitive file. Merged: execute + sensitive bash → ask.
    const promise = handler(
      permissionRequest({ toolCallId: 'tc', rawInput: { command: 'cat /home/test-user/.ssh/id_rsa' } }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].payload.toolName).toBe('execute');
    expect(signals[0].payload.sensitive).toBe(true);
    pending.resolve(signals[0].payload.requestId, { approved: false });
    await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });
  });

  it('approvalMemory off disables both the lookup and the write-back', async () => {
    const { handler, signals, grants, pending } = makeBridge({ approvalMemory: 'off' });
    const req = () =>
      permissionRequest({ toolCallId: 'tc', title: 'Read', kind: 'read', rawInput: { file_path: '/etc/passwd' } });
    const first = handler(req());
    pending.resolve(signals[0].payload.requestId, { approved: true });
    await first;
    expect(grants.has('task-1', 'read:/etc/passwd')).toBe(false);

    const second = handler(req());
    expect(signals).toHaveLength(2); // asks again — nothing was remembered
    pending.resolve(signals[1].payload.requestId, { approved: true });
    await second;
  });
});
