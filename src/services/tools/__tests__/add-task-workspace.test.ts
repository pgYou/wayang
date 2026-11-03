/**
 * add_task workspace declaration — the task carries a workspace identity, but
 * execution stays single-workspace: a declared workspace that resolves to
 * anything other than the current one is rejected before a task is created.
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

  it('rejects a different workspace and creates no task', async () => {
    // Minimal in-memory task store standing in for the engine.
    const tasks: TaskDetail[] = [];
    const addTask = vi.fn((t: TaskDetail) => { tasks.push(t); return 'w-1'; });
    const tool = addTaskTool({ addTask, workspaceDir, wayangDir });
    const listTool = listTasksTool({ listTasks: () => tasks });

    // One task already exists, created in the current workspace.
    await exec(tool, { title: 'baseline', description: 'D' });
    const countOpen = () => tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
    const before = countOpen();
    expect(before).toBe(1);

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      workspace: otherDir,
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(countOpen()).toBe(before);
    expect(tasks).toHaveLength(1);
    // The rejection must name the limitation instead of failing silently.
    expect(result).toContain('not supported in the current version');
    expect(result).toContain('NOT created');
    expect(result).toContain(normalizeWorkspacePath(otherDir));
    expect(result).toContain(normalizeWorkspacePath(workspaceDir));

    // And the list still shows exactly the one baseline task.
    const listed = await exec(listTool, {});
    expect(listed.split('\n')).toHaveLength(1);
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
