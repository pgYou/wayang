import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileTool } from '@/services/tools/write-file';
import { readFileTool } from '@/services/tools/read-file';
import { defineTool } from '@/services/tools/common';
import { z } from 'zod';

/** Helper to call a defineTool's execute function. */
async function exec(toolLike: any, args: Record<string, unknown>): Promise<string> {
  const execute = toolLike.execute;
  return execute(args);
}

describe('write_file path validation', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('should write file within cwd', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'hello.txt', content: 'world' });
    expect(result).toContain('Written');
    expect(result).not.toContain('[ERROR]');
  });

  it('should write to nested path within cwd', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'sub/dir/file.txt', content: 'nested' });
    expect(result).toContain('Written');
    expect(result).not.toContain('[ERROR]');
  });

  it('should reject path traversal with ..', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: '../../../etc/passwd', content: 'hacked' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('escapes workspace');
  });

  it('should reject absolute path outside cwd', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: '/etc/passwd', content: 'hacked' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('escapes workspace');
  });

  it('should fallback to process.cwd() when no cwd provided', async () => {
    const tool = writeFileTool();
    // Relative path resolves within process.cwd(), should succeed
    const result = await exec(tool, { path: '__wayang_test_tmp__.txt', content: 'test' });
    expect(result).toContain('Written');
    // Cleanup
    const { unlinkSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    try { unlinkSync(resolve(process.cwd(), '__wayang_test_tmp__.txt')); } catch {}
  });

  it('should reject absolute path outside workspace when no cwd provided', async () => {
    const tool = writeFileTool();
    const result = await exec(tool, { path: '/tmp/__wayang_escape__.txt', content: 'hacked' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('escapes workspace');
  });

  it('should reject writing to an existing file', async () => {
    writeFileSync(join(cwd, 'existing.txt'), 'original', 'utf-8');
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'existing.txt', content: 'overwritten' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('already exists');
    expect(result).toContain('edit_file');
    // Verify file content unchanged
    expect(readFileSync(join(cwd, 'existing.txt'), 'utf-8')).toBe('original');
  });

  it('should create a new file when it does not exist', async () => {
    const tool = writeFileTool({ cwd });
    const result = await exec(tool, { path: 'new.txt', content: 'fresh' });
    expect(result).toContain('Written');
    expect(readFileSync(join(cwd, 'new.txt'), 'utf-8')).toBe('fresh');
  });
});

describe('read_file path validation', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wayang-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('should read file within cwd', async () => {
    writeFileSync(join(cwd, 'test.txt'), 'hello', 'utf-8');
    const tool = readFileTool({ cwd });
    const result = await exec(tool, { path: 'test.txt' });
    expect(result).toBe('hello');
  });

  it('should reject path traversal with ..', async () => {
    const tool = readFileTool({ cwd });
    const result = await exec(tool, { path: '../../../etc/passwd' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('escapes workspace');
  });

  it('should reject absolute path outside cwd', async () => {
    const tool = readFileTool({ cwd });
    const result = await exec(tool, { path: '/etc/shadow' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('escapes workspace');
  });
});
