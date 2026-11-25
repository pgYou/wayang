import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '@/services/skills/registry';

/**
 * Build a temporary skills tree under a fresh tmp dir. Returns the root path
 * and a cleanup function. Directories are created on demand.
 */
function setupSkills(rootStructure: Record<string, string | string[]>): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'wayang-skills-'));
  for (const [dirPath, content] of Object.entries(rootStructure)) {
    const abs = join(root, dirPath);
    mkdirSync(abs, { recursive: true });
    if (Array.isArray(content)) {
      // treat as list of resource files to create (empty bodies)
      for (const f of content) {
        const filePath = join(abs, f);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'placeholder\n');
      }
    } else {
      writeFileSync(join(abs, 'SKILL.md'), content);
    }
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('SkillRegistry', () => {
  let setups: Array<() => void> = [];

  afterEach(() => {
    setups.forEach((fn) => fn());
    setups = [];
  });

  it('discovers skills with frontmatter descriptions', () => {
    const { root, cleanup } = setupSkills({
      'foo': '---\ndescription: Foo skill\n---\n\nFoo body instructions.',
      'bar': '---\ndescription: Bar skill\n---\n\nBar body.',
    });
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    const names = reg.list().map((s) => s.name).sort();
    expect(names).toEqual(['bar', 'foo']);
    expect(reg.get('foo')?.description).toBe('Foo skill');
  });

  it('skips skills missing the description frontmatter', () => {
    const { root, cleanup } = setupSkills({
      'good': '---\ndescription: Good\n---\n\nbody',
      'nodesc': '---\nname: nodesc\n---\n\nno description here',
    });
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    expect(reg.has('good')).toBe(true);
    expect(reg.has('nodesc')).toBe(false);
  });

  it('handles SKILL.md without any frontmatter', () => {
    const { root, cleanup } = setupSkills({
      'plain': 'No frontmatter at all, just body text.',
    });
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    expect(reg.has('plain')).toBe(false); // no description → skipped
  });

  it('loads body and lists resources on get()', () => {
    const { root, cleanup } = setupSkills({
      'pdf': ['extract.py', 'templates/tpl.txt'],
    });
    // Now write the SKILL.md with resources present.
    writeFileSync(
      join(root, 'pdf', 'SKILL.md'),
      '---\ndescription: PDF extraction\n---\n\nRun extract.py to pull text.',
    );
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    const content = reg.get('pdf');
    expect(content).toBeDefined();
    expect(content!.content).toContain('Run extract.py');
    expect(content!.resources).toContain('extract.py');
    expect(content!.resources).toContain('templates/tpl.txt');
    expect(content!.resources).not.toContain('SKILL.md');
  });

  it('caches get() results (same object reference)', () => {
    const { root, cleanup } = setupSkills({
      'cached': '---\ndescription: Cached\n---\n\nbody',
    });
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    const a = reg.get('cached');
    const b = reg.get('cached');
    expect(a).toBe(b); // cached reference equality
  });

  it('returns undefined for unknown skill', () => {
    const reg = new SkillRegistry([]);
    expect(reg.get('nope')).toBeUndefined();
  });

  it('later directory overrides earlier on name conflict', () => {
    const globalSkills = setupSkills({
      'shared': '---\ndescription: Global version\n---\n\nglobal body',
    });
    const projectSkills = setupSkills({
      'shared': '---\ndescription: Project version\n---\n\nproject body',
    });
    setups.push(globalSkills.cleanup, projectSkills.cleanup);

    // Order: lowest priority first. Project overrides global.
    const reg = new SkillRegistry([globalSkills.root, projectSkills.root]);
    expect(reg.get('shared')?.description).toBe('Project version');
    expect(reg.get('shared')?.content).toContain('project body');
  });

  it('skips hidden dirs and node_modules', () => {
    const { root, cleanup } = setupSkills({
      'real': '---\ndescription: Real\n---\n\nbody',
      '.hidden': '---\ndescription: Hidden\n---\n\nbody',
      'node_modules/pkg': '---\ndescription: Pkg\n---\n\nbody',
    });
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    expect(reg.has('real')).toBe(true);
    expect(reg.has('.hidden')).toBe(false);
    expect(reg.has('pkg')).toBe(false);
  });

  it('tolerates non-existent scan directories', () => {
    const reg = new SkillRegistry(['/does/not/exist/wayang-test']);
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it('handles quoted frontmatter values', () => {
    const { root, cleanup } = setupSkills({
      'quoted': '---\ndescription: "A quoted desc"\n---\n\nbody',
    });
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    expect(reg.get('quoted')?.description).toBe('A quoted desc');
  });

  it('parses multi-line / list frontmatter without crashing', () => {
    const { root, cleanup } = setupSkills({
      'multi': '---\ndescription: Has list\ntags:\n  - a\n  - b\n---\n\nbody',
    });
    setups.push(cleanup);

    const reg = new SkillRegistry([root]);
    expect(reg.get('multi')?.description).toBe('Has list');
  });
});
