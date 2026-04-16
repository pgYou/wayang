/**
 * Prompt building utilities — atomic sections assembled at call time.
 *
 * Each builder returns a plain string section. The assemble() helper joins
 * non-empty sections with double newlines and trims trailing whitespace.
 */

import { SystemContext } from '@/infra/system-context';
import os from 'node:os';

/** Join non-empty sections into a single prompt string. */
export function assemble(...sections: (string | undefined | null | false)[]): string {
  return sections
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');
}

/** Wrap a titled section. Returns empty string if body is empty. */
export function section(title: string, body: string): string {
  if (!body.trim()) return '';
  return `# ${title}\n\n${body.trim()}`;
}

/** Build a markdown-style key-value block from an object. */
export function kvBlock(pairs: Record<string, string | number | undefined | null>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Shared environment section builder
// ---------------------------------------------------------------------------

export interface EnvironmentExtra {
  /** Additional key-value lines appended after the common info. */
  extras?: Record<string, string | number | undefined | null>;
}

/**
 * Build the "Environment" section shared by Controller and Worker prompts.
 *
 * Includes date, OS info, shell, home directory, and current working directory.
 * Callers can pass extra key-value pairs (e.g. taskId, workspace) via `opts.extras`.
 */
export function buildEnvironment(ctx: SystemContext, opts?: EnvironmentExtra): string {
  const now = new Date();
  const date = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });

  const shell = process.env.SHELL || 'unknown';
  const shellName = shell.split('/').pop() ?? shell;

  const pairs: Record<string, string | number | undefined | null> = {
    'Date': `${date} (${weekday})`,
    'OS': `${os.platform()} (${os.arch()})`,
    'Shell': `${shellName} (${shell})`,
    'Home': os.homedir(),
    'WorkspaceDir': ctx.workspaceDir ?? process.cwd(),
    ...opts?.extras,
  };

  return section('Environment', kvBlock(pairs));
}
