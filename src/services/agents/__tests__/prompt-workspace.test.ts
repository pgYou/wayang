/**
 * Prompt-level workspace rules — the general workspace, the `.agents/tmp`
 * scratch convention, and the pre-dispatch decision (worker type, workspace,
 * allowedDirs, parallelism) are stated where the agent acts, not appended at
 * the end:
 *   - Controller: inside "Working principles", next to the other dispatch rules,
 *     with the general workspace's RESOLVED absolute path (never `~/…`).
 *   - Worker: inside "Execution strategy → File operations".
 *   - Third-party worker: a single line in its <Rules> block.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistry } from '@/services/skills/registry';
import { buildControllerSystemPrompt } from '@/services/agents/prompts/controller-prompt';
import { buildWorkerSystemPrompt } from '@/services/agents/prompts/worker-prompt';
import { buildThirdPartyPrompt } from '@/services/agents/prompts/third-party-prompt';
import { createMockCtx } from '@/__tests__/helpers';

let homeDir: string;
let sessionDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-prompt-ws-'));
  sessionDir = path.join(homeDir, '.wayang', 'sessions', 's-1');
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const generalWorkspace = () => path.join(homeDir, '.wayang', 'workspace');

describe('controller prompt — workspace rules', () => {
  it('carries the resolved general workspace path inside the working principles', () => {
    const prompt = buildControllerSystemPrompt(
      createMockCtx({ sessionDir, workspaceDir: homeDir }),
      new SkillRegistry([]),
    );

    expect(prompt).toContain(`用通用工作区 ${generalWorkspace()}`);
    // An absolute path, not the `~/…` spelling an agent would have to expand.
    const workspaceBlock = prompt.slice(prompt.indexOf('【工作区】'), prompt.indexOf('【分工与审核】'));
    expect(workspaceBlock).toContain(generalWorkspace());
    expect(workspaceBlock).not.toContain('~/.wayang');
  });

  it('tells the controller to route scratch files to .agents/tmp', () => {
    const prompt = buildControllerSystemPrompt(
      createMockCtx({ sessionDir, workspaceDir: homeDir }),
      new SkillRegistry([]),
    );

    expect(prompt).toContain('.agents/tmp/');
    expect(prompt).toContain('不要用 /tmp');
  });

  it('builds the prompt without creating the general workspace', () => {
    buildControllerSystemPrompt(createMockCtx({ sessionDir, workspaceDir: homeDir }), new SkillRegistry([]));
    expect(fs.existsSync(generalWorkspace())).toBe(false);
  });
});

describe('controller prompt — dispatch decision (worker, workspace, allowedDirs)', () => {
  const buildPrompt = () => buildControllerSystemPrompt(
    createMockCtx({ sessionDir, workspaceDir: homeDir }),
    new SkillRegistry([]),
  );
  // The dispatch rules live inside the 【工作区】 block, next to the workspace
  // selection rules they belong to — not in a section of their own.
  const workspaceBlock = (prompt: string) =>
    prompt.slice(prompt.indexOf('【工作区】'), prompt.indexOf('【分工与审核】'));

  it('settles worker type, workspace and allowedDirs as one pre-dispatch decision', () => {
    const block = workspaceBlock(buildPrompt());

    expect(block).toContain('派发前先定三件事');
    expect(block).toContain('claude-code 适合实现、重构、调试');
    expect(block).toContain('puppet 适合文件操作、检索、机械执行');
    expect(block).toContain('任务工作目录');
    expect(block).toContain('是否需要额外 allowedDirs');
  });

  it('demands an explicit workspace and allowedDirs at boundaries', () => {
    const block = workspaceBlock(buildPrompt());

    expect(block).toContain('任务在哪个目录干活就显式写 workspace');
    expect(block).toContain('跨仓库、跨 worktree、要读任务外目录时必须加 allowedDirs');
    expect(block).toContain('不声明会让 worker 每条命令都撞审批');
  });

  it('keeps same-workspace writes serial and different-worktree tasks parallel', () => {
    const prompt = buildPrompt();
    const block = workspaceBlock(prompt);

    expect(block).toContain('按依赖关系切分任务');
    expect(block).toContain('同一工作区内会写文件的任务必须串行');
    expect(block).toContain('不同 worktree 才并行');
    expect(block).toContain('不要把一个可并行的需求串成一条长链');
    // The old 【并行】 phrasing is gone: the rule is stated once, as part of
    // the dispatch decision, instead of twice in slightly different words.
    expect(prompt).not.toContain('只有独立工作区才能并行');
  });
});

describe('worker prompt — scratch file convention', () => {
  it('puts the .agents/tmp rule in the file-operations section', () => {
    const prompt = buildWorkerSystemPrompt(
      createMockCtx({ sessionDir, workspaceDir: homeDir }),
      new SkillRegistry([]),
      homeDir,
    );

    const fileOps = prompt.slice(prompt.indexOf('## File operations'), prompt.indexOf('## Web search'));
    expect(fileOps).toContain('.agents/tmp/');
    expect(fileOps).toContain('Never `/tmp`');
    expect(fileOps).toContain('confirm which workspace you are in');
  });

  it('separates durable output from one-off intermediates', () => {
    const prompt = buildWorkerSystemPrompt(createMockCtx({ workspaceDir: homeDir }), new SkillRegistry([]), homeDir);

    expect(prompt).toContain('Anything worth keeping goes to a normal path in the workspace');
    expect(prompt).toContain('one-off intermediates stay in `.agents/tmp/`');
  });

  it('makes the task-declared workspace outrank the worker\'s own assumptions', () => {
    const prompt = buildWorkerSystemPrompt(
      createMockCtx({ sessionDir, workspaceDir: homeDir }),
      new SkillRegistry([]),
      homeDir,
    );

    const fileOps = prompt.slice(prompt.indexOf('## File operations'), prompt.indexOf('## Web search'));
    expect(fileOps).toContain('that one outranks any path you assume');
    expect(fileOps).toContain('Do not override it with a location you merely think the project lives in');
  });

  it('tells the worker to state out-of-workspace needs up front instead of probing', () => {
    const prompt = buildWorkerSystemPrompt(
      createMockCtx({ sessionDir, workspaceDir: homeDir }),
      new SkillRegistry([]),
      homeDir,
    );

    const fileOps = prompt.slice(prompt.indexOf('## File operations'), prompt.indexOf('## Web search'));
    expect(fileOps).toContain('needs a path outside the task workspace');
    expect(fileOps).toContain('instead of probing repeatedly');
  });
});

describe('third-party prompt — scratch file convention', () => {
  it('states the .agents/tmp rule inside the rules block', () => {
    const prompt = buildThirdPartyPrompt(new SkillRegistry([]));

    const rules = prompt.slice(prompt.indexOf('<Rules>'), prompt.indexOf('</Rules>'));
    expect(rules).toContain('`.agents/tmp/` inside the task workspace');
    expect(rules).toContain('never `/tmp`');
  });
});
