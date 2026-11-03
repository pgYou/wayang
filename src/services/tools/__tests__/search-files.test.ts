import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchFilesTool } from '@/services/tools/search-files';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

describe('searchFilesTool', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    // Create test file structure
    mkdirSync(join(cwd, 'src'), { recursive: true });
    mkdirSync(join(cwd, 'src/utils'), { recursive: true });
    writeFileSync(join(cwd, 'src/index.ts'), 'export {}', 'utf-8');
    writeFileSync(join(cwd, 'src/utils.ts'), 'export const x = 1', 'utf-8');
    writeFileSync(join(cwd, 'src/utils/helper.ts'), 'export const y = 2', 'utf-8');
    writeFileSync(join(cwd, 'README.md'), '# Test', 'utf-8');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('should find files matching a glob pattern', async () => {
    const tool = searchFilesTool({ cwd });
    const result = await exec(tool, { pattern: '**/*.ts' });
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/utils.ts');
    expect(result).toContain('src/utils/helper.ts');
    expect(result).not.toContain('README.md');
  });

  it('should find files with a specific name pattern', async () => {
    const tool = searchFilesTool({ cwd });
    const result = await exec(tool, { pattern: '**/*.md' });
    expect(result).toContain('README.md');
    expect(result).not.toContain('.ts');
  });

  it('should search within a subdirectory using path parameter', async () => {
    const tool = searchFilesTool({ cwd });
    const result = await exec(tool, { pattern: '**/*.ts', path: 'src/utils' });
    expect(result).toContain('helper.ts');
    expect(result).not.toContain('index.ts');
  });

  it('should return no match message for empty results', async () => {
    const tool = searchFilesTool({ cwd });
    const result = await exec(tool, { pattern: '**/*.xyz' });
    expect(result).toBe('No files matched the pattern');
  });

});

/**
 * The read gate. These cases pass `homeDir`, which switches on
 * `decideAccess({ access: 'read', ... })`: reads must stay inside home, and
 * the denylist (~/.ssh, ~/.wayang, …) wins over "inside home".
 */
describe('searchFilesTool read boundary', () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    // Layout: home/{project/src,a.ts ; documents/note.md ; .ssh/id_rsa ; .wayang/}
    home = realpathSync(mkdtempSync(join(tmpdir(), 'wayang-search-home-')));
    workspace = join(home, 'project');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export {}', 'utf-8');
    mkdirSync(join(home, 'documents'), { recursive: true });
    writeFileSync(join(home, 'documents', 'note.md'), '# hi', 'utf-8');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret', 'utf-8');
    mkdirSync(join(home, '.wayang'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('allows an ordinary directory inside home', async () => {
    const tool = searchFilesTool({ cwd: workspace, homeDir: home });
    const result = await exec(tool, { pattern: '**/*.ts' });
    expect(result).toContain('src/a.ts');
  });

  it('allows reading a sibling directory inside home (outside the workspace)', async () => {
    const tool = searchFilesTool({ cwd: workspace, homeDir: home });
    const result = await exec(tool, { pattern: '**/*.md', path: join(home, 'documents') });
    expect(result).toContain('note.md');
  });

  it('denies a denylisted path (~/.ssh) without reading any files', async () => {
    const tool = searchFilesTool({ cwd: workspace, homeDir: home });
    const result = await exec(tool, { pattern: '**/*', path: join(home, '.ssh') });
    // Denylist wording, and no leaked file listing from the protected dir.
    expect(result).toContain('denylist');
    expect(result).not.toContain('id_rsa');
  });

  it('denies the wayang data dir (~/.wayang) via the denylist', async () => {
    const tool = searchFilesTool({ cwd: workspace, homeDir: home });
    const result = await exec(tool, { pattern: '**/*', path: join(home, '.wayang') });
    expect(result).toContain('denylist');
  });

  it('denies a path outside home with a message distinct from the denylist', async () => {
    const tool = searchFilesTool({ cwd: workspace, homeDir: home });
    const result = await exec(tool, { pattern: '**/*', path: '/etc' });
    expect(result).toContain('outside the home boundary');
    expect(result).not.toContain('denylist');
  });

  it('denies a symlink whose ancestor resolves into ~/.ssh (target leaf may not exist)', async () => {
    // home/innocent -> home/.ssh ; requesting home/innocent/<missing> must
    // canonicalize via the existing ancestor and still hit the denylist.
    symlinkSync(join(home, '.ssh'), join(home, 'innocent'));
    const tool = searchFilesTool({ cwd: workspace, homeDir: home });
    const result = await exec(tool, {
      pattern: '**/*',
      path: join(home, 'innocent', 'nonexistent_key'),
    });
    expect(result).toContain('denylist');
  });

  it('resolves a relative path against the workspace and allows it inside home', async () => {
    const tool = searchFilesTool({ cwd: workspace, homeDir: home });
    const result = await exec(tool, { pattern: '**/*.ts', path: 'src' });
    expect(result).toContain('a.ts');
  });
});
