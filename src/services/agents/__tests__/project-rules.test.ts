import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findProjectRules,
  buildProjectRulesSection,
  PROJECT_RULES_MAX_LENGTH,
} from '@/services/agents/prompts/project-rules';
import { buildWorkerSystemPrompt } from '@/services/agents/prompts/worker-prompt';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';

/** Create a self-contained temp directory tree, removed via the returned cleanup. */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wayang-rules-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Marker file that makes a directory look like a git root (worktree style: `.git` is a file). */
function markGitRoot(dir: string): void {
  writeFileSync(join(dir, '.git'), 'gitdir: /nowhere\n');
}

describe('findProjectRules', () => {
  it('finds AGENTS.md in the task directory', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'Always answer in rhyme.');
      const rules = findProjectRules(dir);
      expect(rules).not.toBeNull();
      expect(rules!.path).toBe(join(dir, 'AGENTS.md'));
      expect(rules!.content).toBe('Always answer in rhyme.');
    } finally {
      cleanup();
    }
  });

  it('prefers AGENTS.md over CLAUDE.md in the same directory', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'from AGENTS.md');
      writeFileSync(join(dir, 'CLAUDE.md'), 'from CLAUDE.md');
      const rules = findProjectRules(dir);
      expect(rules?.path).toBe(join(dir, 'AGENTS.md'));
      expect(rules?.content).toBe('from AGENTS.md');
    } finally {
      cleanup();
    }
  });

  it('falls back to CLAUDE.md when AGENTS.md is absent', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), 'from CLAUDE.md');
      const rules = findProjectRules(dir);
      expect(rules?.path).toBe(join(dir, 'CLAUDE.md'));
      expect(rules?.content).toBe('from CLAUDE.md');
    } finally {
      cleanup();
    }
  });

  it('treats an empty rules file as absent and falls through to the next candidate', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '   \n');
      writeFileSync(join(dir, 'CLAUDE.md'), 'real rules');
      const rules = findProjectRules(dir);
      expect(rules?.path).toBe(join(dir, 'CLAUDE.md'));
    } finally {
      cleanup();
    }
  });

  it('walks up parent directories to find the rules file', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'root rules');
      const nested = join(dir, 'a', 'b', 'c');
      mkdirSync(nested, { recursive: true });
      const rules = findProjectRules(nested);
      expect(rules?.path).toBe(join(dir, 'AGENTS.md'));
    } finally {
      cleanup();
    }
  });

  it('stops at the git repository root without crossing it', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      // Rules live ABOVE the git root — must not be found from inside.
      writeFileSync(join(dir, 'AGENTS.md'), 'outside rules');
      const repoRoot = join(dir, 'repo');
      mkdirSync(repoRoot);
      markGitRoot(repoRoot);
      const rules = findProjectRules(join(repoRoot, 'inner'));
      expect(rules).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('checks the git repository root itself but not above it', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const repoRoot = join(dir, 'repo');
      mkdirSync(repoRoot);
      markGitRoot(repoRoot);
      writeFileSync(join(repoRoot, 'CLAUDE.md'), 'repo rules');
      const rules = findProjectRules(join(repoRoot, 'inner'));
      expect(rules?.path).toBe(join(repoRoot, 'CLAUDE.md'));
    } finally {
      cleanup();
    }
  });

  it('gives up after the maximum number of levels', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'too far away');
      // Five levels below the file: the walk checks 5,4,3,2,1 and never
      // reaches the directory holding the rules file.
      const deep = join(dir, '1', '2', '3', '4', '5');
      mkdirSync(deep, { recursive: true });
      const rules = findProjectRules(deep);
      expect(rules).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns null when no rules file exists', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      // Git-root marker keeps the walk inside the temp dir (hermetic).
      markGitRoot(dir);
      expect(findProjectRules(dir)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('buildProjectRulesSection', () => {
  it('renders heading, source path and content', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'rule one\nrule two');
      const sectionText = buildProjectRulesSection(findProjectRules(dir));
      expect(sectionText).toContain('# Project rules (AGENTS.md)');
      expect(sectionText).toContain(`Source: ${join(dir, 'AGENTS.md')}`);
      expect(sectionText).toContain('rule one\nrule two');
    } finally {
      cleanup();
    }
  });

  it('labels CLAUDE.md-sourced rules accordingly', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), 'claude rules');
      const sectionText = buildProjectRulesSection(findProjectRules(dir));
      expect(sectionText).toContain('# Project rules (CLAUDE.md)');
    } finally {
      cleanup();
    }
  });

  it('returns an empty string when no rules were found', () => {
    expect(buildProjectRulesSection(null)).toBe('');
  });

  it('truncates oversized content with a marker', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(PROJECT_RULES_MAX_LENGTH + 1000));
      const sectionText = buildProjectRulesSection(findProjectRules(dir));
      expect(sectionText).toContain('...truncated');
      expect(sectionText).toContain(`exceeded ${PROJECT_RULES_MAX_LENGTH} characters`);
      // Exactly the cap survives — the overflow does not.
      expect(sectionText).toContain('x'.repeat(PROJECT_RULES_MAX_LENGTH));
      expect(sectionText).not.toContain('x'.repeat(PROJECT_RULES_MAX_LENGTH + 1));
    } finally {
      cleanup();
    }
  });
});

describe('buildWorkerSystemPrompt project-rules injection', () => {
  const skills = new SkillRegistry([]);

  it('injects the rules section when the workspace has an AGENTS.md', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'Use tabs, not spaces.');
      const prompt = buildWorkerSystemPrompt(createMockCtx({ workspaceDir: dir }), skills);
      expect(prompt).toContain('# Project rules (AGENTS.md)');
      expect(prompt).toContain(`Source: ${join(dir, 'AGENTS.md')}`);
      expect(prompt).toContain('Use tabs, not spaces.');
      // Sits right after the generic conventions section.
      expect(prompt.indexOf('# Project conventions')).toBeLessThan(prompt.indexOf('# Project rules'));
    } finally {
      cleanup();
    }
  });

  it('injects nothing when the workspace has no rules file', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      markGitRoot(dir);
      const prompt = buildWorkerSystemPrompt(createMockCtx({ workspaceDir: dir }), skills);
      expect(prompt).not.toContain('Project rules');
      expect(prompt).not.toContain('Source:');
    } finally {
      cleanup();
    }
  });
});
