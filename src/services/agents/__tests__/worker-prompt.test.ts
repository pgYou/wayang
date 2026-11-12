/**
 * Worker prompt — closing contract (done/fail).
 *
 * A puppet run that ends without calling done/fail is judged failed by the
 * engine (worker-agent.ts), and a large share of sampled runs ended exactly
 * that way. The Mandatory termination block is the prompt-side fix: these
 * assertions pin the closing-contract key sentence and the done/fail
 * semantics so they cannot silently regress.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistry } from '@/services/skills/registry';
import { buildWorkerSystemPrompt } from '@/services/agents/prompts/worker-prompt';
import { createMockCtx } from '@/__tests__/helpers';

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-prompt-close-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('worker prompt — closing contract', () => {
  it('requires exactly one done/fail closing call with clear semantics, a self-check, and no silent ending', () => {
    const prompt = buildWorkerSystemPrompt(
      createMockCtx({ sessionDir: path.join(homeDir, '.wayang', 'sessions', 's-1'), workspaceDir: homeDir }),
      new SkillRegistry([]),
      homeDir,
    );
    const block = prompt.slice(prompt.indexOf('## Mandatory termination'), prompt.indexOf('## Planning'));

    // The closing-contract key sentence: exactly one closing call, no exceptions.
    expect(block).toContain('Every run MUST end with exactly one call to `done` or `fail`');
    // done semantics: completed → conclusion summary (what changed / verified /
    // leftover); an explanation is not a completion.
    expect(block).toContain('`done(summary)`');
    expect(block).toContain('what changed');
    expect(block).toContain('Explaining what you did is NOT completing the task');
    // fail semantics: cannot complete → the reason plus the finished part.
    expect(block).toContain('`fail(error)`');
    expect(block).toContain('the reason and the part you did finish');
    // Self-check trigger before a tool-less final reply.
    expect(block).toContain('no tool calls');
    expect(block).toContain('the task is not finished; keep working');
    // No silent ending — the engine judges a text-only ending as a failure —
    // and no masking incompletion with done.
    expect(block).toContain('Never end silently');
    expect(block).toContain('judged a failure by the engine');
    expect(block).toContain('must not be reported as `done`');
    // Long tasks report one line per verifiable step, not saved for the end.
    expect(prompt).toContain('one update_progress line per verifiable step as it lands');
  });
});
