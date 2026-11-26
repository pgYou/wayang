import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail } from '@wayang-ai/protocol';
import { addTaskTool } from '../add-task';
import { normalizeWorkspacePath } from '../../../infra/workspace-registry';

/**
 * add_task 无 workspace 声明时的硬缺省（`WorkspacePolicy.undeclaredTaskWorkspace`）：
 * desktop 注入 general workspace，无 codebase 的任务不再落到 controller workspace（home）；
 * CLI 不注入（deps.undeclaredWorkspace 缺省）→ 保持「启动目录」语义（既有行为，别处钉住）。
 */

let dir: string;
let home: string;
let workspaceDir: string;
let generalWorkspaceDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wayang-undeclared-ws-'));
  home = dir;
  workspaceDir = join(dir, 'repo');
  mkdtempSync(workspaceDir);
  generalWorkspaceDir = join(dir, '.agents', 'wayang-workspace');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeTool(added: TaskDetail[], undeclaredWorkspace?: string) {
  return addTaskTool({
    addTask: (t) => {
      added.push(t);
      return 'w-1';
    },
    workspaceDir,
    wayangDir: join(home, '.wayang'),
    userHome: home,
    generalWorkspaceDir,
    undeclaredWorkspace,
  });
}

describe('addTaskTool — undeclared workspace hard default', () => {
  it('an undeclared call runs in the injected general workspace (created on first use)', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added, generalWorkspaceDir);

    const result = await tool.execute({ title: 'T', description: 'D' });

    expect(result).toContain('added');
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(generalWorkspaceDir));
    expect(existsSync(generalWorkspaceDir)).toBe(true);
  });

  it('an explicit declaration still wins over the hard default', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added, generalWorkspaceDir);

    const result = await tool.execute({ title: 'T', description: 'D', workspace: workspaceDir });

    expect(result).toContain('added');
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(workspaceDir));
  });

  it('without the injection the dispatch baseline semantics stay (the controller workspace)', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added, undefined);

    const result = await tool.execute({ title: 'T', description: 'D' });

    expect(result).toContain('added');
    expect(added[0].workspace?.path).toBe(normalizeWorkspacePath(workspaceDir));
    expect(existsSync(generalWorkspaceDir)).toBe(false);
  });
});
