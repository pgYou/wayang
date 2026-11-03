/**
 * add_task workspace declaration — a task carries the workspace identity it
 * will execute in. A declared workspace may differ from the current one: the
 * task is created and the engine runs it there. Only an unresolvable
 * declaration (no known current workspace) is rejected.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDetail } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import { listTasksTool } from '@/services/tools/list-tasks';
import { getTaskDetailTool } from '@/services/tools/get-task-detail';
import { normalizeWorkspacePath } from '@/infra/workspace-registry';
import { makeTask } from '@/__tests__/helpers';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

let wayangDir: string;
let scratchRoot: string;
let workspaceDir: string;
let otherDir: string;

function makeDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

beforeEach(() => {
  wayangDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-addtask-ws-home-'));
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-addtask-ws-root-'));
  workspaceDir = makeDir(scratchRoot, 'wayang');
  otherDir = makeDir(scratchRoot, 'other-repo');
});

afterEach(() => {
  fs.rmSync(wayangDir, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('addTaskTool — workspace declaration', () => {
  it('defaults to the current workspace and stamps path + slug', async () => {
    const added: TaskDetail[] = [];
    const tool = addTaskTool({
      addTask: (t) => { added.push(t); return 'w-1'; },
      workspaceDir,
      wayangDir,
    });

    const result = await exec(tool, { title: 'T', description: 'D' });

    expect(result).toContain('added');
    expect(added).toHaveLength(1);
    expect(added[0].workspace).toEqual({
      path: normalizeWorkspacePath(workspaceDir),
      slug: 'wayang',
    });
  });

  it('degrades to the rule-based slug when no wayangDir is available', async () => {
    const added: TaskDetail[] = [];
    const tool = addTaskTool({
      addTask: (t) => { added.push(t); return undefined; },
      workspaceDir,
    });

    await exec(tool, { title: 'T', description: 'D' });

    expect(added[0].workspace).toEqual({
      path: normalizeWorkspacePath(workspaceDir),
      slug: 'wayang',
    });
  });

  it('accepts equivalent spellings of the current workspace (trailing slash, relative, dot, symlink)', async () => {
    const linkPath = path.join(scratchRoot, 'wayang-link');
    fs.symlinkSync(workspaceDir, linkPath, 'dir');

    const variants = [
      `${workspaceDir}/`,
      path.relative(process.cwd(), workspaceDir),
      path.join(workspaceDir, '.'),
      linkPath,
    ];

    const added: TaskDetail[] = [];
    const tool = addTaskTool({
      addTask: (t) => { added.push(t); return 'w-1'; },
      workspaceDir,
      wayangDir,
    });

    for (const workspace of variants) {
      const result = await exec(tool, { title: 'T', description: 'D', workspace });
      expect(result).toContain('added');
    }

    expect(added).toHaveLength(variants.length);
    for (const task of added) {
      expect(task.workspace).toEqual({
        path: normalizeWorkspacePath(workspaceDir),
        slug: 'wayang',
      });
    }
  });

  it('accepts a different workspace and stamps it onto the created task', async () => {
    // Minimal in-memory task store standing in for the engine.
    const tasks: TaskDetail[] = [];
    const addTask = vi.fn((t: TaskDetail) => { tasks.push(t); return 'w-1'; });
    const tool = addTaskTool({ addTask, workspaceDir, wayangDir });
    const listTool = listTasksTool({ listTasks: () => tasks });

    // One task already exists, created in the current workspace.
    await exec(tool, { title: 'baseline', description: 'D' });
    expect(tasks).toHaveLength(1);

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      workspace: otherDir,
    });

    // The task IS created — the engine executes it in the declared workspace.
    expect(result).toContain('added');
    expect(addTask).toHaveBeenCalledTimes(2);
    expect(tasks).toHaveLength(2);

    // The stamped identity is the canonical form of the DECLARED workspace,
    // not of the process workspace.
    expect(tasks[0].workspace).toEqual({
      path: normalizeWorkspacePath(workspaceDir),
      slug: 'wayang',
    });
    expect(tasks[1].workspace).toEqual({
      path: normalizeWorkspacePath(otherDir),
      slug: 'other-repo',
    });

    // The listing surfaces the target workspace of each task.
    const listed = await exec(listTool, {});
    expect(listed.split('\n')).toHaveLength(2);
    expect(listed).toContain('ws: wayang');
    expect(listed).toContain('ws: other-repo');
  });

  it('canonicalizes a different workspace given in an equivalent spelling', async () => {
    const linkPath = path.join(scratchRoot, 'other-link');
    fs.symlinkSync(otherDir, linkPath, 'dir');

    const added: TaskDetail[] = [];
    const tool = addTaskTool({
      addTask: (t) => { added.push(t); return 'w-1'; },
      workspaceDir,
      wayangDir,
    });

    for (const workspace of [`${otherDir}/`, linkPath, path.join(otherDir, '.')]) {
      const result = await exec(tool, { title: 'T', description: 'D', workspace });
      expect(result).toContain('added');
    }

    expect(added).toHaveLength(3);
    for (const task of added) {
      expect(task.workspace?.path).toBe(normalizeWorkspacePath(otherDir));
    }
  });

  it('treats an empty or whitespace-only workspace as undeclared (default)', async () => {
    const added: TaskDetail[] = [];
    const tool = addTaskTool({
      addTask: (t) => { added.push(t); return 'w-1'; },
      workspaceDir,
      wayangDir,
    });

    for (const workspace of ['', '   ', '\t\n']) {
      const result = await exec(tool, { title: 'T', description: 'D', workspace });
      expect(result).toContain('added');
    }

    expect(added).toHaveLength(3);
    for (const task of added) {
      expect(task.workspace).toEqual({
        path: normalizeWorkspacePath(workspaceDir),
        slug: 'wayang',
      });
    }
  });

  it('surfaces the engine\'s workspace guard when the idle worker belongs to another workspace', async () => {
    const addTask = vi.fn((_t: TaskDetail) => 'w-1');
    const assignToWorker = vi.fn(() => true);
    const guardMessage =
      'Worker "w-9" was created in workspace /repos/wayang and cannot take a task in ' +
      `${normalizeWorkspacePath(otherDir)}. Create a new worker for that workspace instead (drop assignToWorker).`;
    const validateWorkerWorkspace = vi.fn(() => guardMessage);

    const tool = addTaskTool({
      addTask,
      validateIdleWorker: () => null, // the worker IS idle — only the workspace differs
      assignToWorker,
      validateWorkerWorkspace,
      workspaceDir,
      wayangDir,
    });

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      assignToWorker: 'w-9',
      workspace: otherDir,
    });

    // The controller gets the reason plus the remedy, and nothing is dispatched.
    expect(result).toBe(guardMessage);
    expect(validateWorkerWorkspace).toHaveBeenCalledWith('w-9', normalizeWorkspacePath(otherDir));
    expect(addTask).not.toHaveBeenCalled();
    expect(assignToWorker).not.toHaveBeenCalled();
  });

  it('assigns to an idle worker whose workspace matches', async () => {
    const addTask = vi.fn((_t: TaskDetail) => 'w-1');
    const assignToWorker = vi.fn(() => true);
    const validateWorkerWorkspace = vi.fn(() => null);

    const tool = addTaskTool({
      addTask,
      validateIdleWorker: () => null,
      assignToWorker,
      validateWorkerWorkspace,
      workspaceDir,
      wayangDir,
    });

    const result = await exec(tool, { title: 'T', description: 'D', assignToWorker: 'w-9' });

    // No workspace declared → the process workspace is the target.
    expect(validateWorkerWorkspace).toHaveBeenCalledWith('w-9', normalizeWorkspacePath(workspaceDir));
    expect(assignToWorker).toHaveBeenCalledTimes(1);
    expect(result).toContain('assigned to worker w-9');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('rejects a declared workspace when the current workspace is unknown', async () => {
    const addTask = vi.fn((_t: TaskDetail) => 'w-1');
    const tool = addTaskTool({ addTask, wayangDir }); // no workspaceDir injected

    const result = await exec(tool, { title: 'T', description: 'D', workspace: otherDir });

    expect(addTask).not.toHaveBeenCalled();
    expect(result).toContain('NOT created');
    expect(result).toContain(normalizeWorkspacePath(otherDir));
  });
});

// --- display layer ---

describe('workspace in task listings', () => {
  it('appends the workspace slug to list_tasks and omits it when absent', async () => {
    const tasks = [
      makeTask('t1', {
        status: 'running',
        workerSessionId: 'w-91',
        workspace: { path: '/repos/wayang', slug: 'wayang' },
      }),
      makeTask('t2', { status: 'pending' }),
    ];
    const tool = listTasksTool({ listTasks: () => tasks });
    const result = await exec(tool, {});

    expect(result).toContain('[running] t1 (worker: w-91, ws: wayang)');
    // No workspace identity → unchanged compact line, no empty "ws:" suffix.
    expect(result).toContain('[pending] t2 (worker: none)');
    expect(result).not.toMatch(/ws:\s*[,)]/);
  });

  it('shows workspace path and slug in get_task_detail', async () => {
    const workspace = { path: '/repos/wayang', slug: 'wayang' };
    const task = makeTask('t1', { status: 'completed', result: 'ok', workspace });
    const tool = getTaskDetailTool({ getTask: () => task });
    const result = await exec(tool, { taskId: 't1' });

    expect(result).toContain(`Workspace: ${workspace.path} (slug: ${workspace.slug})`);
  });

  it('omits the workspace line in get_task_detail when the task has no identity', async () => {
    const task = makeTask('t1', { status: 'completed', result: 'ok' });
    const tool = getTaskDetailTool({ getTask: () => task });
    const result = await exec(tool, { taskId: 't1' });

    expect(result).not.toContain('Workspace:');
  });
});
