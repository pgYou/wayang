import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadControllerRules,
  CONTROLLER_RULES_MAX_BYTES,
} from '@/services/agents/prompts/controller-rules';
import { buildControllerSystemPrompt } from '@/services/agents/prompts/controller-prompt';
import { SkillRegistry } from '@/services/skills/registry';
import { createMockCtx } from '@/__tests__/helpers';

/** Create a self-contained temp directory tree, removed via the returned cleanup. */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wayang-ctrl-rules-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Create a nested dir under a temp root (home / cwd siblings). */
function makeTree(): { root: string; home: string; cwd: string; cleanup: () => void } {
  const { dir, cleanup } = makeTempDir();
  const home = join(dir, 'home');
  const cwd = join(dir, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root: dir, home, cwd, cleanup };
}

/**
 * Canonical spelling of a path, mirroring what `loadControllerRules` reports
 * (it labels each file with its `realpathSync` result) WITHOUT importing the
 * code under test.
 *
 * `mkdtempSync(join(tmpdir(), …))` hands back the platform spelling of the temp
 * dir, which on macOS is the un-resolved `/var/folders/…` — while the loader
 * reports `/private/var/folders/…`. Both name the same file; only the spelling
 * differs. Resolve the deepest EXISTING ancestor with `realpathSync` and glue
 * the missing tail back on:
 *
 *   /tmp/link/new_key   (/tmp/link -> /home/u)  =>  /home/u/new_key
 */
function canonical(p: string): string {
  const lexical = resolve(p);
  const peeled: string[] = [];
  let candidate = lexical;

  for (let depth = 0; depth <= 32; depth += 1) {
    try {
      const resolved = realpathSync(candidate);
      return peeled.length === 0 ? resolved : resolve(join(resolved, ...peeled));
    } catch {
      // Missing or unreadable — peel one segment and retry on the parent.
    }
    const parent = dirname(candidate);
    if (parent === candidate) break; // hit the filesystem root
    peeled.unshift(basename(candidate));
    candidate = parent;
  }

  return lexical;
}

