/**
 * add_task workspace rules summary.
 *
 * The controller's system prompt is built once and shared, so a project's
 * rules file (AGENTS.md / CLAUDE.md) cannot live there: dispatching into
 * workspace B would then hand B's worker A's conventions. The rules therefore
 * travel with each dispatch — add_task appends a short summary of the TARGET
 * workspace's rules file, read fresh per call.
 *
 * Covered here: the lookup order, the two truncation caps, the permission gate
 * (a denylisted file is reported as unavailable, never read), the "no rules →
 * no noise" rule, and the cross-workspace isolation guarantee.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskDetail } from '@/types/index';
import { addTaskTool } from '@/services/tools/add-task';
import {
  WORKSPACE_RULES_MAX_CHARS,
  WORKSPACE_RULES_MAX_LINES,
} from '@/services/tools/workspace-rules';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

let homeDir: string;
let workspaceDir: string;
let otherWorkspaceDir: string;

function makeDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function makeTool(added: TaskDetail[] = [], deps: Record<string, unknown> = {}) {
  return addTaskTool({
    addTask: (t) => { added.push(t); return 'w-1'; },
    workspaceDir,
    homeDir,
    ...deps,
  });
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-ws-rules-home-'));
  workspaceDir = makeDir(homeDir, 'repo-a');
  otherWorkspaceDir = makeDir(homeDir, 'repo-b');
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('addTaskTool — workspace rules summary', () => {
  it('appends the AGENTS.md source path and its opening lines', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'AGENTS.md'),
      '# Repo A rules\n\nUse tabs.\nRun tests with npm test.\n',
    );

    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).toContain('added'); // the original confirmation is intact
    expect(result).toContain(`Workspace rules (from ${path.join(workspaceDir, 'AGENTS.md')}):`);
    expect(result).toContain('# Repo A rules');
    expect(result).toContain('Use tabs.');
    expect(result).toContain('Run tests with npm test.');
    expect(result).not.toContain('truncated');
  });

  it('falls back to CLAUDE.md when AGENTS.md is absent', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'Claude-side conventions.\n');

    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).toContain(`Workspace rules (from ${path.join(workspaceDir, 'CLAUDE.md')}):`);
    expect(result).toContain('Claude-side conventions.');
    expect(result).not.toContain('AGENTS.md');
  });

  it('prefers AGENTS.md over CLAUDE.md when both exist', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), 'from AGENTS');
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'from CLAUDE');

    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).toContain('from AGENTS');
    expect(result).not.toContain('from CLAUDE');
  });

  it('adds nothing at all when the workspace has no rules file', async () => {
    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).toContain('added');
    expect(result).not.toContain('Workspace rules');
    expect(result).not.toContain('AGENTS.md');
    expect(result).not.toContain('CLAUDE.md');
    expect(result).not.toContain('unavailable');
    expect(result).not.toContain('no rules');
  });

  it('ignores an empty rules file instead of emitting an empty section', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '   \n\n');

    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).not.toContain('Workspace rules');
  });

  it('truncates a long rules file by line count and reports the remainder', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `rule line ${i + 1}`);
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), `${lines.join('\n')}\n`);

    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).toContain('rule line 1');
    expect(result).toContain(`rule line ${WORKSPACE_RULES_MAX_LINES}`);
    // Line 41 and beyond are cut; the marker states exactly how many are left.
    expect(result).not.toContain(`rule line ${WORKSPACE_RULES_MAX_LINES + 1}`);
    expect(result).not.toContain('rule line 60');
    expect(result).toContain(`truncated (${60 - WORKSPACE_RULES_MAX_LINES} more lines)`);
  });

  it('also truncates by character count when the file is one huge line', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), 'x'.repeat(WORKSPACE_RULES_MAX_CHARS + 500));

    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).toContain('truncated');
    expect(result).toContain(`exceeded ${WORKSPACE_RULES_MAX_CHARS} characters`);
    expect(result).not.toContain('x'.repeat(WORKSPACE_RULES_MAX_CHARS + 1));
  });

  it('reports a denylisted rules file as unavailable without reading it', async () => {
    const sshDir = makeDir(homeDir, '.ssh');
    const secret = path.join(sshDir, 'id_rsa_notes.md');
    fs.writeFileSync(secret, 'TOP-SECRET-KEY-MATERIAL');
    // The rules path itself looks innocuous; only the symlink target is denied.
    fs.symlinkSync(secret, path.join(workspaceDir, 'AGENTS.md'));

    const result = await exec(makeTool(), { title: 'T', description: 'D' });

    expect(result).toContain(`Workspace rules (from ${path.join(workspaceDir, 'AGENTS.md')}):`);
    expect(result).toContain('unavailable');
    expect(result).toContain('denied');
    // Neither the content nor the resolved location leaks.
    expect(result).not.toContain('TOP-SECRET-KEY-MATERIAL');
    expect(result).not.toContain('.ssh');
  });

  it('reports unavailable (not "no rules") when the policy cannot be evaluated', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), 'rules that must not be read unguarded');

    const result = await exec(makeTool([], { homeDir: undefined }), { title: 'T', description: 'D' });

    expect(result).toContain('unavailable');
    expect(result).not.toContain('rules that must not be read unguarded');
  });

  it('honours configured deniedDirs for the rules read', async () => {
    const vault = makeDir(homeDir, 'vault');
    fs.writeFileSync(path.join(vault, 'AGENTS.md'), 'vault rules');
    const tool = addTaskTool({
      addTask: () => 'w-1',
      workspaceDir: vault,
      homeDir,
      permissionConfig: { deniedDirs: [vault] },
    });

    const result = await exec(tool, { title: 'T', description: 'D' });

    expect(result).toContain('unavailable');
    expect(result).not.toContain('vault rules');
  });

  it('keeps each workspace\'s rules out of the other\'s result', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), 'REPO-A-ONLY-RULE: use tabs');
    fs.writeFileSync(path.join(otherWorkspaceDir, 'AGENTS.md'), 'REPO-B-ONLY-RULE: use spaces');

    const tool = makeTool();

    const resultA = await exec(tool, { title: 'A', description: 'D' });
    const resultB = await exec(tool, { title: 'B', description: 'D', workspace: otherWorkspaceDir });

    expect(resultA).toContain('REPO-A-ONLY-RULE');
    expect(resultA).not.toContain('REPO-B-ONLY-RULE');
    expect(resultA).toContain(path.join(workspaceDir, 'AGENTS.md'));

    expect(resultB).toContain('REPO-B-ONLY-RULE');
    expect(resultB).not.toContain('REPO-A-ONLY-RULE');
    expect(resultB).toContain(path.join(otherWorkspaceDir, 'AGENTS.md'));
  });

  it('does not cache rules: a later edit in the same workspace is picked up', async () => {
    const rulesFile = path.join(workspaceDir, 'AGENTS.md');
    fs.writeFileSync(rulesFile, 'FIRST-VERSION');
    const tool = makeTool();

    const before = await exec(tool, { title: 'T1', description: 'D' });
    fs.writeFileSync(rulesFile, 'SECOND-VERSION');
    const after = await exec(tool, { title: 'T2', description: 'D' });

    expect(before).toContain('FIRST-VERSION');
    expect(before).not.toContain('SECOND-VERSION');
    expect(after).toContain('SECOND-VERSION');
    expect(after).not.toContain('FIRST-VERSION');
  });

  it('appends the summary on the queued path too, and never in the system prompt', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), 'QUEUED-RULES');

    const tool = addTaskTool({
      addTask: () => undefined, // all slots busy → queued
      workspaceDir,
      homeDir,
    });

    const result = await exec(tool, { title: 'T', description: 'D' });

    expect(result).toContain('queued');
    expect(result).toContain('QUEUED-RULES');
  });
});
