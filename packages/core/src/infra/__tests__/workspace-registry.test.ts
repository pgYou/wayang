/**
 * WorkspaceRegistry tests — slug assignment, collision suffixes, stability,
 * atomic persistence and corrupt-file handling.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findWorkspace,
  getOrCreateWorkspace,
  listWorkspaces,
  normalizeWorkspacePath,
  registryFilePath,
  resolveWorkspaceRef,
  workspaceSlugFromPath,
} from '@/infra/workspace-registry';
import type { WorkspaceRegistryFile } from '@/infra/workspace-registry';

let wayangDir: string;
let scratchDir: string;

function makeDir(...segments: string[]): string {
  const dir = path.join(scratchDir, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function readRawRegistry(): WorkspaceRegistryFile {
  return JSON.parse(fs.readFileSync(registryFilePath(wayangDir), 'utf-8')) as WorkspaceRegistryFile;
}

beforeEach(() => {
  wayangDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-wsreg-home-'));
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-wsreg-repos-'));
});

afterEach(() => {
  fs.rmSync(wayangDir, { recursive: true, force: true });
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('workspaceSlugFromPath — slug rules', () => {
  it('keeps a plain lowercase name as-is', () => {
    expect(workspaceSlugFromPath('/home/dev/my-repo')).toBe('my-repo');
  });

  it('turns spaces into single dashes', () => {
    expect(workspaceSlugFromPath('/home/dev/My   Project')).toBe('my-project');
  });

  it('handles non-ASCII names by slugging the ASCII part', () => {
    expect(workspaceSlugFromPath('/home/dev/项目Demo')).toBe('demo');
  });

  it('collapses runs of special characters into one dash', () => {
    expect(workspaceSlugFromPath('/home/dev/a@@@b___c')).toBe('a-b-c');
  });

  it('falls back to "workspace" when nothing usable remains', () => {
    expect(workspaceSlugFromPath('/home/dev/@@@')).toBe('workspace');
    expect(workspaceSlugFromPath('/home/dev/项目')).toBe('workspace');
  });

  it('lowercases mixed case names', () => {
    expect(workspaceSlugFromPath('/home/dev/FooBar')).toBe('foobar');
  });

  it('trims leading and trailing dashes, including a trailing separator', () => {
    expect(workspaceSlugFromPath('/home/dev/-Repo-/')).toBe('repo');
  });
});

describe('normalizeWorkspacePath', () => {
  it('resolves existing paths through realpath', () => {
    const dir = makeDir('real');
    const dotted = path.join(scratchDir, '.', 'real', '..', 'real');
    expect(normalizeWorkspacePath(dotted)).toBe(dir);
  });

  it('falls back to path.resolve for paths that do not exist', () => {
    const missing = path.join(scratchDir, 'does', 'not', 'exist');
    expect(normalizeWorkspacePath(missing)).toBe(path.resolve(missing));
  });
});

describe('getOrCreateWorkspace — assignment and collisions', () => {
  it('assigns the basename slug and persists the entry', () => {
    const dir = makeDir('group-a', 'alpha');
    const ref = getOrCreateWorkspace(wayangDir, dir);

    expect(ref).toEqual({ path: dir, slug: 'alpha' });
    const registry = readRawRegistry();
    expect(registry.version).toBe(1);
    expect(registry.workspaces[dir]).toMatchObject({
      slug: 'alpha',
      path: dir,
      reserved: false,
    });
    expect(registry.workspaces[dir].firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(registry.workspaces[dir].lastSeenAt).toBe(registry.workspaces[dir].firstSeenAt);
  });

  it('suffixes the second same-named directory with -2, then -3', () => {
    const first = makeDir('group-a', 'repo');
    const second = makeDir('group-b', 'repo');
    const third = makeDir('group-c', 'repo');

    expect(getOrCreateWorkspace(wayangDir, first).slug).toBe('repo');
    expect(getOrCreateWorkspace(wayangDir, second).slug).toBe('repo-2');
    expect(getOrCreateWorkspace(wayangDir, third).slug).toBe('repo-3');
  });

  it('does not hand out a suffixed slug twice', () => {
    const first = makeDir('group-a', 'repo');
    const second = makeDir('group-b', 'repo');
    const literal = makeDir('group-c', 'repo-2');

    expect(getOrCreateWorkspace(wayangDir, first).slug).toBe('repo');
    expect(getOrCreateWorkspace(wayangDir, second).slug).toBe('repo-2');
    expect(getOrCreateWorkspace(wayangDir, literal).slug).toBe('repo-2-2');
  });

  it('is idempotent: the same path keeps its slug across calls', () => {
    const dir = makeDir('alpha');
    const first = getOrCreateWorkspace(wayangDir, dir);
    const second = getOrCreateWorkspace(wayangDir, dir);
    const dotted = getOrCreateWorkspace(wayangDir, path.join(dir, '.', ''));

    expect(second).toEqual(first);
    expect(dotted.slug).toBe(first.slug);
    expect(Object.keys(readRawRegistry().workspaces)).toEqual([dir]);
  });

  it('keeps the slug stable once a colliding directory is registered later', () => {
    const lone = makeDir('solo');
    const slug = getOrCreateWorkspace(wayangDir, lone).slug;
    const rival = makeDir('nested', 'solo');

    expect(getOrCreateWorkspace(wayangDir, rival).slug).toBe('solo-2');
    expect(getOrCreateWorkspace(wayangDir, lone).slug).toBe(slug);
  });

  it('updates lastSeenAt without touching firstSeenAt on a repeat visit', () => {
    const dir = makeDir('alpha');
    getOrCreateWorkspace(wayangDir, dir);
    const before = findWorkspace(wayangDir, dir)!;

    const later = new Date(Date.now() + 5_000).toISOString();
    const registry = readRawRegistry();
    registry.workspaces[dir].lastSeenAt = later;
    fs.writeFileSync(registryFilePath(wayangDir), JSON.stringify(registry));

    getOrCreateWorkspace(wayangDir, dir);
    const after = findWorkspace(wayangDir, dir)!;

    expect(after.firstSeenAt).toBe(before.firstSeenAt);
    expect(after.lastSeenAt >= before.lastSeenAt).toBe(true);
    expect(after.slug).toBe(before.slug);
  });
});

describe('persistence', () => {
  it('writes parseable JSON atomically, leaving no temp files behind', () => {
    const dir = makeDir('alpha');
    getOrCreateWorkspace(wayangDir, dir);
    getOrCreateWorkspace(wayangDir, makeDir('beta'));

    const raw = fs.readFileSync(registryFilePath(wayangDir), 'utf-8');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    expect(Object.keys(readRawRegistry().workspaces)).toHaveLength(2);

    const leftovers = fs.readdirSync(wayangDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('throws on a corrupt registry and keeps a .corrupt backup', () => {
    const dir = makeDir('alpha');
    fs.writeFileSync(registryFilePath(wayangDir), '{"version": 1, "workspaces": {');

    expect(() => getOrCreateWorkspace(wayangDir, dir)).toThrow(/corrupt/);
    expect(fs.existsSync(`${registryFilePath(wayangDir)}.corrupt`)).toBe(true);
    expect(fs.readFileSync(`${registryFilePath(wayangDir)}.corrupt`, 'utf-8')).toBe('{"version": 1, "workspaces": {');

    // Recovery: the bad file is gone, so a fresh empty registry is created.
    const ref = getOrCreateWorkspace(wayangDir, dir);
    expect(ref.slug).toBe('alpha');
    expect(Object.keys(readRawRegistry().workspaces)).toEqual([dir]);
  });

  it('treats a missing registry file as an empty registry', () => {
    expect(listWorkspaces(wayangDir)).toEqual([]);
    expect(findWorkspace(wayangDir, scratchDir)).toBeUndefined();
  });
});

describe('findWorkspace / listWorkspaces', () => {
  it('returns undefined for an unregistered path and does not write', () => {
    const dir = makeDir('alpha');
    expect(findWorkspace(wayangDir, dir)).toBeUndefined();
    expect(fs.existsSync(registryFilePath(wayangDir))).toBe(false);
  });

  it('returns the entry for a registered path', () => {
    const dir = makeDir('alpha');
    const ref = getOrCreateWorkspace(wayangDir, dir);
    expect(findWorkspace(wayangDir, dir)).toMatchObject({ slug: ref.slug, path: ref.path });
  });

  it('lists every registered workspace', () => {
    const a = makeDir('group-a', 'alpha');
    const b = makeDir('group-b', 'beta');
    getOrCreateWorkspace(wayangDir, a);
    getOrCreateWorkspace(wayangDir, b);

    const listed = listWorkspaces(wayangDir);
    expect(listed).toHaveLength(2);
    expect(listed.map(entry => entry.slug).sort()).toEqual(['alpha', 'beta']);
    expect(listed.map(entry => entry.path).sort()).toEqual([a, b].sort());
    expect(listed.every(entry => entry.reserved === false)).toBe(true);
  });
});

describe('resolveWorkspaceRef — degrade, never silent, never mutate on read', () => {
  it('returns a rule-based degraded slug when wayangDir is null and writes nothing', () => {
    const dir = makeDir('alpha');

    const ref = resolveWorkspaceRef(null, dir);

    expect(ref).toEqual({ path: dir, slug: 'alpha', degraded: true });
    // No wayangDir to write to, and no stray files in the scratch tree.
    expect(fs.readdirSync(scratchDir)).toEqual(['alpha']);
  });

  it('degrades on a corrupt registry without renaming it or reassigning a slug', () => {
    const dir = makeDir('alpha');
    const registryPath = registryFilePath(wayangDir);
    const corruptBytes = '{"version": 1, "workspaces": {';
    fs.writeFileSync(registryPath, corruptBytes);
    // Simulate an earlier quarantine: the read path must leave this evidence.
    const priorBackup = `${registryPath}.corrupt`;
    fs.writeFileSync(priorBackup, 'PREVIOUS-EVIDENCE');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Must not throw, and must not fall through to getOrCreateWorkspace's
      // write path (which would rename and reallocate a fresh slug).
      const ref = resolveWorkspaceRef(wayangDir, dir);

      expect(ref).toEqual({ path: dir, slug: 'alpha', degraded: true });
      // The corrupt document was not renamed and not overwritten.
      expect(fs.readFileSync(registryPath, 'utf-8')).toBe(corruptBytes);
      expect(fs.existsSync(priorBackup)).toBe(true);
      expect(fs.readFileSync(priorBackup, 'utf-8')).toBe('PREVIOUS-EVIDENCE');

      // The failure was logged once with an explicit backup/evidence path.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0][0]);
      expect(logged).toContain('corrupt');
      expect(logged).toContain(registryPath);
      expect(logged).toContain('backup path');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not rename or alter a registry with an unsupported version', () => {
    const dir = makeDir('alpha');
    const registryPath = registryFilePath(wayangDir);
    const v2Bytes = `${JSON.stringify({ version: 2, workspaces: { [dir]: { slug: 'alpha', path: dir } } }, null, 2)}\n`;
    fs.writeFileSync(registryPath, v2Bytes);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ref = resolveWorkspaceRef(wayangDir, dir);

      // Degrades rather than adopts the future document's entry.
      expect(ref).toEqual({ path: dir, slug: 'alpha', degraded: true });
      // In-place rejection: bytes untouched, no .corrupt side effect.
      expect(fs.readFileSync(registryPath, 'utf-8')).toBe(v2Bytes);
      expect(fs.existsSync(`${registryPath}.corrupt`)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns the registry slug (not the rule slug) for a registered path', () => {
    const first = makeDir('group-a', 'repo');
    const second = makeDir('group-b', 'repo');
    // Collision forces the registry slug away from the pure rule ("repo").
    expect(getOrCreateWorkspace(wayangDir, first).slug).toBe('repo');
    expect(getOrCreateWorkspace(wayangDir, second).slug).toBe('repo-2');

    const ref = resolveWorkspaceRef(wayangDir, second);

    expect(ref).toEqual({ path: second, slug: 'repo-2' });
    expect(ref.degraded).toBeUndefined();
    expect(workspaceSlugFromPath(second)).toBe('repo'); // proves registry won
  });
});
