/**
 * Project rules discovery — AGENTS.md / CLAUDE.md lookup for worker prompts.
 *
 * Workers execute tasks inside a workspace that usually belongs to some
 * project with its own conventions. Those conventions live in a rules file
 * (AGENTS.md, or the older CLAUDE.md) that the worker would otherwise have
 * to discover by hand. This module finds the file closest to the task cwd
 * and turns it into a prompt section.
 *
 * Only the puppet worker injects this section. Third-party workers (e.g.
 * Claude Code) are left to their own configuration loading — see the note
 * in claude-code-worker.ts.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { section } from './prompt-utils';

/** Candidate file names, in priority order — AGENTS.md wins over CLAUDE.md. */
const RULE_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Maximum directory levels to check, starting at the task cwd itself.
 * Bounds the walk so a rules file far above the workspace is not pulled in.
 */
const MAX_LEVELS = 5;

/** Hard cap on injected rules content (characters). */
export const PROJECT_RULES_MAX_LENGTH = 8000;

export interface ProjectRules {
  /** Absolute path of the file the rules were read from. */
  path: string;
  /** File content (untruncated — truncation happens at section build time). */
  content: string;
}

/**
 * Find the project rules file for a task.
 *
 * Walks up from `startDir` for at most MAX_LEVELS levels, checking each
 * directory for AGENTS.md first, then CLAUDE.md; the first hit wins. The
 * walk never crosses a git repository root (a directory containing `.git` —
 * a file for worktrees, a directory otherwise) and stops at the filesystem
 * root. Empty/unreadable files are treated as absent so they never produce
 * an empty prompt section.
 */
export function findProjectRules(startDir: string): ProjectRules | null {
  let current = resolve(startDir);
  for (let level = 0; level < MAX_LEVELS; level++) {
    const found = readRuleFile(current);
    if (found) return found;
    // Never look above the repository the task lives in.
    if (existsSync(join(current, '.git'))) break;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  return null;
}

/** Read the first non-empty rules file in `dir`, AGENTS.md before CLAUDE.md. */
function readRuleFile(dir: string): ProjectRules | null {
  for (const name of RULE_FILE_NAMES) {
    const path = join(dir, name);
    try {
      // statSync rejects directories named AGENTS.md and missing files alike.
      if (!statSync(path).isFile()) continue;
      const content = readFileSync(path, 'utf8');
      if (!content.trim()) continue;
      return { path, content };
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }
  return null;
}

/**
 * Build the "Project rules" prompt section.
 *
 * Returns an empty string when `rules` is null so `assemble()` drops the
 * section entirely — no rules file, no empty paragraph in the prompt.
 */
export function buildProjectRulesSection(rules: ProjectRules | null): string {
  if (!rules) return '';
  const name = basename(rules.path);
  const truncated = rules.content.length > PROJECT_RULES_MAX_LENGTH;
  const content = truncated
    ? `${rules.content.slice(0, PROJECT_RULES_MAX_LENGTH).trimEnd()}\n\n...truncated (rules file exceeded ${PROJECT_RULES_MAX_LENGTH} characters)`
    : rules.content.trimEnd();

  return section(
    `Project rules (${name})`,
    `Rules from this project's ${name}. They apply to all work on the task — follow them unless the task description explicitly overrides them.\n\nSource: ${rules.path}\n\n${content}`,
  );
}
