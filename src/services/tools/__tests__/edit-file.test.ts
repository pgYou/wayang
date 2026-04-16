import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editFileTool } from '@/services/tools/edit-file';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

describe('editFileTool', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('should replace a unique string in a file', async () => {
    writeFileSync(join(cwd, 'test.txt'), 'hello world', 'utf-8');
    const tool = editFileTool({ cwd });
    const result = await exec(tool, {
      path: 'test.txt',
      old_string: 'hello',
      new_string: 'goodbye',
    });
    expect(result).toContain('Replaced');
    expect(readFileSync(join(cwd, 'test.txt'), 'utf-8')).toBe('goodbye world');
  });

  it('should reject when old_string is not found', async () => {
    writeFileSync(join(cwd, 'test.txt'), 'hello world', 'utf-8');
    const tool = editFileTool({ cwd });
    const result = await exec(tool, {
      path: 'test.txt',
      old_string: 'not_here',
      new_string: 'replacement',
    });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('not found');
  });

  it('should reject when old_string appears multiple times', async () => {
    writeFileSync(join(cwd, 'test.txt'), 'ha ha ha', 'utf-8');
    const tool = editFileTool({ cwd });
    const result = await exec(tool, {
      path: 'test.txt',
      old_string: 'ha',
      new_string: 'ho',
    });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('found 3 times');
    expect(result).toContain('more surrounding context');
  });

  it('should reject when file does not exist', async () => {
    const tool = editFileTool({ cwd });
    const result = await exec(tool, {
      path: 'missing.txt',
      old_string: 'x',
      new_string: 'y',
    });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('File not found');
  });

  it('should reject path traversal', async () => {
    const tool = editFileTool({ cwd });
    const result = await exec(tool, {
      path: '../../../etc/passwd',
      old_string: 'x',
      new_string: 'y',
    });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('escapes workspace');
  });

  it('should preserve content outside the replaced region', async () => {
    writeFileSync(join(cwd, 'code.ts'), 'line1\nline2\nline3', 'utf-8');
    const tool = editFileTool({ cwd });
    await exec(tool, {
      path: 'code.ts',
      old_string: 'line2',
      new_string: 'LINE_TWO',
    });
    const content = readFileSync(join(cwd, 'code.ts'), 'utf-8');
    expect(content).toBe('line1\nLINE_TWO\nline3');
  });
});
