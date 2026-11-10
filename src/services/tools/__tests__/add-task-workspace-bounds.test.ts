/**
 * add_task workspace boundary validation (issue #77).
 *
 * A declared workspace used to be mkdir'd and stamped with no boundary check
 * at all: /etc, a symlink out of the home, ~/.ssh — anything became the task
 * workspace and thereby "inside scope, allow". Covered here:
 *
 * - a declaration resolving OUTSIDE the user home is rejected, and the
 *   directory is NOT created (validate before mkdir);
 * - a symlink is judged by its realpath target, not its spelling;
 * - the denied-path / sensitive list (built-in ~/.ssh ~/.aws, plus configured
 *   sensitiveDirs) rejects a declaration even inside the home;
 * - a missing directory INSIDE the home is created and admitted;
 * - a relative declaration resolves against the process workspace first and
 *   then goes through the same check;
 * - a declaration without a known home is rejected outright (fail closed,
 *   mirroring allowedDirs).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskDetail } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import { normalizePath } from '@/infra/permission/policy';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

let userHome: string;
let outsideRoot: string;
let workspaceDir: string;

function makeDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-ws-bounds-home-'));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-ws-bounds-out-'));
  workspaceDir = makeDir(userHome, 'repo');
});

afterEach(() => {
  fs.rmSync(userHome, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

function makeTool(added: TaskDetail[], deps: { userHome?: string } = {}) {
  return addTaskTool({
    addTask: (t) => { added.push(t); return 'w-1'; },
    workspaceDir,
    userHome,
    ...deps,
  });
}

describe('addTaskTool — workspace boundary (issue #77)', () => {
  it('rejects a workspace outside the home directory and creates nothing', async () => {
    const target = path.join(outsideRoot, 'sneaky', 'sub'); // does not exist
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: target });

    expect(result).toContain('outside-home');
    expect(result).toContain('NOT created');
    expect(result).toContain('allowedDirs'); // the actionable alternative
    expect(added).toHaveLength(0);
    // Validate before mkdir: the rejected directory was never materialized.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(outsideRoot, 'sneaky'))).toBe(false);
  });

  it('rejects a symlink whose realpath target is outside the home directory', async () => {
    const target = makeDir(outsideRoot, 'real-target');
    const linkPath = path.join(userHome, 'innocent-link'); // spelled inside home
    fs.symlinkSync(target, linkPath, 'dir');

    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: linkPath });

    expect(result).toContain('outside-home');
    expect(result).toContain(normalizePath(target)); // judged by where it lands
    expect(added).toHaveLength(0);
  });

  it('rejects a workspace that hits the denied-path / sensitive list', async () => {
    fs.mkdirSync(path.join(userHome, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(userHome, '.aws'), { recursive: true });

    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    for (const denied of [
      path.join(userHome, '.ssh'), // built-in
      path.join(userHome, '.ssh', 'ops'), // anything beneath it
      path.join(userHome, '.aws'),
    ]) {
      const result = await exec(tool, { title: 'T', description: 'D', workspace: denied });
      expect(result).toContain('denied-path');
      expect(result).toContain('NOT created');
    }
    expect(added).toHaveLength(0);
    expect(fs.existsSync(path.join(userHome, '.ssh', 'ops'))).toBe(false);
  });

  it('creates and accepts a missing workspace inside the home directory', async () => {
    const target = path.join(userHome, 'fresh', 'nested'); // does not exist
    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const result = await exec(tool, { title: 'T', description: 'D', workspace: target });

    expect(result).toContain('added');
    expect(added).toHaveLength(1);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(added[0].workspace?.path).toBe(fs.realpathSync(target));
  });

  it('validates a relative declaration after resolving it against the process workspace', async () => {
    const inHome = makeDir(userHome, 'rel-target'); // resolves back inside home
    const outside = makeDir(outsideRoot, 'rel-outside');

    const added: TaskDetail[] = [];
    const tool = makeTool(added);

    const ok = await exec(tool, {
      title: 'T', description: 'D', workspace: path.relative(process.cwd(), inHome),
    });
    expect(ok).toContain('added');
    expect(added[0].workspace?.path).toBe(normalizePath(inHome));

    const rejected = await exec(tool, {
      title: 'T', description: 'D', workspace: path.relative(process.cwd(), outside),
    });
    expect(rejected).toContain('outside-home');
    expect(rejected).toContain('NOT created');
    expect(added).toHaveLength(1); // only the in-home one was created
  });

  it('rejects a declared workspace when the home directory is unknown (fail closed)', async () => {
    const added: TaskDetail[] = [];
    const tool = makeTool(added, { userHome: undefined });

    const result = await exec(tool, {
      title: 'T', description: 'D', workspace: path.join(userHome, 'somewhere'),
    });

    expect(result).toContain('the home directory is unknown');
    expect(result).toContain('NOT created');
    expect(added).toHaveLength(0);
    expect(fs.existsSync(path.join(userHome, 'somewhere'))).toBe(false);
  });
});
