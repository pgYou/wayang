import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, chmodSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupE2E, type E2ESetup } from '../harness';
import { isControllerRequest, isWorkerRequest } from '@/__tests__/fake-openai-provider';

let setup: E2ESetup | undefined;
let targetFile: string | undefined;
let targetDir: string | undefined;
afterAll(async () => {
  await setup?.dispose();
  if (targetDir) rmSync(targetDir, { recursive: true, force: true });
});

// The permission_request signal wakes the controller once (scripted as an
// acknowledgement); approval itself is driven via the RPC command, which is
// the surface a future WebUI approval center will use.
describe('e2e: worker permission approval', () => {
  it('dangerous bash is intercepted → permission_request → approve via RPC → executes → done', async () => {
    // Target inside the workspace (the worker's cwd), addressed by a relative
    // path; `chmod` still matches the tier-1 dangerous-command pattern.
    targetDir = mkdtempSync(join(tmpdir(), 'wayang-e2e-perm-'));

    setup = await setupE2E([
      {
        match: isControllerRequest,
        toolCalls: [{
          name: 'add_task',
          args: { title: 'Relax file mode', description: 'Run exactly: chmod 644 secret.txt', priority: 'normal' },
        }],
      },
      { match: isControllerRequest, text: 'Dispatched.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'bash', args: { command: 'chmod 644 secret.txt' } }] },
      { match: isControllerRequest, text: 'Permission needed; awaiting approval.' },
      { match: isWorkerRequest, toolCalls: [{ name: 'done', args: { summary: 'chmod executed' } }] },
      { match: isControllerRequest, text: 'Task finished.' },
    ]);

    // Create the target AFTER setup so it lives in this run's workspace.
    targetFile = join(setup.workspaceDir, 'secret.txt');
    writeFileSync(targetFile, 'permission e2e');
    chmodSync(targetFile, 0o600);

    await setup.submit('make that file readable');

    // The permission middleware intercepts before execution.
    await setup.waitFor('permission_request signal', (s) =>
      s.signals.some((sig) => sig.type === 'permission_request'));
    // Still 0600 — command has not run.
    expect(statSync(targetFile!).mode & 0o777).toBe(0o600);

    const request = setup.state.signals.find((sig) => sig.type === 'permission_request')!;
    const requestId = String(request.payload!.requestId);
    expect(requestId).toMatch(/^perm-/);

    const respondResult = await setup.client.request<{ resolved: boolean }>('respond_permission', { requestId, approved: true });
    expect(respondResult.resolved).toBe(true);

    // After approval the command runs for real and the task completes.
    await setup.waitFor('file mode changed', () => (statSync(targetFile!).mode & 0o777) === 0o644);
    await setup.waitFor('task completed', (s) =>
      s.history.length === 1 && s.history[0].status === 'completed');
  }, 90_000);
});
