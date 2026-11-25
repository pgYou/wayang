/**
 * C2 prompt tests — the "Available workers" section for `*-acp` rows
 * (05 §7): the capability tags stay, an `[acp:<provider>]` tag plus the
 * external-agent semantics hint is appended, and rows that are not in the
 * config never appear. The hints must describe the REAL tool surface (#84):
 * ACP = update_progress + ask_controller (no done/fail), claude-code =
 * ask_controller only.
 */
import { describe, it, expect } from 'vitest';
import { buildControllerSystemPrompt } from '@/services/agents/prompts/controller-prompt';
import { createMockCtx } from '@/__tests__/helpers';
import { SkillRegistry } from '@/services/skills/registry';
import type { WayangConfig, WorkerConfig } from '@wayang-ai/protocol/types/config';

const skills = new SkillRegistry([]);

function promptWith(workers?: Record<string, WorkerConfig>): string {
  const ctx = createMockCtx({
    config: { providers: {}, controller: {}, worker: {}, workers } as WayangConfig,
  });
  return buildControllerSystemPrompt(ctx, skills);
}

describe('buildControllerSystemPrompt: worker list for *-acp rows (05 §7)', () => {
  it('appends the [acp:<provider>] tag and the external-agent hint to configured ACP workers', () => {
    const prompt = promptWith({
      codebuddy: { type: 'codebuddy', description: 'Tencent CodeBuddy Code agent', capabilities: ['code', 'refactor', 'shell'] },
      opencode: { type: 'opencode', description: 'OpenCode (native ACP, experimental)' },
    });

    expect(prompt).toContain('`codebuddy` — Tencent CodeBuddy Code agent [code, refactor, shell] [acp:codebuddy]');
    expect(prompt).toContain('`opencode` — OpenCode (native ACP, experimental) [acp:opencode]');
    // The semantics hint rides along on the same line (05 §7) and names the
    // injected tools as they really are (#84).
    expect(prompt).toContain('external ACP agent: its injected tools are update_progress + ask_controller only');
    expect(prompt).toContain('no done/fail tool');
    expect(prompt).toContain('expresses completion by ending its turn and its last message is the result');
    expect(prompt).toContain('chat_worker messages are delivered at its next turn boundary');
    // The old, wrong claim is gone.
    expect(prompt).not.toContain('no update_progress/done tools');
  });

  it('lists no ACP tag when no ACP worker is configured', () => {
    const prompt = promptWith({
      'claude-code': { type: 'claude-code', description: 'Coding assistant', capabilities: ['code'] },
    });

    expect(prompt).toContain('`claude-code` — Coding assistant [code]');
    expect(prompt).not.toContain('[acp:');
    expect(prompt).not.toContain('external ACP agent');
    // #84: the claude-code row describes its real surface — ask_controller
    // only, no update_progress and no done/fail, progress from its own replies.
    expect(prompt).toContain('third-party Claude Code agent: its only injected tool is ask_controller');
    expect(prompt).toContain('no update_progress and no done/fail');
  });

  it('with no workers section at all, only puppet is listed', () => {
    const prompt = promptWith(undefined);

    expect(prompt).toContain('`puppet` —');
    expect(prompt).not.toContain('[acp:');
    expect(prompt).not.toContain('external ACP agent');
  });

  it('tags the generic acp row by its configured command', () => {
    const prompt = promptWith({
      mycli: { type: 'acp', command: 'my-cli', description: 'Any ACP-speaking CLI' },
    });

    expect(prompt).toContain('`mycli` — Any ACP-speaking CLI [acp:my-cli]');
    expect(prompt).toContain('external ACP agent: its injected tools are update_progress + ask_controller only');
  });

  it('falls back to the plain [acp:acp] tag when the generic row has no command', () => {
    const prompt = promptWith({
      mycli: { type: 'acp', description: 'Command stripped by tests' } as WorkerConfig,
    });

    expect(prompt).toContain('[acp:acp]');
  });
});
