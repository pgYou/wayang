/**
 * add_task dispatch baseline = the INJECTED controllerWorkspace (design 4.2).
 *
 * Contract under test:
 * - a task with no declared workspace is stamped with controllerWorkspace —
 *   NOT with the defaultWorkerWorkspace and NOT with anything derived from
 *   the user home;
 * - a RELATIVE declared workspace resolves against controllerWorkspace, never
 *   against the process startup directory (the cwd ban);
 * - the general workspace advertised in the tool description is the
 *   defaultWorkerWorkspace — a different directory from the dispatch
 *   baseline when the host injects them differently.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addTaskTool } from '@/services/tools/add-task';
import { normalizeWorkspacePath } from '@/infra/workspace-registry';
import type { TaskDetail } from '@wayang-ai/protocol';

let userHome: string;
let controllerWs: string;
let workerDefaultWs: string;

beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-ctrl-ws-home-'));
  controllerWs = fs.mkdtempSync(path.join(userHome, 'controller-ws'));
  workerDefaultWs = path.join(userHome, '.wayang', 'workspace');
});

afterEach(() => {
  fs.rmSync(userHome, { recursive: true, force: true });
});

function makeTool(added: TaskDetail[]) {
  return addTaskTool({
    addTask: (task) => {
      added.push(task);
      return `w-${added.length}`;
    },
    // The dispatch baseline — what ControllerAgent.create injects as
    // ctx.workspaceDir (= workspacePolicy.controllerWorkspace).
    workspaceDir: controllerWs,
    userHome,
    wayangDir: path.join(userHome, '.wayang'),
    // What the prompt/description advertise — the general workspace, i.e. the
    // injected defaultWorkerWorkspace.
    generalWorkspaceDir: workerDefaultWs,
  });
}

async function exec(tool: ReturnType<typeof makeTool>, args: Record<string, unknown>): Promise<string> {
  return tool.execute(args as never, undefined) as unknown as Promise<string>;
}

describe('add_task — controllerWorkspace as the dispatch baseline', () => {
  it('stamps a task without a declared workspace with the controllerWorkspace (not the worker default)', async () => {
    const added: TaskDetail[] = [];
    const result = await exec(makeTool(added), { title: 'T', description: 'D' });

    expect(result).toContain('added');
    expect(added).toHaveLength(1);
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(controllerWs));
    expect(added[0].workspace?.path).not.toBe(workerDefaultWs);
  });

  it('resolves a RELATIVE declared workspace against the controllerWorkspace, not the process cwd', async () => {
    const target = path.join(controllerWs, 'nested', 'target');
    fs.mkdirSync(target, { recursive: true });
    // A spelling that is relative ONLY with respect to the controller
    // workspace — resolving it against process.cwd() would land somewhere
    // else entirely (the vitest working directory is a different tree).
    const relative = path.relative(controllerWs, target);

    const added: TaskDetail[] = [];
    const result = await exec(makeTool(added), { title: 'T', description: 'D', workspace: relative });

    expect(result).toContain('added');
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(target));
  });

  it('rejects a relative declaration that escapes home WHEN resolved against the controllerWorkspace', async () => {
    // ../../ climbs out of the controller workspace to the temp root —
    // outside the user home, so the boundary check refuses it. The anchor
    // for the climb is the controllerWorkspace (design 4.2), which proves the
    // resolution is not silently process-cwd based.
    const added: TaskDetail[] = [];
    const result = await exec(makeTool(added), { title: 'T', description: 'D', workspace: '../../outside' });

    expect(result).toContain('outside-home');
    expect(result).toContain('NOT created');
    expect(added).toHaveLength(0);
  });

  it('advertises the defaultWorkerWorkspace (general workspace) in the workspace parameter description', () => {
    const tool = makeTool([]);
    const workspaceParam = (tool.inputSchema as unknown as { shape: { workspace: { description: string } } }).shape.workspace;
    expect(workspaceParam.description).toContain(workerDefaultWs);
    expect(workspaceParam.description).not.toContain(controllerWs);
  });
});
