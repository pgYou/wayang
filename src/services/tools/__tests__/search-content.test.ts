import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchContentTool } from '@/services/tools/search-content';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

describe('searchContentTool', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/a.ts'), 'const greeting = "hello";\nconst name = "world";\n', 'utf-8');
    writeFileSync(join(cwd, 'src/b.ts'), 'const farewell = "goodbye";\n', 'utf-8');
    writeFileSync(join(cwd, 'src/c.py'), 'def hello():\n    print("hello from python")\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('should find matching text in files', async () => {
    const tool = searchContentTool({ cwd });
    const result = await exec(tool, { query: 'hello' });
    expect(result).toContain('hello');
    expect(result).not.toContain('No matches');
  });

  it('should return no matches when nothing found', async () => {
    const tool = searchContentTool({ cwd });
    const result = await exec(tool, { query: 'nonexistent_pattern_xyz' });
    expect(result).toBe('No matches found');
  });

  it('should filter by include pattern', async () => {
    const tool = searchContentTool({ cwd });
    const result = await exec(tool, { query: 'hello', include: '*.py' });
    expect(result).toContain('c.py');
    expect(result).not.toContain('a.ts');
  });

  it('should search within a subdirectory', async () => {
    const tool = searchContentTool({ cwd });
    const result = await exec(tool, { query: 'hello', path: 'src' });
    expect(result).toContain('hello');
  });

});