describe('loadControllerRules', () => {
  it('loads only the home AGENTS.md when cwd has none', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      writeFileSync(join(home, 'AGENTS.md'), 'HOME RULE: answer in Chinese.');
      const rules = loadControllerRules({ userHome: home, cwd });

      expect(rules).toContain('HOME RULE: answer in Chinese.');
      expect(rules).toContain(`from ${canonical(join(home, 'AGENTS.md'))}`);
      expect(rules).not.toContain(join(cwd, 'AGENTS.md'));
    } finally {
      cleanup();
    }
  });

  it('loads only the cwd AGENTS.md when home has none', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      writeFileSync(join(cwd, 'AGENTS.md'), 'CWD RULE: run npm run lint.');
      const rules = loadControllerRules({ userHome: home, cwd });

      expect(rules).toContain('CWD RULE: run npm run lint.');
      expect(rules).toContain(`from ${canonical(join(cwd, 'AGENTS.md'))}`);
      expect(rules).not.toContain(join(home, 'AGENTS.md'));
    } finally {
      cleanup();
    }
  });

  it('returns an empty string when neither file exists', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      expect(loadControllerRules({ userHome: home, cwd })).toBe('');
    } finally {
      cleanup();
    }
  });

  it('puts home first and cwd second, and states that cwd wins on conflict', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      writeFileSync(join(home, 'AGENTS.md'), 'HOME RULE: baseline.');
      writeFileSync(join(cwd, 'AGENTS.md'), 'CWD RULE: supplement.');

      const rules = loadControllerRules({ userHome: home, cwd });
      const homeAt = rules.indexOf(`from ${canonical(join(home, 'AGENTS.md'))}`);
      const cwdAt = rules.indexOf(`from ${canonical(join(cwd, 'AGENTS.md'))}`);

      expect(homeAt).toBeGreaterThanOrEqual(0);
      expect(cwdAt).toBeGreaterThan(homeAt);
      expect(rules.indexOf('HOME RULE: baseline.')).toBeLessThan(rules.indexOf('CWD RULE: supplement.'));
      // Precedence is spelled out in prose, not only implied by order.
      expect(rules).toMatch(/working directory file comes second and takes precedence/i);
    } finally {
      cleanup();
    }
  });

  it('loads the file once when cwd and home resolve to the same file', () => {
    const { home, cleanup } = makeTree();
    try {
      writeFileSync(join(home, 'AGENTS.md'), 'SHARED RULE: appears once.');
      // Starting wayang inside the home directory: same dir, same file.
      const rules = loadControllerRules({ userHome: home, cwd: home });

      const occurrences = rules.split(`from ${canonical(join(home, 'AGENTS.md'))}`).length - 1;
      expect(occurrences).toBe(1);
      expect(rules.split('SHARED RULE: appears once.').length - 1).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('loads the file once when cwd reaches the home file through a symlink', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      const link = join(cwd, 'AGENTS.md');
      writeFileSync(join(home, 'AGENTS.md'), 'SHARED RULE: symlinked once.');
      symlinkSync(join(home, 'AGENTS.md'), link);
      const rules = loadControllerRules({ userHome: home, cwd });

      expect(rules.split('SHARED RULE: symlinked once.').length - 1).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('keeps the first file whole and truncates the last one over the byte cap', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      const first = `HOME HEAD ${'a'.repeat(100)}`;
      const second = `${'b'.repeat(200)} SECOND TAIL MARKER`;
      writeFileSync(join(home, 'AGENTS.md'), first);
      writeFileSync(join(cwd, 'AGENTS.md'), second);

      const maxBytes = 150;
      const rules = loadControllerRules({ userHome: home, cwd, maxBytes });

      // First file survives untouched, second one is cut.
      expect(rules).toContain(first);
      expect(rules).not.toContain('SECOND TAIL MARKER');
      expect(rules).toContain(`from ${canonical(join(cwd, 'AGENTS.md'))}`);
      expect(rules).toContain('...truncated at 150 bytes');
      // Bodies stay within the cap (headings/marker are outside the budget).
      const bodyBytes = (first.length + Math.max(0, maxBytes - first.length));
      expect(bodyBytes).toBeLessThanOrEqual(maxBytes);
    } finally {
      cleanup();
    }
  });

  it('never splits a multi-byte character at the truncation boundary', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      // 3-byte-per-char CJK content: a 7-byte leftover budget lands mid-character.
      const homeText = '基线规则：始终中文回答。';
      writeFileSync(join(home, 'AGENTS.md'), homeText);
      writeFileSync(join(cwd, 'AGENTS.md'), '补充规则：'.repeat(50));

      const maxBytes = Buffer.byteLength(homeText, 'utf8') + 7;
      const rules = loadControllerRules({ userHome: home, cwd, maxBytes });

      expect(rules).toContain(homeText);
      expect(rules).not.toContain('\uFFFD');

      const heading = `## Project rules (from ${canonical(join(cwd, 'AGENTS.md'))})`;
      const cwdBody = rules
        .slice(rules.indexOf(heading) + heading.length, rules.indexOf('...truncated at'))
        .trim();
      expect(Buffer.byteLength(cwdBody, 'utf8')).toBeLessThanOrEqual(7);
      expect(cwdBody).toBe('补充'); // whole characters only, no half sequence
      expect(rules).toContain(`...truncated at ${maxBytes} bytes`);
    } finally {
      cleanup();
    }
  });

  it('truncates a single oversized file and reports the cap', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      writeFileSync(join(home, 'AGENTS.md'), 'x'.repeat(500));
      writeFileSync(join(cwd, 'AGENTS.md'), 'y'.repeat(500));
      // Cap smaller than either file: only the first is loaded, cut short.
      const rules = loadControllerRules({ userHome: home, cwd, maxBytes: 100 });

      expect(rules).toContain(`from ${canonical(join(home, 'AGENTS.md'))}`);
      expect(rules).not.toContain(`from ${canonical(join(cwd, 'AGENTS.md'))}`);
      expect(rules).toContain('x'.repeat(100));
      expect(rules).not.toContain('x'.repeat(101));
      expect(rules).toContain('...truncated at 100 bytes');
    } finally {
      cleanup();
    }
  });

  it('skips empty and whitespace-only files', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      writeFileSync(join(home, 'AGENTS.md'), '   \n\n\t\n');
      writeFileSync(join(cwd, 'AGENTS.md'), 'CWD RULE: only this one counts.');

      const rules = loadControllerRules({ userHome: home, cwd });
      expect(rules).not.toContain(join(home, 'AGENTS.md'));
      expect(rules).toContain('CWD RULE: only this one counts.');
    } finally {
      cleanup();
    }
  });

  it('treats an unreadable rules file as absent instead of failing', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      const path = join(home, 'AGENTS.md');
      writeFileSync(path, 'HOME RULE: unreadable.');
      chmodSync(path, 0o000);
      // Running as root ignores mode bits — verify the read really fails.
      let enforced = false;
      try {
        readFileSync(path);
      } catch {
        enforced = true;
      }
      writeFileSync(join(cwd, 'AGENTS.md'), 'CWD RULE: still loaded.');

      const rules = loadControllerRules({ userHome: home, cwd });
      expect(rules).toContain('CWD RULE: still loaded.');
      if (enforced) expect(rules).not.toContain('HOME RULE: unreadable.');
    } finally {
      chmodSync(join(home, 'AGENTS.md'), 0o644);
      cleanup();
    }
  });

  it('treats a non-file AGENTS.md (directory / broken path) as absent', () => {
    const { home, cwd, cleanup } = makeTree();
    try {
      mkdirSync(join(home, 'AGENTS.md'));
      // ENOTDIR: userHome is a regular file, so <userHome>/AGENTS.md cannot exist.
      writeFileSync(join(cwd, 'AGENTS.md'), 'CWD RULE: survives a broken home path.');

      expect(() => loadControllerRules({ userHome: home, cwd })).not.toThrow();
      const rules = loadControllerRules({ userHome: join(home, 'AGENTS.md'), cwd });
      expect(rules).toContain('CWD RULE: survives a broken home path.');
    } finally {
      cleanup();
    }
  });

  it('defaults the cap to 32KB', () => {
    expect(CONTROLLER_RULES_MAX_BYTES).toBe(32 * 1024);

    const { home, cwd, cleanup } = makeTree();
    try {
      writeFileSync(join(home, 'AGENTS.md'), 'h'.repeat(20_000));
      writeFileSync(join(cwd, 'AGENTS.md'), 'c'.repeat(20_000));
      const rules = loadControllerRules({ userHome: home, cwd });

      // 40k of content exceeds 32KB: home complete (20k), cwd cut to the rest.
      expect(rules).toContain('h'.repeat(20_000));
      expect(rules).toContain('c'.repeat(32 * 1024 - 20_000));
      expect(rules).not.toContain('c'.repeat(32 * 1024 - 20_000 + 1));
      expect(rules).toContain('...truncated at 32768 bytes');
    } finally {
      cleanup();
    }
  });
});

describe('buildControllerSystemPrompt with rules', () => {
  it('omits the rules section when no rules file was found', () => {
    const skills = new SkillRegistry([], createMockCtx().logger);
    const rules = loadControllerRules({ userHome: '/nonexistent-home', cwd: '/nonexistent-cwd' });
    const prompt = buildControllerSystemPrompt(createMockCtx(), skills, { rules });

    // No rules section when nothing was found — prompt unchanged.
    expect(rules).toBe('');
    expect(prompt).not.toContain('# Project rules');
  });

  it('includes the rendered rules block when provided', () => {
    const skills = new SkillRegistry([], createMockCtx().logger);
    const rules = '# Project rules\n\nRules loaded at startup.\n\n## Project rules (from /x/AGENTS.md)\n\nRULE BODY';
    const prompt = buildControllerSystemPrompt(createMockCtx(), skills, { rules });

    expect(prompt).toContain('RULE BODY');
    expect(prompt.indexOf('RULE BODY')).toBeGreaterThan(prompt.indexOf('# Environment'));
  });
});
