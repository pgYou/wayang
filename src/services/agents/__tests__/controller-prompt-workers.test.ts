/**
 * C2 prompt tests — the "Available workers" section for `*-acp` rows
 * (05 §7): the capability tags stay, an `[acp:<provider>]` tag plus the
 * external-agent semantics hint is appended, and rows that are not in the
 * config never appear.
 */
import { describe, it, expect } from 'vitest';
import { buildControllerSystemPrompt } from '@/services/agents/prompts/controller-prompt';
import { createMockCtx } from '@/__tests__/helpers';
import { SkillRegistry } from '@/services/skills/registry';
import type { WayangConfig, WorkerConfig } from '@/types/config';

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
      codebuddy: { type: 'codebuddy-acp', description: 'Tencent CodeBuddy Code agent', capabilities: ['code', 'refactor', 'shell'] },
      opencode: { type: 'opencode-acp', description: 'OpenCode (native ACP, experimental)' },
    });

    expect(prompt).toContain('`codebuddy` — Tencent CodeBuddy Code agent [code, refactor, shell] [acp:codebuddy]');
    expect(prompt).toContain('`opencode` — OpenCode (native ACP, experimental) [acp:opencode]');
    // The semantics hint rides along on the same line (05 §7).
    expect(prompt).toContain('external ACP agent: no update_progress/done tools');
    expect(prompt).toContain('chat_worker messages are delivered at its next turn boundary');
  });

  it('lists no ACP tag when no ACP worker is configured', () => {
    const prompt = promptWith({
      'claude-code': { type: 'claude-code', description: 'Coding assistant', capabilities: ['code'] },
    });

    expect(prompt).toContain('`claude-code` — Coding assistant [code]');
    expect(prompt).not.toContain('[acp:');
    expect(prompt).not.toContain('external ACP agent');
  });

  it('with no workers section at all, only puppet is listed', () => {
    const prompt = promptWith(undefined);

    expect(prompt).toContain('`puppet` —');
    expect(prompt).not.toContain('[acp:');
    expect(prompt).not.toContain('external ACP agent');
  });
});
