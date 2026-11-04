/**
 * Prompt-level workspace rules — the general workspace and the `.agents/tmp`
 * scratch convention are stated where the agent acts, not appended at the end:
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
});

describe('third-party prompt — scratch file convention', () => {
  it('states the .agents/tmp rule inside the rules block', () => {
    const prompt = buildThirdPartyPrompt(new SkillRegistry([]));

    const rules = prompt.slice(prompt.indexOf('<Rules>'), prompt.indexOf('</Rules>'));
    expect(rules).toContain('`.agents/tmp/` inside the task workspace');
    expect(rules).toContain('never `/tmp`');
  });
});
