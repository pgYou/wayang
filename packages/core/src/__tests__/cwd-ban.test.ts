/**
 * cwd 禁令 (monorepo-design 4.2 改造二) — fail-closed guards.
 *
 * Two layers, both static:
 *  1. a source scan over `packages/core/src` (excluding test files, which
 *     legitimately anchor fixtures on the vitest working directory): no
 *     `process.cwd()` call may survive anywhere in core source;
 *  2. the `scripts/check-boundaries.mjs` rule that enforces the same ban
 *     mechanically: it must pass on the current tree AND fail when a
 *     violating file is planted (the rule is real, not decorative).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const CORE_SRC = join(REPO_ROOT, 'packages', 'core', 'src');
const BOUNDARIES_SCRIPT = join(REPO_ROOT, 'scripts', 'check-boundaries.mjs');

const SOURCE_FILE = /\.ts$/;
const PROCESS_CWD = /process\s*\.\s*cwd\s*\(/;

function isTestFile(file: string): boolean {
  return file.split(sep).includes('__tests__') || /\.test\.ts$/.test(file);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

describe('core source cwd ban (design 4.2, fail-closed)', () => {
  it('packages/core/src contains no process.cwd() call outside test files', () => {
    const offenders = walk(CORE_SRC)
      .filter((file) => !isTestFile(file))
      .filter((file) => PROCESS_CWD.test(readFileSync(file, 'utf8')))
      .map((file) => relative(CORE_SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe('check-boundaries.mjs rule: core source must not call process.cwd()', () => {
  it('passes on the current tree and names the new rule', () => {
    const run = spawnSync('node', [BOUNDARIES_SCRIPT], { encoding: 'utf8', cwd: REPO_ROOT });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('core src has no process.cwd');
  });

  it('fails (exit 1) when a violating file is planted in core source', () => {
    const plant = join(CORE_SRC, 'tmp-cwd-violation-probe.ts');
    writeFileSync(plant, 'export const probe = process.cwd();\n', 'utf8');
    try {
      const run = spawnSync('node', [BOUNDARIES_SCRIPT], { encoding: 'utf8', cwd: REPO_ROOT });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('tmp-cwd-violation-probe.ts');
      expect(run.stderr).toContain('design 4.2');
    } finally {
      rmSync(plant, { force: true });
    }
    // The tree is clean again afterwards.
    const rerun = spawnSync('node', [BOUNDARIES_SCRIPT], { encoding: 'utf8', cwd: REPO_ROOT });
    expect(rerun.status).toBe(0);
  });
});
