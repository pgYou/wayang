/**
 * Resolve the list of directories to scan for skills.
 *
 * Resolution order (later directories override earlier ones on name conflict):
 *   1. Global:     `~/.wayang/skills`
 *   2. Project:    `<workspaceDir>/.wayang/skills`
 *   3. Config:     `config.skillsDirs` (user-provided, highest priority)
 *
 * Non-existent directories are silently skipped — a missing skills folder is
 * a normal state, not an error.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Compute the ordered list of existing skill directories.
 *
 * @param workspaceDir Current workspace root.
 * @param configDirs   Optional extra dirs from `config.skillsDirs`.
 * @returns Existing absolute paths, lowest priority first.
 */
export function resolveSkillDirs(workspaceDir: string, configDirs?: string[]): string[] {
  const candidates = [
    join(homedir(), '.wayang', 'skills'),
    join(workspaceDir, '.wayang', 'skills'),
    ...(configDirs ?? []).map((d) => resolve(d)),
  ];

  // Deduplicate (preserving order) and keep only existing directories.
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}
