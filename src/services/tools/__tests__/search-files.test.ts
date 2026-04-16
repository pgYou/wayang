import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

  it('should reject path traversal in path parameter', async () => {
    const tool = searchFilesTool({ cwd });
    const result = await exec(tool, { pattern: '**/*.ts', path: '../../../etc' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('escapes workspace');
  });
});
