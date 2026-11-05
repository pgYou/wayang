/**
 * add_task workspace declaration — home expansion and directory creation.
 *
 * A declared workspace arrives as plain text with no shell in between, so
 * `~` / `$HOME` must be expanded here, an absolute path that does not exist
 * yet must be created, and an unexpandable `~user` form must fail the call
 * instead of quietly landing the task in the default workspace.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDetail } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import { normalizeWorkspacePath } from '@/infra/workspace-registry';

let userHome: string;
let workspaceDir: string;
let generalWorkspaceDir: string;
let realHome: string | undefined;

function makeDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-addtask-home-'));
  workspaceDir = makeDir(userHome, 'repo');
  generalWorkspaceDir = path.join(userHome, '.wayang', 'workspace');
  // `~` / `$HOME` expand against the PROCESS home (os.homedir() reads $HOME
  // on POSIX), so point $HOME at the temp home these tests declare.
  realHome = process.env.HOME;
  process.env.HOME = userHome;
});

afterEach(() => {
  fs.rmSync(userHome, { recursive: true, force: true });
  process.env.HOME = realHome;
});

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

function makeTool(added: TaskDetail[]) {
  return addTaskTool({
    addTask: (t) => { added.push(t); return 'w-1'; },
    workspaceDir,
    wayangDir: path.join(userHome, '.wayang'),
    userHome,
    generalWorkspaceDir,
  });
}

describe('addTaskTool — home expansion in a declared workspace', () => {
  it('expands a bare "~" to the home directory', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: '~' });

    expect(result).toContain('added');
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(userHome));
  });

  it('expands "~/…" to an absolute path under home and creates it', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: '~/.wayang/workspace' });

    expect(result).toContain('added');
    // Expanded against the injected home, NOT a literal directory named "~".
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(generalWorkspaceDir));
    expect(fs.existsSync(generalWorkspaceDir)).toBe(true);
  });

  it('expands "$HOME/…" and "${HOME}/…" the same way', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    for (const workspace of ['$HOME/.wayang/workspace', '${HOME}/.wayang/workspace']) {
      const result = await exec(tool, { title: 'T', description: 'D', workspace });
      expect(result).toContain('added');
    }

    expect(added).toHaveLength(2);
    for (const task of added) {
      expect(task.workspace?.path).toBe(normalizeWorkspacePath(generalWorkspaceDir));
    }
    expect(fs.existsSync(generalWorkspaceDir)).toBe(true);
  });

  it('leaves an existing absolute path as it is', async () => {
    const existing = makeDir(userHome, 'notes');
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: existing });

    expect(result).toContain('added');
    expect(added[0].workspace?.path).toBe(existing);
    expect(added[0].workspace?.slug).toBe('notes');
  });

  it('creates a missing absolute workspace instead of falling back to the default', async () => {
    const missing = path.join(userHome, 'fresh-dir', 'nested');
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: missing });

    expect(result).toContain('added');
    expect(fs.statSync(missing).isDirectory()).toBe(true);
    // The task targets the declared directory — never the process workspace.
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(missing));
    expect(added[0].workspace?.path).not.toBe(normalizeWorkspacePath(workspaceDir));
  });

  it('rejects a "~user" form: no task is created', async () => {
    const addTask = vi.fn((_t: TaskDetail) => 'w-1');
    const tool = addTaskTool({ addTask, workspaceDir, userHome, generalWorkspaceDir });

    const result = await exec(tool, { title: 'T', description: 'D', workspace: '~someone/notes' });

    expect(result).toContain('Cannot resolve workspace');
    expect(result).toContain('The task was NOT created');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports a clear error when the directory cannot be created (path blocked by a file)', async () => {
    const blocked = path.join(userHome, 'blocker');
    fs.writeFileSync(blocked, 'not a directory');
    const addTask = vi.fn((_t: TaskDetail) => 'w-1');
    const tool = addTaskTool({ addTask, workspaceDir, userHome, generalWorkspaceDir });

    const result = await exec(tool, { title: 'T', description: 'D', workspace: path.join(blocked, 'sub') });

    expect(result).toContain('Cannot create workspace');
    expect(result).toContain('The task was NOT created');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('still resolves a relative declaration against the process workspace', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added);
    const relative = path.relative(process.cwd(), workspaceDir);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: relative });

    expect(result).toContain('added');
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(workspaceDir));
  });
});

describe('addTaskTool — general workspace is advertised by absolute path', () => {
  it('names the resolved path, not a "~/…" literal', () => {
    const tool: any = makeTool([]);
    const description: string = tool.inputSchema.shape.workspace.description;

    expect(description).toContain(generalWorkspaceDir);
    expect(description).toContain('no codebase');
    expect(description).not.toContain('~/');
  });
});
