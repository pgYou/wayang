/**
 * Regression for the 0.9.7 `askPaths` leak (review issue 2): a fail-closed
 * `ask` for a shape that runs an inner command this gate never analyzes must
 * not carry `askPaths`, or the task approval memory (issue #46) silently
 * covers the unanalyzed inner command with ONE pre-granted read of the outer
 * path — `find <dir> | xargs rm -f` ran without ever asking.
 *
 * Four contracts:
 *  a) `find <dir> | xargs rm` asks even when the task holds a read grant for
 *     `<dir>` (askPaths empty, or the verdict is the unknown-capability ask);
 *  b) a `bash -c "<inner>"` wrapper asks too — the merged verdict keeps the
 *     inner ask, which carries no askPaths;
 *  c) a `cd <dir> && <inner>` chain drops the cd slice's askPaths (the slice
 *     judged only the cd target, never the commands after it);
 *  d) control: a pure read-only `find` still reuses the grant — the fix must
 *     not over-block the intended #46 behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SignalQueue } from '@/services/signal/signal-queue';
import {
  evaluateBashAccess,
  decideToolAccess,
  type WorkerAccessScope,
} from '@/services/tools/permission-rules';
import { reusableGrantKeys } from '@/services/permission/permission-transport';
import { ApprovalMemory, approvalKey } from '@/services/permission/approval-memory';
import { wrapWithPermissionMiddleware } from '@/services/tools/permission-middleware';

const TASK_ID = 't1';

let home: string;
let ws: string;
let out: string; // readable but outside the read scope of a workspace-anchored scope
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'askpaths-home-'));
  ws = mkdtempSync(join(tmpdir(), 'askpaths-ws-'));
  out = mkdtempSync(join(tmpdir(), 'askpaths-out-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, '.ssh'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  process.env.HOME = realHome;
});

function scope(): WorkerAccessScope {
  return { userHome: home, workspace: ws };
}

/**
 * A gated bash middleware whose task already holds ONE read grant for `out` —
 * the exact state the leak exploited. `bash` records every execution; when
 * the gate asks, the request is answered with a denial so the call settles
 * without waiting on the 300s permission timeout.
 */
function preGrantedOutRead() {
  const grants = new ApprovalMemory();
  grants.remember(TASK_ID, approvalKey('read', out));
  const enqueued: any[] = [];
  const bashExecute = vi.fn(async () => 'ran:bash');
  const middleware = wrapWithPermissionMiddleware(
    { bash: { description: 'bash', parameters: {}, execute: bashExecute } },
    {
      gatedTools: ['bash'],
      decide: (toolName, args) => decideToolAccess(scope(), toolName, args),
      describeCall: (toolName, args) => `${toolName}: ${JSON.stringify(args)}`,
    },
    {
      workerId: 'w1',
      taskId: TASK_ID,
      taskTitle: 'T',
      signalQueue: { enqueue: (sig: any) => enqueued.push(sig) } as unknown as SignalQueue,
      grants,
    },
  );
  const permissionRequests = () => enqueued.filter((s) => s.type === 'permission_request');
  return {
    permissionRequests,
    bashExecute,
    /** Run one command to completion; an asking gate has its request denied. */
    run: async (command: string): Promise<string> => {
      // The middleware executes synchronously up to its first await (the
      // permission wait), so the request — if the gate asks — is already
      // enqueued when `execute` returns this promise.
      const pending = middleware.wrappedTools.bash.execute({ command }) as Promise<string>;
      const request = permissionRequests()[permissionRequests().length - 1];
      if (request !== undefined) {
        middleware.resolvePermission(request.payload.requestId, false, 'test: denied');
      }
      return pending;
    },
  };
}

describe('askPaths reuse across fail-closed shapes (0.9.7 regression)', () => {
  it('find | xargs rm asks even with a pre-granted read of the outer path', async () => {
    const command = `find ${out} -name '*.log' | xargs rm -f`;

    const verdict = evaluateBashAccess(scope(), command);
    expect(verdict.decision).toBe('ask');
    // No reusable grant keys: askPaths is empty, or the verdict is the
    // unknown-capability fail-closed ask (which never carries them).
    expect(
      (verdict.askPaths ?? []).length === 0 || verdict.matchedRule === 'unknown-capability',
    ).toBe(true);
    expect(reusableGrantKeys(verdict)).toEqual([]);

    // Through the middleware: the pre-granted read must not make this run
    // silently — it asks, and a denial means bash never executed.
    const harness = preGrantedOutRead();
    const output = await harness.run(command);
    expect(harness.permissionRequests()).toHaveLength(1);
    expect(harness.bashExecute).not.toHaveBeenCalled();
    expect(output).toContain('[ERROR] Permission denied');
  });

  it('a bash -c wrapper asks too — the pre-grant is not reused', async () => {
    const command = `bash -c "find ${out} -name '*.log' | xargs rm -f"`;

    const verdict = evaluateBashAccess(scope(), command);
    expect(verdict.decision).toBe('ask');
    // The merged verdict carries the inner ask's rule but not its askPaths.
    expect(reusableGrantKeys(verdict)).toEqual([]);

    const harness = preGrantedOutRead();
    const output = await harness.run(command);
    expect(harness.permissionRequests()).toHaveLength(1);
    expect(harness.bashExecute).not.toHaveBeenCalled();
    expect(output).toContain('[ERROR] Permission denied');
  });

  it('cd <dir> && <inner> drops the cd slice askPaths — still asks after a pre-grant', async () => {
    const command = `cd ${out} && rm -f a.log`;

    const verdict = evaluateBashAccess(scope(), command);
    expect(verdict.decision).toBe('ask');
    // The cd slice judged only the TARGET; the unjudged rest of the line must
    // not ride its askPaths into the approval memory.
    expect(verdict.askPaths ?? []).toEqual([]);
    expect(reusableGrantKeys(verdict)).toEqual([]);

    const harness = preGrantedOutRead();
    const output = await harness.run(command);
    expect(harness.permissionRequests()).toHaveLength(1);
    expect(harness.bashExecute).not.toHaveBeenCalled();
    expect(output).toContain('[ERROR] Permission denied');
  });

  it('control: a pure read-only find reuses the pre-granted read without asking', async () => {
    const command = `find ${out} -name '*.log'`;

    const verdict = evaluateBashAccess(scope(), command);
    expect(verdict.decision).toBe('ask');
    expect(reusableGrantKeys(verdict)).toHaveLength(1);

    const harness = preGrantedOutRead();
    const output = await harness.run(command);
    expect(output).toBe('ran:bash');
    expect(harness.permissionRequests()).toHaveLength(0);
    expect(harness.bashExecute).toHaveBeenCalledTimes(1);
  });
});
