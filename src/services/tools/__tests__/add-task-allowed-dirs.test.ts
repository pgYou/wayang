/**
 * add_task allowedDirs declaration — a task may declare extra directories it
 * (and only it) is allowed to access. Entries are normalized, must live inside
 * the user's home, and must not touch the denied-path list. A single invalid
 * entry fails the whole call so no task is ever created with a partial grant.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskDetail } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import { listTasksTool } from '@/services/tools/list-tasks';
import { getTaskDetailTool } from '@/services/tools/get-task-detail';
import { normalizePath } from '@/infra/permission/policy';
import { makeTask } from '@/__tests__/helpers';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

let homeDir: string;
let outsideRoot: string;
let workspaceDir: string;
let dataDir: string;
let cacheDir: string;
let relDataDir: string;
let sshDir: string;

function makeDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-allowed-dirs-home-'));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-allowed-dirs-outside-'));
  workspaceDir = makeDir(homeDir, 'workspace');
  dataDir = makeDir(homeDir, 'data');
  cacheDir = makeDir(homeDir, 'cache');
  relDataDir = makeDir(workspaceDir, 'rel-data');
  sshDir = makeDir(homeDir, '.ssh');
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

function makeTool(added: TaskDetail[], deps: Partial<Parameters<typeof addTaskTool>[0]> = {}) {
  return addTaskTool({
    addTask: (t) => { added.push(t); return 'w-1'; },
    workspaceDir,
    homeDir,
    ...deps,
  });
}

describe('addTaskTool — allowedDirs declaration', () => {
  it('accepts valid dirs, normalizes them, and dedupes preserving order', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [dataDir, cacheDir, `${dataDir}/`],
    });

    expect(result).toContain('added');
    expect(added).toHaveLength(1);
    expect(added[0].taskAllowedDirs).toEqual([
      normalizePath(dataDir),
      normalizePath(cacheDir),
    ]);
  });

  it('rejects a dir outside the home directory and creates no task', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);
    const outside = makeDir(outsideRoot, 'elsewhere');

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [outside],
    });

    expect(result).toContain('outside');
    expect(result).toContain(outside);
    expect(result).toContain('NOT created');
    expect(added).toHaveLength(0);
  });

  it('rejects a sensitive dir (~/.ssh) and creates no task', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [sshDir],
    });

    expect(result).toContain(sshDir);
    expect(result).toContain('sensitive list');
    expect(result).toContain('NOT created');
    expect(added).toHaveLength(0);
  });

  it('rejects a configured sensitiveDirs entry and creates no task', async () => {
    const added: TaskDetail[] = [];
    const secretDir = makeDir(homeDir, 'secret-area');
    const tool = makeTool(added, { permissionConfig: { sensitiveDirs: ['secret-area'] } });

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [secretDir],
    });

    expect(result).toContain('sensitive list');
    expect(result).toContain('NOT created');
    expect(added).toHaveLength(0);
  });

  it('honours the deprecated deniedDirs alias for the same rejection', async () => {
    const added: TaskDetail[] = [];
    const secretDir = makeDir(homeDir, 'legacy-area');
    const tool = makeTool(added, { permissionConfig: { deniedDirs: ['legacy-area'] } });

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [secretDir],
    });

    expect(result).toContain('sensitive list');
    expect(result).toContain('NOT created');
    expect(added).toHaveLength(0);
  });

  it('resolves a relative entry against the task workspace', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      workspace: workspaceDir,
      allowedDirs: ['rel-data'],
    });

    expect(result).toContain('added');
    expect(added[0].taskAllowedDirs).toEqual([normalizePath(relDataDir)]);
  });

  it('omits the field entirely when allowedDirs is not declared (or empty)', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    await exec(tool, { title: 'T1', description: 'D' });
    await exec(tool, { title: 'T2', description: 'D', allowedDirs: [] });

    expect(added).toHaveLength(2);
    for (const task of added) {
      expect('taskAllowedDirs' in task).toBe(false);
      expect(task.taskAllowedDirs).toBeUndefined();
    }
  });

  it('rejects every entry when one is invalid (no partial grant)', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);
    const outside = makeDir(outsideRoot, 'elsewhere');

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [dataDir, outside],
    });

    expect(result).toContain(outside);
    expect(added).toHaveLength(0);
  });

  it('refuses allowedDirs when the home boundary is unknown', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added, { homeDir: undefined });

    const result = await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [dataDir],
    });

    expect(result).toContain('home directory is unknown');
    expect(added).toHaveLength(0);
  });
});

describe('allowedDirs display — list_tasks and get_task_detail', () => {
  it('shows dirs in the list and the detail when present', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    await exec(tool, {
      title: 'T',
      description: 'D',
      allowedDirs: [dataDir, cacheDir],
    });

    const listTool = listTasksTool({ listTasks: () => added });
    const listed = await exec(listTool, {});
    expect(listed).toContain(`dirs: ${normalizePath(dataDir)}, ${normalizePath(cacheDir)}`);

    const detailTool = getTaskDetailTool({ getTask: () => added[0] });
    const detail = await exec(detailTool, { taskId: added[0].id });
    expect(detail).toContain('Allowed dirs: ' + normalizePath(dataDir) + ', ' + normalizePath(cacheDir));
  });

  it('omits dirs everywhere when the task has none', async () => {
    const tasks = [makeTask('t-no-dirs', { status: 'pending' })];

    const listTool = listTasksTool({ listTasks: () => tasks });
    const listed = await exec(listTool, {});
    expect(listed).not.toContain('dirs:');

    const detailTool = getTaskDetailTool({ getTask: () => tasks[0] });
    const detail = await exec(detailTool, { taskId: 't-no-dirs' });
    expect(detail).not.toContain('Allowed dirs:');
  });
});
