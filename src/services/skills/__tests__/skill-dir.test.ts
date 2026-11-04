/**
 * resolveSkillDirs — the global skills directory follows the WAYANG data dir
 * (0.8.4), not the process home: a custom `--wayang-root` relocates skills
 * with the rest of wayang's state.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSkillDirs } from '@/services/skills/skill-dir';

let dataDir: string;
let workspaceDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wayang-skills-data-'));
  workspaceDir = mkdtempSync(join(tmpdir(), 'wayang-skills-ws-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe('resolveSkillDirs', () => {
  it('places the global dir under the wayang data dir, not the process home', () => {
    mkdirSync(join(dataDir, 'skills'), { recursive: true });
    mkdirSync(join(workspaceDir, '.wayang', 'skills'), { recursive: true });

    const dirs = resolveSkillDirs(dataDir, workspaceDir);
    expect(dirs).toEqual([
      join(dataDir, 'skills'),
      join(workspaceDir, '.wayang', 'skills'),
    ]);
  });

  it('config dirs come last and missing dirs are skipped', () => {
    mkdirSync(join(dataDir, 'skills'), { recursive: true });
    const configDir = mkdtempSync(join(tmpdir(), 'wayang-skills-cfg-'));
    try {
      mkdirSync(configDir, { recursive: true });
      const dirs = resolveSkillDirs(dataDir, workspaceDir, [configDir, '/nonexistent-skills-dir']);
      expect(dirs).toEqual([join(dataDir, 'skills'), configDir]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
